import { NextRequest, NextResponse } from "next/server";

import { getVerifiedUid } from "@/lib/auth/verifyRequest";
import { adminDb } from "@/lib/firebase/admin";
import { runAgentTurn } from "@/lib/agent/loop";
import { isTurnActive } from "@/lib/agent/turnRegistry";
import { resolveAgentProviders } from "@/lib/agent/providerResolution";

import type { Session } from "@/types/session";

interface Props {
  params: Promise<{ sessionId: string }>;
}

/**
 * Sends a follow-up message to an existing session - not exercised by the v1 golden path (one message -> DONE) but needed the moment a user wants to ask for a change after seeing the result.
 *
 * Phase 28 Test D: `request.json()` must be awaited BEFORE the
 * isTurnActive check, not after - live-reproduced that with the
 * original ordering (check, then await request.json(), then call
 * runAgentTurn), two genuinely concurrent requests for the same
 * session could both pass isTurnActive as false, because the request
 * body read is a real yield point and the actual in-memory
 * registration (registerTurn, see loop.ts) didn't happen until well
 * after this route had already returned. With the check moved to be
 * the last synchronous step before the fire-and-forget runAgentTurn
 * call - no `await` in between - Node's single-threaded execution
 * means no other request's JS can run inside that gap, so the second
 * of two truly simultaneous requests always sees the first one's
 * turn as active. See loop.ts's own comment on the matching half of
 * this fix (registerTurn moved before its first await).
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
  // does. Only blocks when truly nothing is usable (see
  // resolveAgentProviders' own doc comment for why a missing personal
  // Nemotron key alone doesn't block the turn while deepseek still
  // works - that's the existing, preserved Phase 15 fallback, not a
  // regression). Deliberately BEFORE the isTurnActive check, not
  // after - see this route's own Phase 28 Test D comment above. Any
  // `await` between isTurnActive and the runAgentTurn call it gates
  // reopens that exact concurrency race, so every check that needs an
  // await has to happen before isTurnActive, never between it and the
  // call.
  const { providers } = await resolveAgentProviders(uid);
  if (providers.length === 0) {
    return NextResponse.json(
      { error: "No Nemotron API key is configured for your account, and no fallback provider is available." },
      { status: 422 }
    );
  }

  const { message } = await request.json();
  if (typeof message !== "string" || !message.trim()) {
    return NextResponse.json({ error: "message is required." }, { status: 400 });
  }

  if (isTurnActive(sessionId)) {
    return NextResponse.json({ error: "A turn is already running for this session." }, { status: 409 });
  }

  runAgentTurn(sessionId, message.trim(), uid, session.memberIds).catch((error) => {
    console.error(`Agent turn failed for session ${sessionId}:`, error);
  });

  return NextResponse.json({ success: true });
}
