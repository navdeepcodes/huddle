"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, Check, X } from "lucide-react";

import { authedFetch } from "@/lib/firebase/authedFetch";

import type { Session, SessionFeedback } from "@/types/session";

interface Props {
  session: Session;
}

/**
 * Phase 38 STEP 9/10: rendered above the ordinary workspace when this
 * session isProposal - the workspace below it (preview, ChangesSummary,
 * chat) is completely unmodified, so "the working before/after" is
 * mostly already covered for free: the proposal's OWN live preview IS
 * the "after", and the existing ChangesSummary sidebar already shows
 * real evidence (files changed, preview verified) for ANY session's
 * current turn, proposal or not.
 *
 * Deliberately NOT built: a side-by-side "before" screenshot - the
 * WebContainer single-boot-per-tab constraint means the real project's
 * preview isn't simultaneously live in this tab, and the brief
 * explicitly allows skipping screenshot capture if it isn't already
 * trivial. "Keep refining" needs no special handling at all - it's
 * just this session's own ordinary HuddlePanel composer, already
 * rendered below, already pointed at this proposal session's id.
 */
export function ProposalReviewBanner({ session }: Props) {
  const [feedbackText, setFeedbackText] = useState<string | null>(null);
  const [busy, setBusy] = useState<"accept" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!session.proposalOf || !session.proposalFeedbackId) return;
    authedFetch(`/api/sessions/${session.proposalOf}/feedback`)
      .then((res) => (res.ok ? res.json() : { feedback: [] }))
      .then((body: { feedback: SessionFeedback[] }) => {
        const match = body.feedback.find((f) => f.id === session.proposalFeedbackId);
        if (match) setFeedbackText(match.text);
      })
      .catch(() => {});
  }, [session.proposalOf, session.proposalFeedbackId]);

  async function decide(action: "accept" | "reject") {
    setBusy(action);
    setError(null);
    const res = await authedFetch(`/api/sessions/${session.id}/proposal/${action}`, { method: "POST" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "Something went wrong - try again.");
      setBusy(null);
      return;
    }
    setDone(true);
    // Hard navigation, not router.push - same COOP/COEP reasoning as
    // every other /session/[id] entry point in this app.
    window.location.href = `/session/${session.proposalOf}`;
  }

  return (
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border bg-bg-overlay px-4 py-2">
      <div className="min-w-0">
        <p className="text-xs font-medium text-fg">A visitor&rsquo;s suggestion, tried by Huddle - nothing is live yet.</p>
        {feedbackText && <p className="truncate text-2xs text-fg-subtle">&ldquo;{feedbackText}&rdquo;</p>}
        {error && <p className="text-2xs text-danger">{error}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button
          onClick={() => decide("reject")}
          disabled={busy !== null || done}
          className="flex items-center gap-1 rounded-full border border-border px-3 py-1.5 text-xs text-fg-subtle hover:text-fg disabled:opacity-50"
        >
          <X className="h-3 w-3" strokeWidth={2} />
          {busy === "reject" ? "Rejecting…" : "Reject"}
        </button>
        <button
          onClick={() => decide("accept")}
          disabled={busy !== null || done}
          className="flex items-center gap-1 rounded-full bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg disabled:opacity-50"
        >
          <Check className="h-3 w-3" strokeWidth={2} />
          {busy === "accept" ? "Accepting…" : "Accept"}
        </button>
        {session.proposalOf && (
          <a href={`/session/${session.proposalOf}`} className="flex items-center gap-1 text-2xs text-fg-subtle hover:text-fg">
            <ArrowLeft className="h-3 w-3" strokeWidth={2} />
            Back to project
          </a>
        )}
      </div>
    </div>
  );
}
