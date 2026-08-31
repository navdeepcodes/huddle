"use client";

import { useCallback, useEffect, useState } from "react";

import { authedFetch } from "@/lib/firebase/authedFetch";

import type { Artifact } from "@/types/session";

async function fetchArtifacts(sessionId: string): Promise<Artifact[]> {
  const res = await authedFetch(`/api/sessions/${sessionId}/artifacts`);
  if (!res.ok) return [];
  const { artifacts } = (await res.json()) as { artifacts: Artifact[] };
  return artifacts;
}

/** Same polling cadence/reasoning as useCheckpoints - a fetch-based list, not a live onSnapshot (sessionArtifacts deliberately has no client-direct Firestore rule, same precedent as checkpoints/presence). Refetches on turnActive transitions so a collaborator's just-finished turn (which may have created an artifact) shows up promptly, not only on the next poll tick. */
const ARTIFACT_POLL_MS = 10_000;
const BACKGROUND_ARTIFACT_POLL_MS = 30_000;

export function useArtifacts(sessionId: string, turnActive: boolean | undefined) {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetchArtifacts(sessionId).then((list) => {
      if (!cancelled) setArtifacts(list);
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId, turnActive]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    function currentPollMs(): number {
      return document.visibilityState === "hidden" ? BACKGROUND_ARTIFACT_POLL_MS : ARTIFACT_POLL_MS;
    }

    async function poll() {
      try {
        const list = await fetchArtifacts(sessionId);
        if (!stopped) setArtifacts(list);
      } catch (error) {
        console.error("[Huddle] artifact poll failed - will retry on the next tick", error);
      } finally {
        if (!stopped) timer = setTimeout(poll, currentPollMs());
      }
    }

    timer = setTimeout(poll, currentPollMs());
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [sessionId]);

  const refresh = useCallback(async () => {
    setArtifacts(await fetchArtifacts(sessionId));
  }, [sessionId]);

  return { artifacts, refresh };
}
