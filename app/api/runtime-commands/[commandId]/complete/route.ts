import { NextRequest, NextResponse } from "next/server";

import { getVerifiedUid } from "@/lib/auth/verifyRequest";
import { adminDb } from "@/lib/firebase/admin";

import type { RuntimeCommand, Session } from "@/types/session";

interface Props {
  params: Promise<{ commandId: string }>;
}

/** The host tab reports a run_command/capture_preview result here - see lib/runtime/commandRelay.ts's doc comment for the full bridge mechanism. */
export async function POST(request: NextRequest, { params }: Props) {
  const { commandId } = await params;
  const uid = await getVerifiedUid(request);
  if (!uid) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const commandRef = adminDb.collection("runtimeCommands").doc(commandId);
  const commandSnap = await commandRef.get();
  if (!commandSnap.exists) {
    return NextResponse.json({ error: "Command not found." }, { status: 404 });
  }
  const command = commandSnap.data() as RuntimeCommand;

  const sessionSnap = await adminDb.collection("sessions").doc(command.sessionId).get();
  const session = sessionSnap.data() as Session | undefined;
  if (!session || !session.memberIds.includes(uid)) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  const body = await request.json();
  await commandRef.update({
    status: body.status,
    result: body.result ?? null,
    errorMessage: body.errorMessage ?? null,
    completedAt: Date.now(),
  });

  return NextResponse.json({ success: true });
}
