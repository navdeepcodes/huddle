import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { adminDb } from "@/lib/firebase/admin";
import { createFeedback } from "@/lib/feedback/feedbackStore";
import { checkFeedbackRateLimit, getClientIp } from "@/lib/feedback/rateLimit";

import type { Session } from "@/types/session";

interface Props {
  params: Promise<{ sessionId: string }>;
}

const MAX_VIEWPORT_DIMENSION = 20000;

function parseViewport(input: unknown): { width: number; height: number } | undefined {
  if (!input || typeof input !== "object") return undefined;
  const { width, height } = input as { width?: unknown; height?: unknown };
  if (typeof width !== "number" || typeof height !== "number") return undefined;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return undefined;
  if (width <= 0 || height <= 0 || width > MAX_VIEWPORT_DIMENSION || height > MAX_VIEWPORT_DIMENSION) return undefined;
  return { width: Math.round(width), height: Math.round(height) };
}

/**
 * Phase 38 STEP 3/6 hard requirement: this route NEVER imports or calls
 * runAgentTurn, any WebContainer/runtime module, or Qwen vision - a
 * feedback submission is Firestore writes only, cheap and free
 * regardless of volume. The only expensive path in this whole feature
 * is app/api/sessions/[sessionId]/feedback/[feedbackId]/try/route.ts,
 * gated behind a real project member's explicit click.
 */
export async function POST(request: NextRequest, { params }: Props) {
  const { sessionId } = await params;

  const snap = await adminDb.collection("sessions").doc(sessionId).get();
  const session = snap.data() as Session | undefined;
  if (!session || !session.worldAccess) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const ip = getClientIp(request);
  const allowed = await checkFeedbackRateLimit(sessionId, ip);
  if (!allowed) {
    return NextResponse.json({ error: "Too many suggestions from you recently - try again later." }, { status: 429 });
  }

  const body = await request.json();
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text) {
    return NextResponse.json({ error: "text is required." }, { status: 400 });
  }

  const viewport = parseViewport(body?.viewport);
  const notifyToken = body?.notifyMe === true ? randomUUID() : undefined;

  const feedback = await createFeedback(sessionId, text, viewport, notifyToken);
  return NextResponse.json({ id: feedback.id, notifyToken: notifyToken ?? null });
}
