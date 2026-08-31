import "server-only";

import { adminDb } from "@/lib/firebase/admin";

/**
 * Phase 38: no rate-limiting infrastructure exists anywhere in Huddle
 * today - this is the minimal version, a fixed-window counter in
 * Firestore (no new backend service). Reused as the ONLY defense
 * between an unauthenticated public feedback route and unbounded write
 * volume, so it must be atomic (a Firestore transaction, not a
 * read-then-write race) even though the volume here is low-stakes
 * compared to the actual expensive path (agent turns), which the owner
 * gates separately via "Try with Huddle".
 */
const WINDOW_MS = 10 * 60_000;
const MAX_PER_WINDOW = 5;

function rateLimitDocId(sessionId: string, ip: string): string {
  return `${sessionId}_${ip.replace(/[^a-zA-Z0-9.:]/g, "_")}`;
}

/** Returns true if the call is allowed (and records it), false if the caller is over the window limit. */
export async function checkFeedbackRateLimit(sessionId: string, ip: string): Promise<boolean> {
  const ref = adminDb.collection("publicFeedbackRateLimit").doc(rateLimitDocId(sessionId, ip));
  const now = Date.now();

  return adminDb.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.data() as { count: number; windowStart: number } | undefined;

    if (!data || now - data.windowStart > WINDOW_MS) {
      tx.set(ref, { count: 1, windowStart: now });
      return true;
    }

    if (data.count >= MAX_PER_WINDOW) return false;

    tx.update(ref, { count: data.count + 1 });
    return true;
  });
}

/** Best-effort caller IP from the standard proxy header - falls back to "unknown" so local dev (no proxy) still exercises the counter logic against one bucket, rather than throwing. Not spoof-proof (a client can set arbitrary headers), which is fine for v1: this is abuse-volume mitigation, not identity. */
export function getClientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return "unknown";
}
