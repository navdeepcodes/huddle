import "server-only";

import { adminDb } from "@/lib/firebase/admin";

import type { RuntimeHost, RuntimeState, RuntimeStartupTelemetry } from "@/types/session";

/** Two missed heartbeats (client beats every 8s) before a host is considered stale and reclaimable. */
export const RUNTIME_HOST_STALE_MS = 20_000;

export class RuntimeHostClaimError extends Error {}

/**
 * One host per session, deterministic election: a fresh heartbeat from
 * a DIFFERENT tab blocks a new claim; anything else (no doc yet, same
 * tab reclaiming, or a stale heartbeat) succeeds. Mirrors the proven
 * apostle runtime-host election shape, sized down to what a single
 * elected browser tab needs for v1 (no multi-viewer secrets doc - the
 * preview URL isn't sensitive here since there's no bearer-auth
 * concern to hide it from).
 */
export async function claimRuntimeHost(sessionId: string, tabId: string): Promise<RuntimeHost> {
  const ref = adminDb.collection("runtimeHost").doc(sessionId);

  return adminDb.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const existing = snap.data() as RuntimeHost | undefined;
    const now = Date.now();

    if (
      existing &&
      existing.ownerTabId &&
      existing.ownerTabId !== tabId &&
      existing.heartbeatAt &&
      now - existing.heartbeatAt < RUNTIME_HOST_STALE_MS
    ) {
      throw new RuntimeHostClaimError(
        "Another browser tab is already hosting this session's runtime."
      );
    }

    const host: RuntimeHost = {
      sessionId,
      state: "starting",
      port: null,
      previewUrl: null,
      ownerTabId: tabId,
      heartbeatAt: now,
      errorMessage: null,
      updatedAt: now,
    };

    tx.set(ref, host);
    return host;
  });
}

export async function heartbeatRuntimeHost(sessionId: string, tabId: string): Promise<boolean> {
  const ref = adminDb.collection("runtimeHost").doc(sessionId);
  const snap = await ref.get();
  const existing = snap.data() as RuntimeHost | undefined;
  if (!existing || existing.ownerTabId !== tabId) return false;

  await ref.update({ heartbeatAt: Date.now() });
  return true;
}

export async function reportRuntimeHostState(
  sessionId: string,
  tabId: string,
  state: RuntimeState,
  extra?: {
    port?: number | null;
    previewUrl?: string | null;
    errorMessage?: string | null;
    startupTelemetry?: RuntimeStartupTelemetry;
  }
): Promise<boolean> {
  const ref = adminDb.collection("runtimeHost").doc(sessionId);
  const snap = await ref.get();
  const existing = snap.data() as RuntimeHost | undefined;
  if (!existing || existing.ownerTabId !== tabId) return false;

  await ref.update({
    state,
    updatedAt: Date.now(),
    ...(extra?.port !== undefined ? { port: extra.port } : {}),
    ...(extra?.previewUrl !== undefined ? { previewUrl: extra.previewUrl } : {}),
    ...(extra?.errorMessage !== undefined ? { errorMessage: extra.errorMessage } : {}),
    ...(extra?.startupTelemetry !== undefined ? { startupTelemetry: extra.startupTelemetry } : {}),
  });
  return true;
}
