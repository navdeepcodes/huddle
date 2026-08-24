"use client";

import { useEffect, useRef, useState } from "react";

import { authedFetch } from "@/lib/firebase/authedFetch";

import type { SessionPresence } from "@/types/session";

export const HEARTBEAT_INTERVAL_MS = 8_000;
/**
 * Phase 30B Part 1: a backgrounded/hidden tab has no one looking at
 * its presence dot, so heartbeating it at full frequency indefinitely
 * is pure waste - confirmed as a real, non-trivial contributor to the
 * Firestore quota exhaustion investigated this phase (this hook and
 * useCheckpoints.ts were the only two pollers with zero visibility
 * awareness; useRuntimeHost.ts already had this pattern). Chosen to
 * stay under PRESENCE_STALE_MS (20s, presenceStore.ts) most of the
 * time, so a briefly-backgrounded tab still reads as present, not
 * silently "offline" - a real product-behavior constraint, not an
 * arbitrary number.
 */
export const BACKGROUND_HEARTBEAT_INTERVAL_MS = 15_000;

interface HeartbeatDeps {
  sessionId: string;
  tabId: string;
  fetchFn: typeof authedFetch;
  onPresence: (list: SessionPresence[]) => void;
  scheduleFn: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearFn: (handle: ReturnType<typeof setTimeout>) => void;
  getIntervalMs: () => number;
}

/**
 * The actual heartbeat loop, extracted to a plain function so it's
 * testable without a React rendering harness - same reasoning as
 * useCheckpoints.ts's module-scope fetchCheckpoints. Takes its
 * dependencies (fetch, scheduler, the presence setter) as parameters
 * instead of closing over the hook's own state, so a test can inject
 * fakes and observe scheduling decisions directly, and returns a
 * `stop()` that's the single source of truth for "no future tick" -
 * both the fetch path and the timer path check the same `stopped`
 * flag before doing anything observable.
 *
 * Same cadence/pattern as useRuntimeHost.ts, reused for a different
 * purpose (human presence, not runtime ownership) - see
 * SessionPresence's own doc comment. Poll-based reads, same
 * rules-deploy-avoidance reasoning as useCheckpoints.
 *
 * Phase 27 Part E/M: live-reproduced during the two-browser chaos test
 * - on the tab that ALSO owns the runtime host (heavy concurrent
 * activity: WebContainer boot, an active agent turn's onSnapshot
 * updates, frequent re-renders), this hook's heartbeat reliably fired
 * ONCE on mount and then never again, while useRuntimeHost's own
 * heartbeat interval on the exact same tab kept ticking correctly the
 * whole time. A read-only viewer tab (no runtime, far less concurrent
 * work) never showed the problem. The exact mechanism wasn't pinned
 * down with certainty, but a bare `setInterval` callback whose own
 * body is async has a known general hazard under heavy concurrent
 * work: if a browser/runtime hiccup or an unhandled rejection inside
 * one tick disrupts the timer callback, nothing re-arms it - there is
 * no self-healing. A self-rescheduling setTimeout chain doesn't share
 * that failure mode: each call is responsible for scheduling the next
 * one only after its own attempt resolves (success OR failure, via
 * finally), so a single bad tick can't silently end all future ones,
 * and ticks can never overlap (the next one is scheduled only once the
 * current one is fully done, unlike setInterval).
 */
export function startPresenceHeartbeat({
  sessionId,
  tabId,
  fetchFn,
  onPresence,
  scheduleFn,
  clearFn,
  getIntervalMs,
}: HeartbeatDeps): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function beat() {
    try {
      await fetchFn(`/api/sessions/${sessionId}/presence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tabId }),
      });
      const res = await fetchFn(`/api/sessions/${sessionId}/presence`);
      if (stopped || !res.ok) return;
      const { presence: list } = (await res.json()) as { presence: SessionPresence[] };
      onPresence(list);
    } catch (error) {
      console.error("[Huddle] presence heartbeat failed - will retry on the next tick", error);
    } finally {
      if (!stopped) timer = scheduleFn(beat, getIntervalMs());
    }
  }

  void beat();

  return () => {
    stopped = true;
    if (timer !== null) clearFn(timer);
  };
}

export function usePresence(sessionId: string): SessionPresence[] {
  const [presence, setPresence] = useState<SessionPresence[]>([]);
  const tabIdRef = useRef<string | null>(null);
  if (tabIdRef.current === null) tabIdRef.current = crypto.randomUUID();

  useEffect(() => {
    const tabId = tabIdRef.current as string;

    const stopHeartbeat = startPresenceHeartbeat({
      sessionId,
      tabId,
      fetchFn: authedFetch,
      onPresence: setPresence,
      scheduleFn: setTimeout,
      clearFn: clearTimeout,
      // Read fresh at schedule-time, not captured once - a tab that's
      // backgrounded mid-cycle naturally slows down on its NEXT
      // reschedule (within one tick, not immediately - see this file's
      // own doc comment on why an explicit "beat now" trigger wasn't
      // added: the minimal fix, not a new API surface).
      getIntervalMs: () => (document.visibilityState === "hidden" ? BACKGROUND_HEARTBEAT_INTERVAL_MS : HEARTBEAT_INTERVAL_MS),
    });

    return () => {
      stopHeartbeat();
      void authedFetch(`/api/sessions/${sessionId}/presence`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tabId }),
      });
    };
  }, [sessionId]);

  return presence;
}
