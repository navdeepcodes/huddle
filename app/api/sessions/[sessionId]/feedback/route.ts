import { NextRequest, NextResponse } from "next/server";

import { getVerifiedUid } from "@/lib/auth/verifyRequest";
import { requireSessionMember } from "@/lib/auth/requireSessionMember";
import { listFeedback } from "@/lib/feedback/feedbackStore";

interface Props {
  params: Promise<{ sessionId: string }>;
}

/** Any real member of the project can see its world feedback - same trust level they already have over files/chat/checkpoints, not a new "owner only" tier. Only the world-access toggle itself (a bigger decision) is restricted to the true owner. */
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

  const feedback = await listFeedback(sessionId);
  return NextResponse.json({ feedback });
}
