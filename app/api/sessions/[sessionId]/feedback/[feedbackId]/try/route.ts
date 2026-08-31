import { NextRequest, NextResponse } from "next/server";

import { getVerifiedUid } from "@/lib/auth/verifyRequest";
import { requireSessionMember } from "@/lib/auth/requireSessionMember";
import { resolveAgentProviders } from "@/lib/agent/providerResolution";
import { runAgentTurn } from "@/lib/agent/loop";
import { getFeedback, updateFeedbackStatus } from "@/lib/feedback/feedbackStore";
import { buildProposalTurnMessage, createProposalSession } from "@/lib/proposals/proposalStore";
import { claimTurnAuthoritative, TurnClaimError } from "@/lib/agent/turnRegistry";

interface Props {
  params: Promise<{ sessionId: string; feedbackId: string }>;
}

/**
 * Phase 38 STEP 6/7/8 - the ONLY place a stranger's feedback can ever
 * trigger real compute, and only because a real project member
 * explicitly clicked "Try with Huddle" here. Everything downstream
 * (isolated proposal session, runAgentTurn) is identical to an ordinary
 * turn - no agent code changes, no weakened safeguards. See
 * proposalStore.ts's own comments for why the agent loop itself needed
 * zero changes to support this.
 */
export async function POST(request: NextRequest, { params }: Props) {
  const { sessionId, feedbackId } = await params;
  const uid = await getVerifiedUid(request);
  if (!uid) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const session = await requireSessionMember(sessionId, uid);
  if (!session) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  const feedback = await getFeedback(sessionId, feedbackId);
  if (!feedback) {
    return NextResponse.json({ error: "Feedback not found." }, { status: 404 });
  }
  if (feedback.status !== "new") {
    return NextResponse.json({ error: `This feedback is already ${feedback.status}.` }, { status: 409 });
  }

  const { providers } = await resolveAgentProviders(uid);
  if (providers.length === 0) {
    return NextResponse.json(
      { error: "No Nemotron API key is configured for your account." },
      { status: 422 }
    );
  }

  const proposal = await createProposalSession(session, feedback);
  await updateFeedbackStatus(feedbackId, "trying", proposal.id);

  // A freshly created proposal session id can never already have an
  // active claim in practice - claiming here keeps the invariant uniform
  // with every other runAgentTurn call site (see sessions/route.ts).
  let turnToken: string;
  try {
    ({ turnToken } = await claimTurnAuthoritative(proposal.id));
  } catch (error) {
    if (error instanceof TurnClaimError) {
      return NextResponse.json({ error: "A turn is already running for this session." }, { status: 409 });
    }
    throw error;
  }

  runAgentTurn(proposal.id, buildProposalTurnMessage(feedback.text), uid, turnToken, false, proposal.memberIds).catch(
    (error) => {
      console.error(`Proposal turn failed for session ${proposal.id}:`, error);
    }
  );

  return NextResponse.json({ proposalSessionId: proposal.id });
}
