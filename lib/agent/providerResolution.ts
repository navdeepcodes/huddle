import "server-only";

import { resolveCredential } from "@/lib/credentials/credentialStore";
import { createNemotronProvider } from "@/lib/agent/providers/nemotron";
import { deepSeekAgentProvider } from "@/lib/agent/providers/deepseek";

import type { AgentModelProvider } from "@/lib/agent/provider";

export type NemotronCredentialSource = "personal" | "platform" | "unavailable";

export interface ResolvedProviders {
  providers: AgentModelProvider[];
  nemotronSource: NemotronCredentialSource;
}

/**
 * Phase 29: the ONE place that decides whose Nemotron credential a
 * turn uses - resolveCredential(uid, "nemotron") is looked up for the
 * REQUESTING user's own uid and no one else's; there is no other
 * uid this function ever has access to, structurally, since it's
 * called with exactly one uid at a time from runAgentTurn. Falls back
 * to NVIDIA_API_KEY (the platform-owned credential, unchanged since
 * before per-user keys existed) only when that specific user has no
 * personal key configured - an explicit, documented product decision,
 * not an invented one: it's what keeps every session that predates
 * this feature (and every user who simply hasn't visited /settings
 * yet) working exactly as before. Never reads or falls back to
 * ANOTHER user's stored credential under any circumstance - there is
 * no code path that could, since this function only ever sees the one
 * uid it was called with.
 *
 * DeepSeek stays a shared, platform-level fallback provider,
 * unchanged - out of this phase's per-user-credential scope (only
 * Nemotron is user-configurable).
 */
export async function resolveAgentProviders(uid: string): Promise<ResolvedProviders> {
  const personalKey = await resolveCredential(uid, "nemotron");
  const platformKey = process.env.NVIDIA_API_KEY ?? null;

  const nemotronKey = personalKey ?? platformKey;
  const nemotronSource: NemotronCredentialSource = personalKey ? "personal" : platformKey ? "platform" : "unavailable";

  const providers: AgentModelProvider[] = [];
  if (nemotronKey) providers.push(createNemotronProvider(nemotronKey));
  providers.push(deepSeekAgentProvider);

  return { providers, nemotronSource };
}
