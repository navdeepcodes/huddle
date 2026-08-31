import { NextRequest, NextResponse } from "next/server";

import { getVerifiedUid } from "@/lib/auth/verifyRequest";
import { requireSessionMember } from "@/lib/auth/requireSessionMember";
import { acceptProposal } from "@/lib/proposals/proposalStore";
import { updateFeedbackStatus } from "@/lib/feedback/feedbackStore";

interface Props {
  params: Promise<{ sessionId: string }>;
}

/** sessionId here is the PROPOSAL's own id, reviewed from inside /session/[proposalId] - accept copies its files into proposalOf, the only write path back into the real project. */
export async function POST(request: NextRequest, { params }: Props) {
  const { sessionId } = await params;
  const uid = await getVerifiedUid(request);
  if (!uid) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const proposal = await requireSessionMember(sessionId, uid);
  if (!proposal) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }
  if (!proposal.isProposal || !proposal.proposalOf) {
    return NextResponse.json({ error: "Not a proposal session." }, { status: 422 });
  }

  await acceptProposal(proposal);
  if (proposal.proposalFeedbackId) {
    await updateFeedbackStatus(proposal.proposalFeedbackId, "accepted", proposal.id);
  }

  return NextResponse.json({ success: true, realSessionId: proposal.proposalOf });
}
