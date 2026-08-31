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

  /**
   * Phase 40 §5: one command, one lifecycle, one terminal state. The
   * server can now abandon a timed-out command by writing a terminal
   * `error` (see commandRelay.ts's reconcileOnTimeout). If the host tab
   * then reports a late result for that same command, it must NOT
   * silently overwrite the terminal state - the waiting caller has
   * already been told it failed and has moved on, so resurrecting the
   * doc would make a command look freshly successful long after its
   * result could be used. Transactional so a late report and the
   * abandonment can never interleave into a torn state.
   *
   * "started" is explicitly not terminal here: a background command
   * legitimately reports started and then done.
   */
  const applied = await adminDb.runTransaction(async (tx) => {
    const snap = await tx.get(commandRef);
    const current = snap.data() as RuntimeCommand | undefined;
    if (!current) return false;
    if (current.status === "done" || current.status === "error") return false;

    tx.update(commandRef, {
      status: body.status,
      result: body.result ?? null,
      errorMessage: body.errorMessage ?? null,
      completedAt: Date.now(),
    });
    return true;
  });

  // 200 either way: a late report is a normal, expected race, not a
  // client error - but `applied` tells the caller what actually happened.
  return NextResponse.json({ success: true, applied });
}
