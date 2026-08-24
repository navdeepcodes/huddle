import "server-only";

import { adminDb } from "@/lib/firebase/admin";

import type { Session } from "@/types/session";

/** Shared membership check - mirrors the pattern already used inline in turn/route.ts, extracted since Phase 24 adds several more routes needing the same check. Returns null if the session doesn't exist or uid isn't a member. */
export async function requireSessionMember(sessionId: string, uid: string): Promise<Session | null> {
  const snap = await adminDb.collection("sessions").doc(sessionId).get();
  const session = snap.data() as Session | undefined;
  if (!session || !session.memberIds.includes(uid)) return null;
  return session;
}
