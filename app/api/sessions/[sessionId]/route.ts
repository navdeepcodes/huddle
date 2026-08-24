import { NextRequest, NextResponse } from "next/server";

import { getVerifiedUid } from "@/lib/auth/verifyRequest";
import { requireSessionMember } from "@/lib/auth/requireSessionMember";
import { adminDb } from "@/lib/firebase/admin";

const MAX_NAME_LENGTH = 80;
const MAX_DESCRIPTION_LENGTH = 500;

interface Props {
  params: Promise<{ sessionId: string }>;
}

/** Phase 24: editable project name/description - previously name was fixed at creation time (first 80 chars of the prompt) and description didn't exist at all. */
export async function PATCH(request: NextRequest, { params }: Props) {
  const { sessionId } = await params;
  const uid = await getVerifiedUid(request);
  if (!uid) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const session = await requireSessionMember(sessionId, uid);
  if (!session) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  const body = await request.json();
  const update: { name?: string; description?: string; archived?: boolean; updatedAt: number } = { updatedAt: Date.now() };

  if (typeof body.name === "string" && body.name.trim()) {
    update.name = body.name.trim().slice(0, MAX_NAME_LENGTH);
  }
  if (typeof body.description === "string") {
    update.description = body.description.trim().slice(0, MAX_DESCRIPTION_LENGTH);
  }
  /** Phase 31: archive/restore from the dashboard - same PATCH endpoint, not a separate route, since it's the same "update session fields" concern. */
  if (typeof body.archived === "boolean") {
    update.archived = body.archived;
  }

  if (Object.keys(update).length === 1) {
    return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
  }

  await adminDb.collection("sessions").doc(sessionId).update(update);
  return NextResponse.json({ success: true });
}
