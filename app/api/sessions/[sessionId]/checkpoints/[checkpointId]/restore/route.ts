import { NextRequest, NextResponse } from "next/server";

import { getVerifiedUid } from "@/lib/auth/verifyRequest";
import { requireSessionMember } from "@/lib/auth/requireSessionMember";
import { restoreCheckpoint } from "@/lib/checkpoints/checkpointStore";
import { isTurnActive } from "@/lib/agent/turnRegistry";

interface Props {
  params: Promise<{ sessionId: string; checkpointId: string }>;
}

/** Rejected while a turn is running - restoring files out from under an active agent turn's own writes would produce a confusing mixed state, same reasoning as turn/route.ts's own 409. */
export async function POST(request: NextRequest, { params }: Props) {
  const { sessionId, checkpointId } = await params;
  const uid = await getVerifiedUid(request);
  if (!uid) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const session = await requireSessionMember(sessionId, uid);
  if (!session) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  if (isTurnActive(sessionId)) {
    return NextResponse.json({ error: "Cannot restore while the agent is working." }, { status: 409 });
  }

  const restored = await restoreCheckpoint(sessionId, checkpointId);
  if (!restored) {
    return NextResponse.json({ error: "Checkpoint not found." }, { status: 404 });
  }

  return NextResponse.json({ success: true, fileCount: restored.files.length });
}
