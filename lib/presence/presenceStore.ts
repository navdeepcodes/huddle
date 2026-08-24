import "server-only";

import { adminDb } from "@/lib/firebase/admin";

import type { SessionPresence } from "@/types/session";

/** Two missed heartbeats (client beats every 8s, same cadence as runtimeHost) before an entry reads as stale. */
export const PRESENCE_STALE_MS = 20_000;

function presenceDocId(sessionId: string, uid: string, tabId: string): string {
  return `${sessionId}_${uid}_${tabId}`;
}

/**
 * One doc per (session, human, tab) - deliberately not a single-owner
 * election like runtimeHost (many humans can have a project open at
 * once). Upsert on every heartbeat; staleness is read, not enforced
 * here - see PRESENCE_STALE_MS and listPresence's caller.
 */
export async function heartbeatPresence(sessionId: string, uid: string, tabId: string): Promise<void> {
  const entry: SessionPresence = { sessionId, uid, tabId, heartbeatAt: Date.now() };
  await adminDb.collection("sessionPresence").doc(presenceDocId(sessionId, uid, tabId)).set(entry);
}

export async function leavePresence(sessionId: string, uid: string, tabId: string): Promise<void> {
  await adminDb.collection("sessionPresence").doc(presenceDocId(sessionId, uid, tabId)).delete();
}

/** Only entries heartbeated within PRESENCE_STALE_MS - a stopped tab's doc lingers until it's naturally overwritten or cleaned up, so staleness has to be filtered on read, not assumed absent. */
export async function listActivePresence(sessionId: string): Promise<SessionPresence[]> {
  const snap = await adminDb.collection("sessionPresence").where("sessionId", "==", sessionId).get();
  const now = Date.now();
  return snap.docs
    .map((d) => d.data() as SessionPresence)
    .filter((p) => now - p.heartbeatAt < PRESENCE_STALE_MS);
}
