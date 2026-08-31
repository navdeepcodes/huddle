"use client";

import { useEffect, useState } from "react";

import { authedFetch } from "@/lib/firebase/authedFetch";

/**
 * Phase 36 STEP 10: images get a REAL browser-native preview, unlike
 * PPTX - but the download route requires an auth header a plain <img
 * src> can't attach (same reasoning as downloadArtifact.ts). Fetches
 * the real bytes once as a blob and hands back an object URL usable
 * directly as <img src>, revoking it on cleanup so it doesn't leak.
 */
export function useArtifactImageUrl(sessionId: string, artifactId: string, enabled: boolean): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let objectUrl: string | null = null;

    authedFetch(`/api/sessions/${sessionId}/artifacts/${artifactId}/download`)
      .then((res) => (res.ok ? res.blob() : null))
      .then((blob) => {
        if (cancelled || !blob) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [sessionId, artifactId, enabled]);

  return url;
}
