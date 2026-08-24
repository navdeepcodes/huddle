import "server-only";

import { FieldValue } from "firebase-admin/firestore";

import { adminDb } from "@/lib/firebase/admin";

import type { Session } from "@/types/session";

/**
 * Phase 27 Part A: the actual gap the audit found - firestore.rules'
 * isSessionMember (and every collection gated on it: sessionFiles,
 * runtimeHost, agentTurns, runtimeCommands, plus /sessions itself)
 * checks `request.auth.uid in memberIds`, and nothing before this
 * existed to add a SECOND, different uid to that array - a session was
 * structurally a single-member array from creation onward. A real
 * second anonymous user opening the same URL got permission-denied on
 * every session-scoped read. No invitation/approval step by design
 * (explicitly out of scope this phase, and "Anonymous users are
 * acceptable") - the session URL itself is the share mechanism; anyone
 * with it can join. Never creates a new session, only appends to the
 * existing one's memberIds - the actual invariant Part A cares about
 * ("must reference the SAME project/session identity").
 */
export async function joinSession(sessionId: string, uid: string): Promise<Session | null> {
  const ref = adminDb.collection("sessions").doc(sessionId);
  const snap = await ref.get();
  if (!snap.exists) return null;

  const session = snap.data() as Session;
  if (session.memberIds.includes(uid)) return session;

  await ref.update({ memberIds: FieldValue.arrayUnion(uid) });
  return { ...session, memberIds: [...session.memberIds, uid] };
}
