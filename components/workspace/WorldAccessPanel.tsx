"use client";

import { useEffect, useState } from "react";
import { Check, Globe, X } from "lucide-react";

import { authedFetch } from "@/lib/firebase/authedFetch";
import { isProjectWorthy } from "@/lib/projects/isProjectWorthy";

import type { Session, SessionFeedback } from "@/types/session";

interface Props {
  sessionId: string;
  session: Session | null;
  onClose: () => void;
  onProposalCreated: (proposalSessionId: string) => void;
}

function formatViewport(v?: { width: number; height: number }): string {
  if (!v) return "";
  return v.width < 640 ? `Mobile · ${v.width}×${v.height}` : `Desktop · ${v.width}×${v.height}`;
}

/**
 * Phase 38 STEP 1/5/6: one summoned panel, same dropdown precedent as
 * CheckpointPanel/ArtifactsPanel - not two new header buttons. Does
 * both jobs the brief asks for (the on/off toggle, and the incoming-
 * feedback review list) since they're one coherent "world access"
 * concern, and a second button would be exactly the header clutter the
 * brief's UX principles warn against.
 */
export function WorldAccessPanel({ sessionId, session, onClose, onProposalCreated }: Props) {
  const [worldAccess, setWorldAccess] = useState(session?.worldAccess ?? false);
  const [toggling, setToggling] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);

  const [feedback, setFeedback] = useState<SessionFeedback[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (!worldAccess) return;
    authedFetch(`/api/sessions/${sessionId}/feedback`)
      .then((res) => (res.ok ? res.json() : { feedback: [] }))
      .then((body) => setFeedback(body.feedback))
      .catch(() => setFeedback([]));
  }, [sessionId, worldAccess]);

  async function toggle(next: boolean) {
    setToggling(true);
    setToggleError(null);
    const res = await authedFetch(`/api/sessions/${sessionId}/world-access`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: next }),
    });
    if (res.ok) {
      setWorldAccess(next);
    } else {
      const body = await res.json().catch(() => ({}));
      setToggleError(body.error ?? "Couldn't change that - try again.");
    }
    setToggling(false);
  }

  async function copyPublicLink() {
    await navigator.clipboard.writeText(`${window.location.origin}/p/${sessionId}`);
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 1500);
  }

  async function ignore(feedbackId: string) {
    setBusyId(feedbackId);
    await authedFetch(`/api/sessions/${sessionId}/feedback/${feedbackId}/ignore`, { method: "POST" });
    setFeedback((list) => list?.map((f) => (f.id === feedbackId ? { ...f, status: "ignored" } : f)) ?? null);
    setBusyId(null);
  }

  async function tryWithHuddle(feedbackId: string) {
    setBusyId(feedbackId);
    const res = await authedFetch(`/api/sessions/${sessionId}/feedback/${feedbackId}/try`, { method: "POST" });
    if (res.ok) {
      const { proposalSessionId } = await res.json();
      onProposalCreated(proposalSessionId);
    }
    setBusyId(null);
  }

  const worthy = session ? isProjectWorthy(session) : false;
  const newFeedback = feedback?.filter((f) => f.status === "new") ?? [];
  const otherFeedback = feedback?.filter((f) => f.status !== "new") ?? [];

  return (
    <div className="absolute right-0 top-full z-20 mt-1 w-80 rounded-lg border border-border bg-bg-overlay shadow-lg">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="flex items-center gap-1.5 text-xs font-medium text-fg">
          <Globe className="h-3.5 w-3.5" strokeWidth={1.75} />
          World access
        </span>
        <button onClick={onClose} className="text-fg-subtle hover:text-fg">
          <X className="h-3.5 w-3.5" strokeWidth={2} />
        </button>
      </div>

      <div className="max-h-96 overflow-y-auto">
        <div className="border-b border-border px-3 py-3">
          {!worthy ? (
            <p className="text-xs text-fg-subtle">Once real work has been built here, you can share it with the world.</p>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <span className="text-xs text-fg-subtle">
                  {worldAccess ? "Anyone with the link can try your project and suggest improvements." : "Off - only people you invite can see this."}
                </span>
                <button
                  onClick={() => toggle(!worldAccess)}
                  disabled={toggling}
                  aria-label={worldAccess ? "Turn world access off" : "Turn world access on"}
                  className={`ml-2 shrink-0 rounded-full px-2.5 py-1 text-2xs font-medium disabled:opacity-50 ${
                    worldAccess ? "bg-accent text-accent-fg" : "border border-border text-fg-subtle"
                  }`}
                >
                  {worldAccess ? "ON" : "OFF"}
                </button>
              </div>
              {toggleError && <p className="mt-1.5 text-2xs text-danger">{toggleError}</p>}
              {worldAccess && (
                <button onClick={copyPublicLink} className="mt-2 flex items-center gap-1 text-2xs text-accent hover:underline">
                  {linkCopied ? <Check className="h-3 w-3" strokeWidth={2} /> : null}
                  {linkCopied ? "Link copied" : "Copy public link"}
                </button>
              )}
            </>
          )}
        </div>

        {worldAccess && (
          <div className="px-3 py-2">
            {feedback === null ? (
              <p className="py-3 text-center text-2xs text-fg-subtle">Loading…</p>
            ) : newFeedback.length === 0 && otherFeedback.length === 0 ? (
              <p className="py-3 text-center text-2xs text-fg-subtle">No suggestions yet.</p>
            ) : (
              <ul className="space-y-2">
                {newFeedback.map((f) => (
                  <li key={f.id} className="rounded-md border border-border bg-bg-raised p-2.5">
                    <p className="text-xs text-fg">{f.text}</p>
                    {f.viewport && <p className="mt-1 text-2xs text-fg-subtle">{formatViewport(f.viewport)}</p>}
                    <div className="mt-2 flex items-center justify-end gap-2">
                      <button onClick={() => ignore(f.id)} disabled={busyId === f.id} className="text-2xs text-fg-subtle hover:text-fg disabled:opacity-50">
                        Ignore
                      </button>
                      <button
                        onClick={() => tryWithHuddle(f.id)}
                        disabled={busyId === f.id}
                        className="rounded-full bg-accent px-2.5 py-1 text-2xs font-medium text-accent-fg disabled:opacity-50"
                      >
                        {busyId === f.id ? "Starting…" : "Try with Huddle"}
                      </button>
                    </div>
                  </li>
                ))}
                {otherFeedback.map((f) => (
                  <li key={f.id} className="rounded-md px-2.5 py-1.5 opacity-60">
                    <p className="truncate text-2xs text-fg-subtle">
                      {f.text} · {f.status}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
