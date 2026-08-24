import { NextRequest, NextResponse } from "next/server";

import { getVerifiedUid } from "@/lib/auth/verifyRequest";
import { joinSession } from "@/lib/sessions/joinSession";

interface Props {
  params: Promise<{ sessionId: string }>;
}

/** Phase 27 Part A: called once, early, by every viewer (including the original owner - a no-op for them, already a member) before any session-scoped Firestore listener attaches. See joinSession's own doc comment for why this exists at all. */
export async function POST(request: NextRequest, { params }: Props) {
  const { sessionId } = await params;
  const uid = await getVerifiedUid(request);
  if (!uid) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const session = await joinSession(sessionId, uid);
  if (!session) {
    return NextResponse.json({ error: "Session not found." }, { status: 404 });
  }

  return NextResponse.json({ session });
}
