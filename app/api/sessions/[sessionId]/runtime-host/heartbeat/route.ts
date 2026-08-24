import { NextRequest, NextResponse } from "next/server";

import { getVerifiedUid } from "@/lib/auth/verifyRequest";
import { heartbeatRuntimeHost } from "@/lib/runtime/runtimeHostAdmin";

interface Props {
  params: Promise<{ sessionId: string }>;
}

export async function POST(request: NextRequest, { params }: Props) {
  const { sessionId } = await params;
  const uid = await getVerifiedUid(request);
  if (!uid) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const { tabId } = await request.json();
  const ok = await heartbeatRuntimeHost(sessionId, tabId);
  if (!ok) {
    return NextResponse.json({ error: "Not the current runtime host." }, { status: 409 });
  }
  return NextResponse.json({ success: true });
}
