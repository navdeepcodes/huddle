import { NextRequest, NextResponse } from "next/server";

import { adminDb } from "@/lib/firebase/admin";
import { listSessionFiles } from "@/lib/files/fileStore";

import type { Session } from "@/types/session";

interface Props {
  params: Promise<{ sessionId: string }>;
}

/**
 * Phase 38: Huddle's first genuinely unauthenticated route - no
 * getVerifiedUid call at all, by design. Authorization is entirely
 * `session.worldAccess === true`, checked here server-side via the
 * Admin SDK (Firestore rules can't help an unauthenticated caller
 * either way - every read rule requires isSignedIn()).
 *
 * Returns only what a visitor's own WebContainer boot needs (name,
 * description, files) - never memberIds, ownerId, chat history,
 * checkpoints, or anything else that would leak private project data
 * per a world-access-off project or a private project entirely.
 */
export async function GET(request: NextRequest, { params }: Props) {
  const { sessionId } = await params;

  const snap = await adminDb.collection("sessions").doc(sessionId).get();
  const session = snap.data() as Session | undefined;
  if (!session || !session.worldAccess) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const files = await listSessionFiles(sessionId);
  return NextResponse.json({
    name: session.name,
    description: session.description ?? null,
    files: files.map((f) => ({ path: f.path, content: f.content, encoding: f.encoding ?? "utf8" })),
  });
}
