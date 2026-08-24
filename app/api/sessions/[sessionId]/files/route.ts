import { NextRequest, NextResponse } from "next/server";

import { getVerifiedUid } from "@/lib/auth/verifyRequest";
import { requireSessionMember } from "@/lib/auth/requireSessionMember";
import { batchWriteSessionFiles, deleteSessionFiles, listSessionFiles, readSessionFile } from "@/lib/files/fileStore";
import { isTurnActive } from "@/lib/agent/turnRegistry";
import { isValidSessionFilePath, DIRECTORY_PLACEHOLDER_NAME } from "@/lib/files/fileTree";

interface Props {
  params: Promise<{ sessionId: string }>;
}

/** Shared by POST/DELETE below - PATCH keeps its own inline checks since its error copy is edit-specific and predates this. */
async function authorizeMutation(request: NextRequest, sessionId: string): Promise<NextResponse | { uid: string }> {
  const uid = await getVerifiedUid(request);
  if (!uid) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

  const session = await requireSessionMember(sessionId, uid);
  if (!session) return NextResponse.json({ error: "Forbidden." }, { status: 403 });

  if (isTurnActive(sessionId)) {
    return NextResponse.json({ error: "Cannot change files while the agent is working." }, { status: 409 });
  }

  return { uid };
}

/** Phase 31: create a file, or a directory (written as a `${path}/.gitkeep` placeholder - see fileTree.ts's own doc comment on why). Rejects if something already exists at that path. */
export async function POST(request: NextRequest, { params }: Props) {
  const { sessionId } = await params;
  const auth = await authorizeMutation(request, sessionId);
  if (auth instanceof NextResponse) return auth;

  const { path, isDirectory } = await request.json();
  if (typeof path !== "string" || !isValidSessionFilePath(path)) {
    return NextResponse.json({ error: "Invalid path." }, { status: 400 });
  }

  const targetPath = isDirectory ? `${path}/${DIRECTORY_PLACEHOLDER_NAME}` : path;

  if (isDirectory) {
    const all = await listSessionFiles(sessionId);
    if (all.some((f) => f.path === targetPath || f.path.startsWith(`${path}/`))) {
      return NextResponse.json({ error: "A folder already exists at that path." }, { status: 409 });
    }
  } else {
    const existing = await readSessionFile(sessionId, path);
    if (existing) return NextResponse.json({ error: "A file already exists at that path." }, { status: 409 });
  }

  await batchWriteSessionFiles(sessionId, [{ path: targetPath, content: "", updatedBy: "user", updatedByUid: auth.uid }]);
  return NextResponse.json({ success: true });
}

/** Deletes a file, or every file under a directory prefix, in one batch. */
export async function DELETE(request: NextRequest, { params }: Props) {
  const { sessionId } = await params;
  const auth = await authorizeMutation(request, sessionId);
  if (auth instanceof NextResponse) return auth;

  const { path, isDirectory } = await request.json();
  if (typeof path !== "string" || !isValidSessionFilePath(path)) {
    return NextResponse.json({ error: "Invalid path." }, { status: 400 });
  }

  if (isDirectory) {
    const all = await listSessionFiles(sessionId);
    const prefix = `${path}/`;
    const toDelete = all.filter((f) => f.path.startsWith(prefix)).map((f) => f.path);
    await deleteSessionFiles(sessionId, toDelete);
  } else {
    const existing = await readSessionFile(sessionId, path);
    if (!existing) return NextResponse.json({ error: "File not found." }, { status: 404 });
    await deleteSessionFiles(sessionId, [path]);
  }

  return NextResponse.json({ success: true });
}

/** Phase 24: manual file edits from the Code View's "Save" action - sessionFiles already models `updatedBy: "user"` for exactly this case, just never had a write path from the UI before. Rejected while a turn is running, same reasoning as checkpoint restore - a user edit racing the agent's own writes to the same file would produce a confusing mixed result. */
export async function PATCH(request: NextRequest, { params }: Props) {
  const { sessionId } = await params;
  const uid = await getVerifiedUid(request);
  if (!uid) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const session = await requireSessionMember(sessionId, uid);
  if (!session) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  if (isTurnActive(sessionId)) {
    return NextResponse.json({ error: "Cannot edit files while the agent is working." }, { status: 409 });
  }

  const { path, content } = await request.json();
  if (typeof path !== "string" || !path.trim() || typeof content !== "string") {
    return NextResponse.json({ error: "path and content are required." }, { status: 400 });
  }

  await batchWriteSessionFiles(sessionId, [{ path, content, updatedBy: "user", updatedByUid: uid }]);
  return NextResponse.json({ success: true });
}
