import { NextRequest, NextResponse } from "next/server";

import { getVerifiedUid } from "@/lib/auth/verifyRequest";
import { requireSessionMember } from "@/lib/auth/requireSessionMember";
import { getFeedback, updateFeedbackStatus } from "@/lib/feedback/feedbackStore";

interface Props {
  params: Promise<{ sessionId: string; feedbackId: string }>;
}

export async function POST(request: NextRequest, { params }: Props) {
  const { sessionId, feedbackId } = await params;
  const uid = await getVerifiedUid(request);
  if (!uid) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const session = await requireSessionMember(sessionId, uid);
  if (!session) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  const feedback = await getFeedback(sessionId, feedbackId);
  if (!feedback) {
    return NextResponse.json({ error: "Feedback not found." }, { status: 404 });
  }

  await updateFeedbackStatus(feedbackId, "ignored");
  return NextResponse.json({ success: true });
}
