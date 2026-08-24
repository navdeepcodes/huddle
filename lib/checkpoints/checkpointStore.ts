import "server-only";

import { adminDb } from "@/lib/firebase/admin";
import { batchWriteSessionFiles, deleteSessionFile, listSessionFiles } from "@/lib/files/fileStore";

import type { Checkpoint } from "@/types/session";

const MAX_LABEL_LENGTH = 120;

/**
 * Snapshots every current session file as-is, right before an agent
 * turn is about to change them - see loop.ts's call site and
 * Checkpoint's own doc comment for why this is whole-file, not a diff.
 * Never throws into the caller's control flow on its own terms (the
 * caller wraps this in try/catch regardless - see loop.ts) so a
 * Firestore hiccup here can never block the actual agent turn it's
 * meant to protect.
 */
export async function createCheckpoint(sessionId: string, label: string): Promise<void> {
  const files = await listSessionFiles(sessionId);
  const ref = adminDb.collection("checkpoints").doc();

  const checkpoint: Checkpoint = {
    id: ref.id,
    sessionId,
    createdAt: Date.now(),
    label: label.trim().slice(0, MAX_LABEL_LENGTH) || "(no message)",
    files: files.map((f) => ({
      path: f.path,
      content: f.content,
      ...(f.encoding ? { encoding: f.encoding } : {}),
    })),
  };

  await ref.set(checkpoint);
}

/** Sorted in memory, not via Firestore .orderBy() - an equality-filter-plus-orderBy-on-a-different-field query needs a composite index that doesn't exist for this collection, and checkpoint counts per session are small enough that this is cheap. Avoids requiring a Firestore index deploy to the shared production project for this pass. */
export async function listCheckpoints(sessionId: string): Promise<Checkpoint[]> {
  const snap = await adminDb.collection("checkpoints").where("sessionId", "==", sessionId).get();
  return snap.docs.map((d) => d.data() as Checkpoint).sort((a, b) => b.createdAt - a.createdAt);
}

export async function getCheckpoint(sessionId: string, checkpointId: string): Promise<Checkpoint | null> {
  const snap = await adminDb.collection("checkpoints").doc(checkpointId).get();
  if (!snap.exists) return null;
  const checkpoint = snap.data() as Checkpoint;
  return checkpoint.sessionId === sessionId ? checkpoint : null;
}

/**
 * Full restore, not an overlay: writes back every file the checkpoint
 * held, AND deletes any current file the checkpoint didn't have - a
 * file the agent created after the checkpoint was taken must actually
 * disappear on restore, not linger alongside the reverted ones.
 */
export async function restoreCheckpoint(sessionId: string, checkpointId: string): Promise<Checkpoint | null> {
  const checkpoint = await getCheckpoint(sessionId, checkpointId);
  if (!checkpoint) return null;

  const currentFiles = await listSessionFiles(sessionId);
  const checkpointPaths = new Set(checkpoint.files.map((f) => f.path));
  const toDelete = currentFiles.filter((f) => !checkpointPaths.has(f.path));

  await batchWriteSessionFiles(
    sessionId,
    checkpoint.files.map((f) => ({ ...f, updatedBy: "user" as const }))
  );
  await Promise.all(toDelete.map((f) => deleteSessionFile(sessionId, f.path)));

  return checkpoint;
}
