"use client";

import { useEffect, useRef, useState } from "react";

import { authedFetch } from "@/lib/firebase/authedFetch";

import type { AgentTurn } from "@/types/session";

/**
 * Phase 32: extracted from HuddlePanel.tsx (Phase 31's merged
 * activity+chat panel) so the mobile Conversation overlay can share the
 * exact same submit/queue/cancel state machine instead of a second,
 * parallel implementation - "reuse existing HuddlePanel architecture,
 * do NOT create a second agent system" applies to the send/queue logic
 * itself, not just the underlying turn.log data. Desktop's HuddlePanel
 * now consumes this hook too; its own behavior is unchanged - this is
 * a pure relocation, not a rewrite.
 *
 * Phase 28 Part 5's own reasoning still applies: the composer is never
 * disabled outright while a turn is active (a user with something to
 * say must always have somewhere to put it) - submitting while busy
 * queues the message (client-side only) and it fires automatically the
 * moment turn.active flips back to false, watched here rather than
 * polled.
 */
export function useHuddleComposer(sessionId: string, turn: AgentTurn | null) {
  const [followUp, setFollowUp] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [queued, setQueued] = useState<string | null>(null);
  const wasActiveRef = useRef(turn?.active ?? false);

  async function submit(message: string) {
    setSending(true);
    setSendError(null);
    const res = await authedFetch(`/api/sessions/${sessionId}/turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setFollowUp(message);
      setSendError(
        res.status === 409
          ? "Huddle is already working on this project - try again in a moment."
          : (body.error ?? "Couldn't send that - try again.")
      );
    }
    setSending(false);
  }

  useEffect(() => {
    const wasActive = wasActiveRef.current;
    const isActive = turn?.active ?? false;
    wasActiveRef.current = isActive;
    if (wasActive && !isActive && queued) {
      const message = queued;
      setQueued(null);
      void submit(message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turn?.active]);

  async function sendFollowUp(e: React.FormEvent) {
    e.preventDefault();
    if (!followUp.trim() || sending) return;
    const message = followUp.trim();
    setFollowUp("");
    setSendError(null);

    if (turn?.active) {
      setQueued(message);
      return;
    }
    await submit(message);
  }

  async function cancelTurn() {
    await authedFetch(`/api/sessions/${sessionId}/turn/cancel`, { method: "POST" });
  }

  function editQueued() {
    if (queued) setFollowUp(queued);
    setQueued(null);
  }

  /** Distinct from editQueued - discards the queued message outright rather than restoring it to the input for editing. */
  function discardQueued() {
    setQueued(null);
  }

  return {
    followUp,
    setFollowUp,
    sending,
    sendError,
    setSendError,
    queued,
    sendFollowUp,
    cancelTurn,
    editQueued,
    discardQueued,
  };
}
