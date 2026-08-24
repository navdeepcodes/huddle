import { NextRequest, NextResponse } from "next/server";

import { getVerifiedUid } from "@/lib/auth/verifyRequest";
import { reportRuntimeHostState } from "@/lib/runtime/runtimeHostAdmin";

import type { RuntimeState, RuntimeStartupTelemetry } from "@/types/session";

interface Props {
  params: Promise<{ sessionId: string }>;
}

export async function POST(request: NextRequest, { params }: Props) {
  const { sessionId } = await params;
  const uid = await getVerifiedUid(request);
  if (!uid) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const body = await request.json();
  const { tabId, state, port, previewUrl, errorMessage, startupTelemetry } = body as {
    tabId: string;
    state: RuntimeState;
    port?: number | null;
    previewUrl?: string | null;
    errorMessage?: string | null;
    startupTelemetry?: RuntimeStartupTelemetry;
  };

  const ok = await reportRuntimeHostState(sessionId, tabId, state, { port, previewUrl, errorMessage, startupTelemetry });
  if (!ok) {
    return NextResponse.json({ error: "Not the current runtime host." }, { status: 409 });
  }
  return NextResponse.json({ success: true });
}
