import { NextRequest, NextResponse } from "next/server";

import { getVerifiedUid } from "@/lib/auth/verifyRequest";
import { requireSessionMember } from "@/lib/auth/requireSessionMember";
import { heartbeatPresence, leavePresence, listActivePresence } from "@/lib/presence/presenceStore";

interface Props {
  params: Promise<{ sessionId: string }>;
}

/** Polled by the client (no live listener - see this route file's own rationale for avoiding a rules deploy). */
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

  const presence = await listActivePresence(sessionId);
  return NextResponse.json({ presence });
}

export async function POST(request: NextRequest, { params }: Props) {
  const { sessionId } = await params;
  const uid = await getVerifiedUid(request);
  if (!uid) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const session = await requireSessionMember(sessionId, uid);
  if (!session) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  const { tabId } = await request.json();
  if (typeof tabId !== "string" || !tabId) {
    return NextResponse.json({ error: "tabId is required." }, { status: 400 });
  }

  await heartbeatPresence(sessionId, uid, tabId);
  return NextResponse.json({ success: true });
}

/** Best-effort - a browser close can't guarantee this fires; the client-side staleness window (PRESENCE_STALE_MS) is what actually bounds a "ghost" presence entry either way. */
export async function DELETE(request: NextRequest, { params }: Props) {
  const { sessionId } = await params;
  const uid = await getVerifiedUid(request);
  if (!uid) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const { tabId } = await request.json();
  if (typeof tabId !== "string" || !tabId) {
    return NextResponse.json({ error: "tabId is required." }, { status: 400 });
  }

  await leavePresence(sessionId, uid, tabId);
  return NextResponse.json({ success: true });
}
