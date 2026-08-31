import "server-only";

import { adminDb } from "@/lib/firebase/admin";

import type { SessionFile } from "@/types/session";

/**
 * sessionFiles is the ONLY source of truth for a session's files -
 * read and written here directly, never through the runtime. This is
 * what makes it structurally impossible for the agent to be told a
 * file "doesn't exist" merely because the WebContainer hasn't finished
 * booting: read_file/list_files/write_file all resolve against this
 * store, independent of runtime state.
 *
 * One doc per (sessionId, path) - deterministic id, so repeated writes
 * to the same path overwrite the same doc instead of accumulating
 * duplicates. `/` is escaped (Firestore doc ids can't contain it).
 */
function fileDocId(sessionId: string, path: string): string {
  return `${sessionId}_${encodeURIComponent(path)}`;
}

export async function readSessionFile(
  sessionId: string,
  path: string
): Promise<SessionFile | null> {
  const snap = await adminDb
    .collection("sessionFiles")
    .doc(fileDocId(sessionId, path))
    .get();

  if (!snap.exists) return null;
  return snap.data() as SessionFile;
}

export async function listSessionFiles(
  sessionId: string
): Promise<SessionFile[]> {
  const snap = await adminDb
    .collection("sessionFiles")
    .where("sessionId", "==", sessionId)
    .get();

  return snap.docs.map((d) => d.data() as SessionFile);
}

/**
 * Root cause (2026-08-22, Phase 15 investigation): live-reproduced,
 * byte for byte, outside the agent loop entirely (no LLM, no
 * continuation-turn context involved) - listSessionDirectory(id, "")
 * correctly lists a session's real files, but listSessionDirectory(id,
 * "/"), (id, ".") and (id, "./") all silently return empty for that
 * SAME session with the SAME files present. The tool's own schema
 * tells the model to pass "" for the root, but nothing enforces that,
 * and "." or "/" are exactly what a model reaches for when it isn't
 * anchored to its own prior turn's convention - which is precisely a
 * continuation turn, explaining why this surfaced there in the Phase
 * 14 benchmark and not turn 1. This was never a cache, session-id, or
 * Firestore-timing problem (repeated identical calls against the same
 * session id return the identical, correct result) - it's a plain
 * prefix-matching bug: only the literal "" ever produced an empty
 * prefix, so "/"'s computed prefix stayed "/" and no real file path
 * (which never starts with a leading slash) could ever match it.
 */
function normalizeDirPath(dirPath: string): string {
  let normalized = dirPath.trim();
  let previous: string;
  do {
    previous = normalized;
    normalized = normalized
      .replace(/^\.\//, "")
      .replace(/^\.$/, "")
      .replace(/^\/+/, "")
      .replace(/\/+$/, "");
  } while (normalized !== previous);
  return normalized;
}

/**
 * One-level-deep directory listing, computed in memory over the full
 * file set (no native directory concept in a flat doc-per-file model,
 * and session file counts are small enough for v1 that this is cheap).
 * Returns files at exactly this depth plus inferred subdirectory names
 * for anything nested deeper.
 */
export async function listSessionDirectory(
  sessionId: string,
  dirPath: string
): Promise<{ files: string[]; directories: string[] }> {
  const all = await listSessionFiles(sessionId);
  const normalizedDirPath = normalizeDirPath(dirPath);
  const prefix = normalizedDirPath ? `${normalizedDirPath}/` : "";

  const files = new Set<string>();
  const directories = new Set<string>();

  for (const file of all) {
    if (!file.path.startsWith(prefix)) continue;
    const rest = file.path.slice(prefix.length);
    if (!rest) continue;

    const slashIndex = rest.indexOf("/");
    if (slashIndex === -1) {
      files.add(rest);
    } else {
      directories.add(rest.slice(0, slashIndex));
    }
  }

  return {
    files: Array.from(files).sort(),
    directories: Array.from(directories).sort(),
  };
}

/**
 * Persists a whole batch of file writes from one agent step as a
 * single Firestore WriteBatch - several write_file tool calls in one
 * model iteration become one round trip, not N sequential ones. Still
 * one source of truth, still no new synchronization engine: this is
 * purely a persistence-efficiency change, not a second file model.
 *
 * Phase 31: also bumps the session doc's own `updatedAt` in the SAME
 * batch (one extra write in an already-open batch, no new round trip)
 * - this is the one call site every real file change already passes
 * through, whether the agent wrote it or a user did via the explorer,
 * so it's the highest-signal, lowest-risk place to drive the
 * dashboard's "last activity" without touching the turn-start route
 * (app/api/sessions/[sessionId]/turn/route.ts's own comment documents
 * exactly why that file's control flow is not safe to add an await
 * into casually).
 */
export async function batchWriteSessionFiles(
  sessionId: string,
  files: Array<{
    path: string;
    content: string;
    updatedBy: "agent" | "user";
    encoding?: "utf8" | "base64";
    updatedByUid?: string;
  }>
): Promise<void> {
  if (files.length === 0) return;

  const batch = adminDb.batch();
  const now = Date.now();
  // Phase 37: the one place "is this a Project" gets decided - a path outside
  // artifacts/ is real application code, not a generated artifact. One-way
  // (never reset false even if that specific file is later deleted - the
  // session was genuinely worked on as a project at some point).
  const hasRealFile = files.some((f) => !f.path.startsWith("artifacts/"));

  for (const file of files) {
    const ref = adminDb.collection("sessionFiles").doc(fileDocId(sessionId, file.path));
    const doc: SessionFile = {
      id: ref.id,
      sessionId,
      path: file.path,
      content: file.content,
      updatedAt: now,
      updatedBy: file.updatedBy,
      ...(file.encoding ? { encoding: file.encoding } : {}),
      ...(file.updatedByUid ? { updatedByUid: file.updatedByUid } : {}),
    };
    batch.set(ref, doc);
  }
  batch.update(adminDb.collection("sessions").doc(sessionId), {
    updatedAt: now,
    ...(hasRealFile ? { hasRealFiles: true } : {}),
  });

  await batch.commit();
}

export async function deleteSessionFile(
  sessionId: string,
  path: string
): Promise<void> {
  await adminDb
    .collection("sessionFiles")
    .doc(fileDocId(sessionId, path))
    .delete();
}

/** Batch variant of deleteSessionFile - used for deleting every file under a directory prefix in one round trip, same WriteBatch discipline as batchWriteSessionFiles (including the same session.updatedAt bump - see that function's own comment). */
export async function deleteSessionFiles(sessionId: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  const batch = adminDb.batch();
  for (const path of paths) {
    batch.delete(adminDb.collection("sessionFiles").doc(fileDocId(sessionId, path)));
  }
  batch.update(adminDb.collection("sessions").doc(sessionId), { updatedAt: Date.now() });
  await batch.commit();
}
