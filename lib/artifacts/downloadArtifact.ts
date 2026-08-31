"use client";

import { authedFetch } from "@/lib/firebase/authedFetch";

/** Fetch-as-blob + a synthetic anchor click, not a plain <a href> - the download route requires the caller's ID token (same auth as every other session-scoped route), which a plain navigation can't attach. Returns false on any failure so the caller can show an honest error instead of a silent no-op. */
export async function downloadArtifact(sessionId: string, artifactId: string, filename: string): Promise<boolean> {
  const res = await authedFetch(`/api/sessions/${sessionId}/artifacts/${artifactId}/download`);
  if (!res.ok) return false;

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return true;
}
