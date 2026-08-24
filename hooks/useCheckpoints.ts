"use client";

import { useCallback, useEffect, useState } from "react";

import { authedFetch } from "@/lib/firebase/authedFetch";

import type { Checkpoint } from "@/types/session";

export type CheckpointSummary = Pick<Checkpoint, "id" | "sessionId" | "createdAt" | "label"> & { fileCount: number };

interface FetchResult {
  list: CheckpointSummary[];
  latestPaths: Set<string>;
}

/** Pure fetch, no setState - kept at module scope (not a closure over component state) so the effect below stays a plain "await, then setState once" shape, not a reachability trail through a hook-scoped callback. */
async function fetchCheckpoints(sessionId: string): Promise<FetchResult> {
  const res = await authedFetch(`/api/sessions/${sessionId}/checkpoints`);
  const list: CheckpointSummary[] = res.ok ? (await res.json()).checkpoints : [];

  let latestPaths = new Set<string>();
  if (list.length > 0) {
    const detailRes = await authedFetch(`/api/sessions/${sessionId}/checkpoints/${list[0].id}`);
    if (detailRes.ok) {
      const { checkpoint } = (await detailRes.json()) as { checkpoint: Checkpoint };
      latestPaths = new Set(checkpoint.files.map((f) => f.path));
    }
  }

  return { list, latestPaths };
}

/** Same cadence as usePresence's heartbeat - see this hook's own doc comment for why a periodic poll is needed at all. */
const CHECKPOINT_POLL_MS = 10_000;
/** Phase 30B Part 1: same reasoning as usePresence's BACKGROUND_HEARTBEAT_INTERVAL_MS - a hidden tab has no one watching for checkpoint changes, confirmed as a real contributor to the investigated Firestore quota exhaustion. */
const BACKGROUND_CHECKPOINT_POLL_MS = 30_000;

/**
 * Fetch-based, not a live onSnapshot listener - see firestore.rules's
 * own note on why checkpoints/sessionPresence deliberately have no
 * client-direct read rule this pass (avoids a rules deploy to the
 * shared production Firebase project). `turnActive` is watched so the
 * list refreshes right as a new turn starts (a fresh pre-turn
 * checkpoint should now exist) and again once it finishes.
 *
 * Phase 28 Part 1 Test C: `turnActive` alone isn't enough in
 * multiplayer - restoring a checkpoint doesn't go through the normal
 * turn flow (it's a direct POST, not `/turn`), so a viewer who didn't
 * perform the restore never saw `turnActive` toggle and kept
 * `latestPaths` pointed at the pre-restore checkpoint. The files
 * themselves stayed correctly live-synced (useSessionFiles), but
 * ChangesSummary derives "changed since the last checkpoint" from
 * this stale `latestPaths`, so a restored file could keep showing a
 * false "modified" badge on the tab that didn't click Restore.
 * Confirmed live in a two-tab session; fixed with the same
 * self-rescheduling setTimeout pattern already proven in
 * usePresence.ts, rather than adding a second onSnapshot-based
 * checkpoint architecture for what's fundamentally a rare, low-stakes
 * staleness window.
 */
export function useCheckpoints(sessionId: string, turnActive: boolean | undefined) {
  const [checkpoints, setCheckpoints] = useState<CheckpointSummary[]>([]);
  const [latestPaths, setLatestPaths] = useState<Set<string> | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchCheckpoints(sessionId).then(({ list, latestPaths }) => {
      if (cancelled) return;
      setCheckpoints(list);
      setLatestPaths(latestPaths);
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId, turnActive]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function poll() {
      try {
        const { list, latestPaths } = await fetchCheckpoints(sessionId);
        if (!stopped) {
          setCheckpoints(list);
          setLatestPaths(latestPaths);
        }
      } catch (error) {
        console.error("[Huddle] checkpoint poll failed - will retry on the next tick", error);
      } finally {
        if (!stopped) timer = setTimeout(poll, currentPollMs());
      }
    }

    function currentPollMs(): number {
      return document.visibilityState === "hidden" ? BACKGROUND_CHECKPOINT_POLL_MS : CHECKPOINT_POLL_MS;
    }

    timer = setTimeout(poll, currentPollMs());
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [sessionId]);

  const refresh = useCallback(async () => {
    const { list, latestPaths } = await fetchCheckpoints(sessionId);
    setCheckpoints(list);
    setLatestPaths(latestPaths);
  }, [sessionId]);

  const restore = useCallback(
    async (checkpointId: string) => {
      const res = await authedFetch(`/api/sessions/${sessionId}/checkpoints/${checkpointId}/restore`, { method: "POST" });
      if (res.ok) await refresh();
      return res.ok;
    },
    [sessionId, refresh]
  );

  return { checkpoints, latestPaths, refresh, restore };
}
