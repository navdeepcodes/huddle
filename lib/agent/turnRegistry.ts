import "server-only";

import { adminDb } from "@/lib/firebase/admin";

import type { TurnClaim, TurnTerminationReason } from "@/types/session";

/**
 * In-memory map of the one AbortController per currently-running turn,
 * keyed by sessionId - what makes the turn server-owned and decoupled
 * from the originating HTTP request: POST /turn starts the loop
 * detached (doesn't await it), and POST /turn/cancel looks it up here
 * to abort it. A dev-server or serverless-instance restart loses this
 * map - this was an accepted tradeoff for v1, but Phase 39 (Batch 1)
 * found real, live-relevant consequences of it: a second POST /turn on
 * a fresh process instance can start a genuinely concurrent turn, and
 * a crashed process leaves the Firestore agentTurns doc "active"
 * forever with nothing to ever reconcile it. This map now stays ONLY
 * as a fast, zero-Firestore-cost local optimization (isTurnActive) and
 * for turn cancellation (which genuinely can only happen in the
 * process that owns the AbortController) - claimTurnAuthoritative
 * below, not this map, is the source of truth for whether a turn may
 * start.
 */
const activeControllers = new Map<string, AbortController>();

export function registerTurn(sessionId: string): AbortController {
  const controller = new AbortController();
  activeControllers.set(sessionId, controller);
  return controller;
}

export function unregisterTurn(sessionId: string): void {
  activeControllers.delete(sessionId);
}

export function cancelTurn(sessionId: string): boolean {
  const controller = activeControllers.get(sessionId);
  if (!controller) return false;
  controller.abort();
  return true;
}

export function isTurnActive(sessionId: string): boolean {
  return activeControllers.has(sessionId);
}

/**
 * Phase 39 (Batch 1): generous on purpose. loop.ts's own per-iteration
 * heartbeat write can be as far apart as one full iteration's
 * duration, and live iteration durations have been observed up to
 * ~143s (a slow provider call, a slow foreground build). 5 minutes is
 * well over 2x that worst case - a claim is reclaimable, but only
 * after real, bounded silence, never from ordinary iteration-to-
 * iteration variance.
 */
export const TURN_CLAIM_STALE_MS = 5 * 60_000;

export class TurnClaimError extends Error {}

/**
 * The one atomicity-critical write for turn ownership - modeled
 * directly on claimRuntimeHost (lib/runtime/runtimeHostAdmin.ts):
 * reads both the claim doc and the agentTurns doc inside ONE
 * transaction, rejects only when a still-fresh active claim exists,
 * otherwise commits a fresh claim unconditionally (same-process
 * re-claim, no prior claim, and stale-claim reclaim are all treated
 * as "succeeds", same as claimRuntimeHost's tab election). When the
 * claim being replaced was active but stale, this SAME transaction
 * also reconciles the orphaned agentTurns doc - flips `active` to
 * false with terminationReason "claim_expired" - so a reclaim is
 * never silent: the abandoned turn gets a real, visible end state
 * instead of staying "active" in the UI forever. Deliberately a
 * SEPARATE Firestore collection from agentTurns (turnClaims/{sessionId},
 * not fields on the agentTurns doc itself) - see TurnClaim's own doc
 * comment (types/session.ts) for why.
 */
export async function claimTurnAuthoritative(sessionId: string): Promise<{ turnToken: string }> {
  const claimRef = adminDb.collection("turnClaims").doc(sessionId);
  const turnRef = adminDb.collection("agentTurns").doc(sessionId);

  return adminDb.runTransaction(async (tx) => {
    const [claimSnap, turnSnap] = await Promise.all([tx.get(claimRef), tx.get(turnRef)]);
    const existing = claimSnap.data() as TurnClaim | undefined;
    const now = Date.now();

    const existingIsFreshAndActive =
      existing?.active === true &&
      typeof existing.heartbeatAt === "number" &&
      now - existing.heartbeatAt < TURN_CLAIM_STALE_MS;

    if (existingIsFreshAndActive) {
      throw new TurnClaimError("A turn is already running for this session.");
    }

    const turnToken = crypto.randomUUID();
    const claim: TurnClaim = {
      sessionId,
      active: true,
      turnToken,
      claimedAt: now,
      heartbeatAt: now,
      releasedAt: null,
      terminationReason: null,
    };
    tx.set(claimRef, claim);

    // A stale-but-still-marked-active claim means the previous owner
    // almost certainly crashed/restarted mid-turn without ever reaching
    // its own finally block - reconcile the orphaned agentTurns doc in
    // the same transaction as granting the new claim, not as a
    // separate, potentially-racy follow-up write.
    const wasStaleActive = existing?.active === true && !existingIsFreshAndActive;
    if (wasStaleActive) {
      const turnData = turnSnap.data() as { active?: boolean; telemetry?: Record<string, unknown> } | undefined;
      if (turnData?.active) {
        tx.update(turnRef, {
          active: false,
          cancelledAt: now,
          // Full-object replace of telemetry (not a dot-path partial
          // update) - we already have the complete existing telemetry
          // from this same transactional read, so this is unambiguous
          // and doesn't depend on Firestore's field-path merge
          // semantics being replicated by any test double.
          telemetry: { ...(turnData.telemetry ?? {}), terminationReason: "claim_expired" },
        });
      }
    }

    return { turnToken };
  });
}

/**
 * Non-transactional, guarded by turnToken - same trust tier as
 * heartbeatRuntimeHost (not the atomicity-critical write, so that
 * precedent is acceptable here). Returns false (never throws) if this
 * caller no longer owns the claim - the caller's job is to notice and
 * stop touching Firestore, see loop.ts's split-brain guard.
 */
export async function heartbeatTurnClaim(sessionId: string, turnToken: string): Promise<boolean> {
  const ref = adminDb.collection("turnClaims").doc(sessionId);
  const snap = await ref.get();
  const existing = snap.data() as TurnClaim | undefined;
  if (!existing || existing.turnToken !== turnToken) return false;
  await ref.update({ heartbeatAt: Date.now() });
  return true;
}

/**
 * Guarded release - a no-op if this caller was already superseded (its
 * claim was reclaimed as stale), so a late-finishing orphaned process
 * can never clobber a newer, legitimate claim's state.
 */
export async function releaseTurnClaim(
  sessionId: string,
  turnToken: string,
  terminationReason: TurnTerminationReason
): Promise<boolean> {
  const ref = adminDb.collection("turnClaims").doc(sessionId);
  const snap = await ref.get();
  const existing = snap.data() as TurnClaim | undefined;
  if (!existing || existing.turnToken !== turnToken) return false;
  await ref.update({ active: false, releasedAt: Date.now(), terminationReason });
  return true;
}

/**
 * The authoritative "is a turn running" answer - what checkpoint
 * restore, and anything else outside the turn route itself, should
 * call. Checks the in-memory map first purely as a zero-Firestore-cost
 * fast path: a `true` from isTurnActive can only be a true positive
 * (this process really did register it), so it's safe to trust
 * immediately. A `false` proves nothing about OTHER processes, so it
 * always falls through to the real, Firestore-backed check.
 */
export async function isTurnActiveAuthoritative(sessionId: string): Promise<boolean> {
  if (isTurnActive(sessionId)) return true;
  const snap = await adminDb.collection("turnClaims").doc(sessionId).get();
  const claim = snap.data() as TurnClaim | undefined;
  if (!claim?.active || typeof claim.heartbeatAt !== "number") return false;
  return Date.now() - claim.heartbeatAt < TURN_CLAIM_STALE_MS;
}
