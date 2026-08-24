import { NextRequest, NextResponse } from "next/server";

import { getVerifiedUid } from "@/lib/auth/verifyRequest";
import { requireSessionMember } from "@/lib/auth/requireSessionMember";
import { getCheckpoint } from "@/lib/checkpoints/checkpointStore";

interface Props {
  params: Promise<{ sessionId: string; checkpointId: string }>;
}

/** Full detail (including file contents) for "view checkpoint" and for computing which paths existed before the current turn - the list route deliberately omits this to stay cheap. */
export async function GET(request: NextRequest, { params }: Props) {
  const { sessionId, checkpointId } = await params;
  const uid = await getVerifiedUid(request);
  if (!uid) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const session = await requireSessionMember(sessionId, uid);
  if (!session) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  const checkpoint = await getCheckpoint(sessionId, checkpointId);
  if (!checkpoint) {
    return NextResponse.json({ error: "Checkpoint not found." }, { status: 404 });
  }

  return NextResponse.json({ checkpoint });
}
