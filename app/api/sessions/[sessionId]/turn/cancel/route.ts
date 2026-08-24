import { NextRequest, NextResponse } from "next/server";

import { getVerifiedUid } from "@/lib/auth/verifyRequest";
import { cancelTurn } from "@/lib/agent/turnRegistry";

interface Props {
  params: Promise<{ sessionId: string }>;
}

export async function POST(request: NextRequest, { params }: Props) {
  const { sessionId } = await params;
  const uid = await getVerifiedUid(request);
  if (!uid) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const cancelled = cancelTurn(sessionId);
  return NextResponse.json({ cancelled });
}
