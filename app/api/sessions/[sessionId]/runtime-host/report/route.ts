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
  const { tabId, state, port, previewUrl, errorMessage, startupTelemetry, generation } = body as {
    tabId: string;
    // Phase 40 §3: null = write the extras only (e.g. previewUrl) without moving the state machine.
    state: RuntimeState | null;
    port?: number | null;
    previewUrl?: string | null;
    errorMessage?: string | null;
    startupTelemetry?: RuntimeStartupTelemetry;
    // Phase 40 §2: the runtime attempt this report belongs to; a report from a superseded attempt is discarded.
    generation?: number;
  };

  const ok = await reportRuntimeHostState(sessionId, tabId, state ?? null, {
    port,
    previewUrl,
    errorMessage,
    startupTelemetry,
    generation,
  });
  if (!ok) {
    // Also covers a report from a superseded generation - correct to
    // reject, and the client treats it as a no-op rather than an error.
    return NextResponse.json({ error: "Not the current runtime host, or a superseded runtime attempt." }, { status: 409 });
  }
  return NextResponse.json({ success: true });
}
