import { NextRequest, NextResponse } from "next/server";

import { getVerifiedUid } from "@/lib/auth/verifyRequest";
import { requireSessionMember } from "@/lib/auth/requireSessionMember";
import { batchWriteSessionFiles, deleteSessionFiles, listSessionFiles } from "@/lib/files/fileStore";
import { isTurnActive } from "@/lib/agent/turnRegistry";
import { isValidSessionFilePath } from "@/lib/files/fileTree";

interface Props {
  params: Promise<{ sessionId: string }>;
}

/**
 * Renames a file, or every file under a directory prefix, in one batch -
 * there's no native rename/move primitive in a flat doc-per-path store
 * (fileStore.ts), so this reads the affected docs' existing content
 * once, writes them at the new paths, then deletes the old ones. A
 * directory rename remaps every matching file's prefix in one pass so
 * every descendant moves together, not just the top-level path.
 */
export async function POST(request: NextRequest, { params }: Props) {
  const { sessionId } = await params;
  const uid = await getVerifiedUid(request);
  if (!uid) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

  const session = await requireSessionMember(sessionId, uid);
  if (!session) return NextResponse.json({ error: "Forbidden." }, { status: 403 });

  if (isTurnActive(sessionId)) {
    return NextResponse.json({ error: "Cannot change files while the agent is working." }, { status: 409 });
  }

  const { oldPath, newPath, isDirectory } = await request.json();
  if (
    typeof oldPath !== "string" ||
    typeof newPath !== "string" ||
    !isValidSessionFilePath(oldPath) ||
    !isValidSessionFilePath(newPath) ||
    oldPath === newPath
  ) {
    return NextResponse.json({ error: "Invalid path." }, { status: 400 });
  }

  const all = await listSessionFiles(sessionId);

  if (isDirectory) {
    const oldPrefix = `${oldPath}/`;
    const newPrefix = `${newPath}/`;
    const moving = all.filter((f) => f.path.startsWith(oldPrefix));
    if (moving.length === 0) return NextResponse.json({ error: "Folder not found." }, { status: 404 });
    if (all.some((f) => f.path === newPath || f.path.startsWith(newPrefix))) {
      return NextResponse.json({ error: "A folder already exists at that path." }, { status: 409 });
    }

    await batchWriteSessionFiles(
      sessionId,
      moving.map((f) => ({
        path: newPrefix + f.path.slice(oldPrefix.length),
        content: f.content,
        encoding: f.encoding,
        updatedBy: "user" as const,
        updatedByUid: uid,
      }))
    );
    await deleteSessionFiles(sessionId, moving.map((f) => f.path));
  } else {
    const existing = all.find((f) => f.path === oldPath);
    if (!existing) return NextResponse.json({ error: "File not found." }, { status: 404 });
    if (all.some((f) => f.path === newPath)) {
      return NextResponse.json({ error: "A file already exists at that path." }, { status: 409 });
    }

    await batchWriteSessionFiles(sessionId, [
      { path: newPath, content: existing.content, encoding: existing.encoding, updatedBy: "user", updatedByUid: uid },
    ]);
    await deleteSessionFiles(sessionId, [oldPath]);
  }

  return NextResponse.json({ success: true });
}
