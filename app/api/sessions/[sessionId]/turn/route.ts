import { NextRequest, NextResponse } from "next/server";

import { getVerifiedUid } from "@/lib/auth/verifyRequest";
import { adminDb } from "@/lib/firebase/admin";
import { runAgentTurn } from "@/lib/agent/loop";
import { claimTurnAuthoritative, TurnClaimError } from "@/lib/agent/turnRegistry";
import { resolveAgentProviders } from "@/lib/agent/providerResolution";

import type { Session } from "@/types/session";

interface Props {
  params: Promise<{ sessionId: string }>;
}

/**
 * Sends a follow-up message to an existing session - not exercised by the v1 golden path (one message -> DONE) but needed the moment a user wants to ask for a change after seeing the result.
 *
 * Phase 39 (Batch 1): concurrency safety used to depend on a delicate
 * ordering trick (no `await` between an in-memory isTurnActive check
 * and the fire-and-forget runAgentTurn call, relying on Node's
 * single-threaded execution) - see git history for the original
 * "Phase 28 Test D" comment. That trick only ever protected against
 * two requests racing on the SAME process; a process restart or a
 * second server instance could still lose track of an active turn
 * entirely. claimTurnAuthoritative (turnRegistry.ts) replaces it with
 * a real Firestore transaction, which provides the atomicity guarantee
 * across both single- and multi-process cases regardless of how many
 * awaits happen around it - the ordering is no longer safety-critical.
 */
export async function POST(request: NextRequest, { params }: Props) {
  const { sessionId } = await params;
  const uid = await getVerifiedUid(request);
  if (!uid) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const sessionSnap = await adminDb.collection("sessions").doc(sessionId).get();
  const session = sessionSnap.data() as Session | undefined;
  if (!session || !session.memberIds.includes(uid)) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  // Phase 29 Part 1: a Firestore read and an env var check - never a
  // model call - so this costs nothing like the expensive loop itself
  // does. Blocks only when there's genuinely no usable credential: as
  // of 2026-08-28 Nemotron is the only registered provider (see
  // resolveAgentProviders' own doc comment for why the DeepSeek
  // fallback was removed), so this is now reachable whenever neither a
  // personal nor the platform Nemotron key resolves.
  const { providers } = await resolveAgentProviders(uid);
  if (providers.length === 0) {
    return NextResponse.json(
      { error: "No Nemotron API key is configured for your account." },
      { status: 422 }
    );
  }

  const { message } = await request.json();
  if (typeof message !== "string" || !message.trim()) {
    return NextResponse.json({ error: "message is required." }, { status: 400 });
  }

  let turnToken: string;
  try {
    ({ turnToken } = await claimTurnAuthoritative(sessionId));
  } catch (error) {
    if (error instanceof TurnClaimError) {
      return NextResponse.json({ error: "A turn is already running for this session." }, { status: 409 });
    }
    throw error;
  }

  runAgentTurn(sessionId, message.trim(), uid, turnToken, session.hasRealFiles === true, session.memberIds).catch(
    (error) => {
      console.error(`Agent turn failed for session ${sessionId}:`, error);
    }
  );

  return NextResponse.json({ success: true });
}
