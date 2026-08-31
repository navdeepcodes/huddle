import { NextRequest, NextResponse } from "next/server";

import { getFeedback } from "@/lib/feedback/feedbackStore";

interface Props {
  params: Promise<{ sessionId: string; feedbackId: string }>;
}

/**
 * Phase 38 STEP 11: the entire "notify me" mechanism - no accounts, no
 * email/push infrastructure. A visitor who opted in at submission time
 * gets a notifyToken back and can bookmark this URL to self-serve check
 * whether their suggestion was accepted, instead of Huddle pushing
 * anything to them. Requires the exact token (not just the feedbackId)
 * so a stranger can't enumerate/read other visitors' feedback status.
 */
export async function GET(request: NextRequest, { params }: Props) {
  const { sessionId, feedbackId } = await params;
  const token = new URL(request.url).searchParams.get("token");
  if (!token) {
    return NextResponse.json({ error: "token is required." }, { status: 400 });
  }

  const feedback = await getFeedback(sessionId, feedbackId);
  if (!feedback || feedback.notifyToken !== token) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  return NextResponse.json({ status: feedback.status });
}
