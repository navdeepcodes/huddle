import "server-only";

import { adminDb } from "@/lib/firebase/admin";

import type { Artifact, ArtifactStatus } from "@/types/session";

const MAX_TITLE_LENGTH = 120;

/**
 * Phase 35: same precedent as checkpointStore.ts (Phase 24) - a small,
 * Admin-SDK-only collection with no client-direct Firestore rule,
 * deliberately, to avoid a rules deploy to the shared production
 * project. Client code only ever reaches this through the GET routes
 * below, mirroring how checkpoints/presence already work.
 */
export async function createArtifact(input: {
  sessionId: string;
  type: Artifact["type"];
  title: string;
  path: string;
  createdBy: "agent" | "user";
  createdByUid?: string;
}): Promise<Artifact> {
  const ref = adminDb.collection("sessionArtifacts").doc();
  const artifact: Artifact = {
    id: ref.id,
    sessionId: input.sessionId,
    type: input.type,
    title: input.title.trim().slice(0, MAX_TITLE_LENGTH) || "Untitled",
    path: input.path,
    status: "generating",
    createdAt: Date.now(),
    createdBy: input.createdBy,
    ...(input.createdByUid ? { createdByUid: input.createdByUid } : {}),
  };
  await ref.set(artifact);
  return artifact;
}

/**
 * `path` is optional to override - Phase 36: an image's real file
 * extension (png/jpeg) isn't known until the provider actually
 * responds, unlike a presentation's fixed .pptx, so create_image
 * creates the record with a placeholder path and finalizes the real
 * one here once generation succeeds.
 */
export async function markArtifactReady(artifactId: string, metadata?: Artifact["metadata"], path?: string): Promise<void> {
  await adminDb
    .collection("sessionArtifacts")
    .doc(artifactId)
    .update({
      status: "ready" satisfies ArtifactStatus,
      ...(metadata ? { metadata } : {}),
      ...(path ? { path } : {}),
    });
}

export async function markArtifactFailed(artifactId: string, errorMessage: string): Promise<void> {
  await adminDb
    .collection("sessionArtifacts")
    .doc(artifactId)
    .update({ status: "failed" satisfies ArtifactStatus, errorMessage });
}

/** Sorted in memory, not via Firestore .orderBy() - same reasoning as listCheckpoints: avoids a composite-index/rules deploy for what's a small per-session list. */
export async function listArtifacts(sessionId: string): Promise<Artifact[]> {
  const snap = await adminDb.collection("sessionArtifacts").where("sessionId", "==", sessionId).get();
  return snap.docs.map((d) => d.data() as Artifact).sort((a, b) => b.createdAt - a.createdAt);
}

export async function getArtifact(sessionId: string, artifactId: string): Promise<Artifact | null> {
  const snap = await adminDb.collection("sessionArtifacts").doc(artifactId).get();
  if (!snap.exists) return null;
  const artifact = snap.data() as Artifact;
  return artifact.sessionId === sessionId ? artifact : null;
}
