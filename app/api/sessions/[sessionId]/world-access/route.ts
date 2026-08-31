import { NextRequest, NextResponse } from "next/server";

import { getVerifiedUid } from "@/lib/auth/verifyRequest";
import { adminDb } from "@/lib/firebase/admin";
import { isProjectWorthy } from "@/lib/projects/isProjectWorthy";

import type { Session } from "@/types/session";

interface Props {
  params: Promise<{ sessionId: string }>;
}

/**
 * Phase 38: toggles world access on/off. Deliberately restricted to the
 * true owner (session.ownerId), not the broader memberIds check every
 * other route in this app uses - launching/unlaunching a project to the
 * public internet is a bigger decision than ordinary collaborative
 * editing, and the brief calls this out explicitly ("only project
 * owners can launch/unlaunch").
 *
 * Enforces isProjectWorthy server-side (not just hidden in the UI) - a
 * quick, non-Project session can never be turned public, matching
 * Phase 37's Session != Project model.
 */
export async function POST(request: NextRequest, { params }: Props) {
  const { sessionId } = await params;
  const uid = await getVerifiedUid(request);
  if (!uid) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const { enabled } = await request.json();
  if (typeof enabled !== "boolean") {
    return NextResponse.json({ error: "enabled (boolean) is required." }, { status: 400 });
  }

  const snap = await adminDb.collection("sessions").doc(sessionId).get();
  const session = snap.data() as Session | undefined;
  if (!session || session.ownerId !== uid) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  if (enabled && !isProjectWorthy(session)) {
    return NextResponse.json({ error: "Only a real project with real files can be shared with the world." }, { status: 422 });
  }

  await snap.ref.update({ worldAccess: enabled, updatedAt: Date.now() });
  return NextResponse.json({ worldAccess: enabled });
}
