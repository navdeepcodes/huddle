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

    /**
     * Phase 40 §4: a reclaim must not silently demote a runtime that is
     * genuinely still running. This used to `tx.set` an unconditional
     * reset - state:"starting", port:null, previewUrl:null - on EVERY
     * successful claim, including the same tab re-claiming after a
     * heartbeat gap or a React effect re-running. The live consequence
     * was a working preview being thrown away and re-derived for no
     * reason, and it is a strong candidate for the "stuck at starting"
     * symptom, entirely independent of what the WebContainer was doing.
     *
     * The rule is now explicit:
     *   - SAME tab, already running -> preserve state/port/previewUrl.
     *     Nothing about the runtime changed; only ownership was
     *     re-asserted, so there is no new attempt and the generation
     *     does NOT advance.
     *   - anything else (no doc, a different tab, or a non-running
     *     state) -> a genuinely new attempt begins: reset, and advance
     *     the generation so every in-flight worker from the previous
     *     attempt is invalidated (see reportRuntimeHostState).
     */
    const isSameTabReclaimOfLiveRuntime =
      existing !== undefined && existing.ownerTabId === tabId && existing.state === "running";

    if (isSameTabReclaimOfLiveRuntime) {
      const preserved: RuntimeHost = { ...existing, heartbeatAt: now, updatedAt: now };
      tx.set(ref, preserved);
      return preserved;
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
      generation: (existing?.generation ?? 0) + 1,
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

/**
 * Phase 40 §1/§2: THE single authority for runtime state transitions.
 * Every readiness worker (startDevServer, watchForRecovery,
 * continueWatchingForReadiness, runBackgroundWithReadiness) reports
 * through here and nowhere else - they produce evidence, this decides
 * whether that evidence still applies.
 *
 * Two guards, both required:
 *   - OWNERSHIP: the reporting tab must still own the host doc (this
 *     existed already).
 *   - GENERATION: the report must belong to the CURRENT runtime attempt.
 *     A worker captures `generation` when it starts and passes it back;
 *     if the doc has since moved to a newer generation (a reclaim, a
 *     fresh boot), the report is from a superseded attempt and is
 *     dropped. This is what makes "old curl result / old crash watcher /
 *     old timeout overwrites newer state" structurally impossible rather
 *     than merely unlikely - previously the only protection was a
 *     single ad-hoc port-membership check in one of the four workers.
 *
 * Transactional so the read-then-write cannot interleave with a
 * concurrent claim - the previous plain get-then-update could pass its
 * ownership check against data that a reclaim invalidated microseconds
 * later.
 *
 * Omitting `generation` (legacy callers, and docs written before the
 * field existed) preserves the old behavior: ownership-only checking.
 */
export async function reportRuntimeHostState(
  sessionId: string,
  tabId: string,
  /**
   * Phase 40 §3: null means "report the extras only, leave state
   * untouched" - used by the preview-URL writer, which has no readiness
   * evidence of its own and must never move the state machine.
   */
  state: RuntimeState | null,
  extra?: {
    port?: number | null;
    previewUrl?: string | null;
    errorMessage?: string | null;
    startupTelemetry?: RuntimeStartupTelemetry;
    generation?: number;
  }
): Promise<boolean> {
  const ref = adminDb.collection("runtimeHost").doc(sessionId);

  return adminDb.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const existing = snap.data() as RuntimeHost | undefined;
    if (!existing || existing.ownerTabId !== tabId) return false;

    if (extra?.generation !== undefined && extra.generation !== (existing.generation ?? 0)) {
      return false; // a superseded attempt's worker - discard, never overwrite
    }

    tx.update(ref, {
      ...(state !== null ? { state } : {}),
      updatedAt: Date.now(),
      ...(extra?.port !== undefined ? { port: extra.port } : {}),
      ...(extra?.previewUrl !== undefined ? { previewUrl: extra.previewUrl } : {}),
      ...(extra?.errorMessage !== undefined ? { errorMessage: extra.errorMessage } : {}),
      ...(extra?.startupTelemetry !== undefined ? { startupTelemetry: extra.startupTelemetry } : {}),
    });
    return true;
  });
}
