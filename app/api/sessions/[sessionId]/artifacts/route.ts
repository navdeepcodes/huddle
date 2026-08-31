import { NextRequest, NextResponse } from "next/server";

import { getVerifiedUid } from "@/lib/auth/verifyRequest";
import { requireSessionMember } from "@/lib/auth/requireSessionMember";
import { listArtifacts } from "@/lib/artifacts/artifactStore";

interface Props {
  params: Promise<{ sessionId: string }>;
}

/** Phase 35: same membership-gated list pattern as checkpoints/route.ts - metadata only, never the file's own bytes (that's the download route's job). */
export async function GET(request: NextRequest, { params }: Props) {
  const { sessionId } = await params;
  const uid = await getVerifiedUid(request);
  if (!uid) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const session = await requireSessionMember(sessionId, uid);
  if (!session) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  const artifacts = await listArtifacts(sessionId);
  return NextResponse.json({ artifacts });
}
