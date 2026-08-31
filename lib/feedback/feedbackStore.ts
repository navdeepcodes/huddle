import "server-only";

import { adminDb } from "@/lib/firebase/admin";

import type { SessionFeedback, SessionFeedbackStatus } from "@/types/session";

const MAX_FEEDBACK_LENGTH = 2000;

export function boundFeedbackText(text: string): string {
  return text.trim().slice(0, MAX_FEEDBACK_LENGTH);
}

export async function createFeedback(
  sessionId: string,
  text: string,
  viewport?: { width: number; height: number },
  notifyToken?: string
): Promise<SessionFeedback> {
  const ref = adminDb.collection("sessionFeedback").doc();
  const feedback: SessionFeedback = {
    id: ref.id,
    sessionId,
    text: boundFeedbackText(text),
    status: "new",
    createdAt: Date.now(),
    ...(viewport ? { viewport } : {}),
    ...(notifyToken ? { notifyToken } : {}),
  };
  await ref.set(feedback);
  return feedback;
}

/** Sorted in memory, newest first - same reasoning as listCheckpoints (no composite index deploy for this pass, per-session counts are small). */
export async function listFeedback(sessionId: string): Promise<SessionFeedback[]> {
  const snap = await adminDb.collection("sessionFeedback").where("sessionId", "==", sessionId).get();
  return snap.docs.map((d) => d.data() as SessionFeedback).sort((a, b) => b.createdAt - a.createdAt);
}

/** Mirrors checkpointStore's getCheckpoint - plain auto-id, ownership verified after the read so a feedbackId from a different session can never resolve here. */
export async function getFeedback(sessionId: string, feedbackId: string): Promise<SessionFeedback | null> {
  const snap = await adminDb.collection("sessionFeedback").doc(feedbackId).get();
  if (!snap.exists) return null;
  const feedback = snap.data() as SessionFeedback;
  return feedback.sessionId === sessionId ? feedback : null;
}

export async function updateFeedbackStatus(
  feedbackId: string,
  status: SessionFeedbackStatus,
  proposalSessionId?: string
): Promise<void> {
  await adminDb
    .collection("sessionFeedback")
    .doc(feedbackId)
    .update({ status, ...(proposalSessionId ? { proposalSessionId } : {}) });
}
