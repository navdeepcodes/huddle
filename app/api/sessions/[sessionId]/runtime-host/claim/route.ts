import { NextRequest, NextResponse } from "next/server";

import { getVerifiedUid } from "@/lib/auth/verifyRequest";
import { claimRuntimeHost, RuntimeHostClaimError } from "@/lib/runtime/runtimeHostAdmin";

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
  if (typeof tabId !== "string" || !tabId) {
    return NextResponse.json({ error: "tabId is required." }, { status: 400 });
  }

  try {
    const host = await claimRuntimeHost(sessionId, tabId);
    return NextResponse.json(host);
  } catch (error) {
    if (error instanceof RuntimeHostClaimError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error("Runtime host claim failed:", error);
    return NextResponse.json({ error: "Failed to claim the runtime host." }, { status: 500 });
  }
}
