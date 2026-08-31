"use client";

import { use, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

import { HuddleMark } from "@/components/brand/HuddleMark";

import type { SessionFeedbackStatus } from "@/types/session";

interface Props {
  params: Promise<{ sessionId: string; feedbackId: string }>;
}

const STATUS_COPY: Record<SessionFeedbackStatus, string> = {
  new: "Still waiting on the creator to look at this.",
  trying: "The creator asked Huddle to try this - check back soon.",
  accepted: "Your suggestion was accepted! It's live now.",
  rejected: "The creator decided not to use this one.",
  ignored: "The creator hasn't picked this one up yet.",
};

/** Phase 38 STEP 11: the whole "notify me" mechanism - a self-serve check, not a push notification. No account, no email service. */
export default function FeedbackStatusPage({ params }: Props) {
  const { sessionId, feedbackId } = use(params);
  // useSearchParams (not window.location.search) - SSR-render-safe, no
  // hydration mismatch, and lets the no-token case be a plain render-time
  // branch below instead of a synchronous setState inside an effect.
  const token = useSearchParams().get("token");
  const [status, setStatus] = useState<SessionFeedbackStatus | "loading" | "not_found">("loading");

  useEffect(() => {
    if (!token) return;
    fetch(`/api/public/projects/${sessionId}/feedback/${feedbackId}/status?token=${encodeURIComponent(token)}`)
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((body) => setStatus(body.status))
      .catch(() => setStatus("not_found"));
  }, [sessionId, feedbackId, token]);

  const resolvedStatus = token ? status : "not_found";

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-bg-base px-6 text-center">
      <HuddleMark size={32} className="text-accent" />
      {resolvedStatus === "loading" && <p className="text-sm text-fg-subtle">Checking…</p>}
      {resolvedStatus === "not_found" && <p className="text-sm text-fg-subtle">We couldn&rsquo;t find that suggestion.</p>}
      {resolvedStatus !== "loading" && resolvedStatus !== "not_found" && <p className="max-w-xs text-sm text-fg">{STATUS_COPY[resolvedStatus]}</p>}
      <a href={`/p/${sessionId}`} className="text-xs text-accent hover:underline">
        Back to the project
      </a>
    </div>
  );
}
