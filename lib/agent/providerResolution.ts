import "server-only";

import { resolveCredential } from "@/lib/credentials/credentialStore";
import { createNemotronProvider } from "@/lib/agent/providers/nemotron";

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
 * Nemotron is the ONLY registered provider (2026-08-28). DeepSeek used
 * to be appended here unconditionally as a platform-level fallback -
 * a leftover from when it was the PRIMARY provider, before Nemotron
 * replaced it. Removed after a live run proved the fallback could
 * never actually succeed: Nemotron runs with thinking enabled, and
 * once it has produced reasoning, DeepSeek rejects the very next
 * request with `400 The reasoning_content in the thinking mode must be
 * passed back to the API` (Huddle doesn't carry reasoning_content
 * across providers - see provider.ts's own note on cross-provider
 * message incompatibility). So the fallback was pure downside: it
 * could only ever fire after Nemotron had already failed, was
 * guaranteed to fail itself, and replaced Nemotron's real error with a
 * confusing DeepSeek one (live-observed: a turn that lost Nemotron to
 * timeouts reported "DeepSeek agent step failed: 400 ..." instead).
 *
 * With one provider registered, generateStepWithRecovery still gives
 * Nemotron its full bounded retry budget - the only thing removed was
 * the guaranteed-failing extra hop afterward.
 * lib/agent/providers/deepseek.ts is deliberately KEPT on disk, simply
 * unregistered, so re-enabling it later is a one-line change once the
 * reasoning_content round-trip is genuinely handled.
 *
 * Phase 41 (2026-08-30): a Gemini-backed fallback was designed and
 * implemented (lib/agent/providers/geminiCoding.ts) but paused before
 * registration when Phase 41A asked to benchmark alternate NVIDIA
 * models first. That benchmark (Phase 41A) measured Nemotron Lightning
 * (nvidia/nemotron-3.5-lightning-30b-a3b) against Ultra directly: 9/9
 * successful calls, 0 timeouts, 0 malformed tool calls, sub-2s trivial
 * latency, vs. Ultra's repeated 500s/timeouts/404s/truncation. A wider
 * bake-off against other NVIDIA free-endpoint models (Kimi K3, DeepSeek
 * V4 Pro, MiniMax M3, GPT-OSS-120B, Codestral-22B) found none of them
 * currently usable (3 unresponsive past 100s, one returned empty
 * content, one 404'd as not-entitled on this account) - so Lightning,
 * not Gemini, is registered here as Phase 41C's fallback.
 * geminiCoding.ts remains on disk, unregistered, same precedent as
 * deepseek.ts, in case it's revisited later.
 *
 * Lightning shares Ultra's exact NVIDIA endpoint and credential (same
 * account, same NVIDIA_API_KEY) - no second credential type needed.
 * It gets a SMALLER attempt budget than Ultra (2, not 4) per Phase
 * 41C's explicit "do not increase retry counts" - see nemotron.ts's
 * `maxAttempts` option and provider.ts's own doc comment. Fallback only
 * activates for genuine provider-side failures (5xx, timeout, malformed
 * response, rate-limit) that exhaust Ultra's own budget first -
 * loop.ts's per-turn commit logic is what makes Lightning "own" the
 * rest of a turn once it takes over, so Ultra is never silently retried
 * again after a switch (see loop.ts's committedProviderIndex).
 */
export async function resolveAgentProviders(uid: string): Promise<ResolvedProviders> {
  const personalKey = await resolveCredential(uid, "nemotron");
  const platformKey = process.env.NVIDIA_API_KEY ?? null;

  const nemotronKey = personalKey ?? platformKey;
  const nemotronSource: NemotronCredentialSource = personalKey ? "personal" : platformKey ? "platform" : "unavailable";

  const providers: AgentModelProvider[] = [];
  if (nemotronKey) {
    providers.push(createNemotronProvider(nemotronKey));
    providers.push(
      createNemotronProvider(nemotronKey, {
        model: process.env.NVIDIA_LIGHTNING_MODEL || "nvidia/nemotron-3.5-lightning-30b-a3b",
        id: "nvidia-lightning",
        displayName: "NVIDIA Nemotron Lightning (fallback)",
        maxAttempts: 2,
      })
    );
  }

  return { providers, nemotronSource };
}
