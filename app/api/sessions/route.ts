import { NextRequest, NextResponse } from "next/server";

import { getVerifiedUid } from "@/lib/auth/verifyRequest";
import { adminDb } from "@/lib/firebase/admin";
import { runAgentTurn } from "@/lib/agent/loop";
import { resolveAgentProviders } from "@/lib/agent/providerResolution";
import { claimTurnAuthoritative, TurnClaimError } from "@/lib/agent/turnRegistry";

import type { Session } from "@/types/session";

const MAX_SESSIONS_LISTED = 50;

/** Phase 24: the home page's project list - every session this uid is a member of, newest first. Anonymous auth persists per-browser, so this is meaningfully "my projects" across repeat visits from the same device. */
export async function GET(request: NextRequest) {
  const uid = await getVerifiedUid(request);
  if (!uid) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  // Sorted/limited in memory, not via Firestore - an array-contains +
  // orderBy query needs a composite index that doesn't exist for this
  // collection, and one user's own project count is small enough that
  // this is cheap. Avoids requiring a Firestore index deploy to the
  // shared production project for this pass.
  const snap = await adminDb.collection("sessions").where("memberIds", "array-contains", uid).get();
  const sessions = snap.docs
    .map((d) => d.data() as Session)
    .filter((s) => !s.archived)
    .sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt))
    .slice(0, MAX_SESSIONS_LISTED);
  return NextResponse.json({ sessions });
}

/** Creates a session and immediately starts the first turn from the message that created it - "New Session" IS "describe what you want built," per the golden path. The turn runs detached; the response returns as soon as the session exists. */
export async function POST(request: NextRequest) {
  const uid = await getVerifiedUid(request);
  if (!uid) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const { message } = await request.json();
  if (typeof message !== "string" || !message.trim()) {
    return NextResponse.json({ error: "message is required." }, { status: 400 });
  }

  // Phase 29 Part 1: same pre-flight check as the follow-up turn route - see that file's own comment.
  const { providers } = await resolveAgentProviders(uid);
  if (providers.length === 0) {
    return NextResponse.json(
      { error: "No Nemotron API key is configured for your account." },
      { status: 422 }
    );
  }

  const ref = adminDb.collection("sessions").doc();
  const now = Date.now();
  const session: Session = {
    id: ref.id,
    name: message.trim().slice(0, 80),
    ownerId: uid,
    memberIds: [uid],
    createdAt: now,
    updatedAt: now,
  };
  await ref.set(session);

  // A freshly minted session id can never already have an active claim
  // in practice, but claiming here anyway keeps the invariant uniform -
  // every runAgentTurn call is backed by a real claim, regardless of
  // which route started it (see turnRegistry.ts's claimTurnAuthoritative).
  let turnToken: string;
  try {
    ({ turnToken } = await claimTurnAuthoritative(session.id));
  } catch (error) {
    if (error instanceof TurnClaimError) {
      return NextResponse.json({ error: "A turn is already running for this session." }, { status: 409 });
    }
    throw error;
  }

  runAgentTurn(session.id, message.trim(), uid, turnToken, false, session.memberIds).catch((error) => {
    console.error(`Agent turn failed for session ${session.id}:`, error);
  });

  return NextResponse.json(session);
}
