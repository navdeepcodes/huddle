import { NextRequest, NextResponse } from "next/server";

import { getVerifiedUid } from "@/lib/auth/verifyRequest";
import { requireSessionMember } from "@/lib/auth/requireSessionMember";
import { listCheckpoints } from "@/lib/checkpoints/checkpointStore";

interface Props {
  params: Promise<{ sessionId: string }>;
}

/** List metadata only (not full file contents - a checkpoint's `files` array is only fetched on restore) to keep this list cheap. */
export async function GET(request: NextRequest, { params }: Props) {
  const { sessionId } = await params;
  const uid = await getVerifiedUid(request);
  if (!uid) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const session = await requireSessionMember(sessionId, uid);
  if (!session) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  const checkpoints = await listCheckpoints(sessionId);
  const summaries = checkpoints.map((c) => ({
    id: c.id,
    sessionId: c.sessionId,
    createdAt: c.createdAt,
    label: c.label,
    fileCount: c.files.length,
  }));

  return NextResponse.json({ checkpoints: summaries });
}
