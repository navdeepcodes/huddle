"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, ArrowUp, Clock, Square, X } from "lucide-react";

import { useSessionDoc } from "@/hooks/useSessionDoc";
import { useAgentTurn } from "@/hooks/useAgentTurn";
import { useArtifacts } from "@/hooks/useArtifacts";
import { useHuddleComposer } from "@/hooks/useHuddleComposer";
import { buildUnifiedFeed } from "@/lib/agent/activityFeed";
import { isProjectWorthy } from "@/lib/projects/isProjectWorthy";
import { FeedRow } from "@/components/workspace/HuddlePanel";
import { ArtifactThumbnail } from "@/components/artifacts/ArtifactThumbnail";
import { ImageLightbox } from "@/components/artifacts/ImageLightbox";

import type { Artifact } from "@/types/session";

interface Props {
  sessionId: string;
  onContinueInWorkspace: (id: string) => void;
  onDismiss: () => void;
}

/**
 * Phase 37 STEP 2/9: the "no project needed" path made real - a quick
 * question or a one-off image/presentation request stays right here on
 * Home, never hard-navigating into the full workspace. Built entirely
 * from EXISTING primitives (useAgentTurn, buildUnifiedFeed, FeedRow,
 * useArtifacts, ArtifactThumbnail/ImageLightbox) - no new backend, no
 * second conversation system. If the request turns out to be sustained
 * work after all (isProjectWorthy flips true once real files get
 * written), a single "Continue in workspace" affordance appears - the
 * automatic transition STEP 3 asks for, without a blocking dialog.
 *
 * Phase 38 fix: this used to be a one-shot preview of a single
 * exchange - a follow-up meant retyping into the page's OWN top-level
 * composer, which calls createProject again and starts a brand-new,
 * context-free session (the exact gap the Phase 37 report flagged
 * honestly: "Let's build idea #2" landing in a session that had never
 * seen the three ideas). This is a real, continuable chat now - the
 * SAME useHuddleComposer/turn-endpoint HuddlePanel already uses,
 * pointed at this session's own id, so a follow-up actually continues
 * this conversation instead of starting a new one. The project
 * transition is unchanged and still automatic (isProjectWorthy), never
 * triggered by the composer itself - "switch to project only when the
 * user asks to build something" falls out of the agent's own existing
 * behavior (it only ever writes real files when a request warrants
 * building), not a new classification step here.
 */
export function QuickResult({ sessionId, onContinueInWorkspace, onDismiss }: Props) {
  const session = useSessionDoc(sessionId);
  const turn = useAgentTurn(sessionId);
  const { artifacts } = useArtifacts(sessionId, turn?.active);
  const [previewing, setPreviewing] = useState<Artifact | null>(null);
  const { followUp, setFollowUp, sending, sendError, setSendError, queued, sendFollowUp, cancelTurn, editQueued, discardQueued } =
    useHuddleComposer(sessionId, turn);

  const items = useMemo(
    () => (turn ? buildUnifiedFeed(turn.log, { active: turn.active, terminationReason: turn.telemetry.terminationReason }) : []),
    [turn]
  );

  const becameProject = session ? isProjectWorthy(session) : false;

  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items.length]);

  return (
    <div className="huddle-animate-rise-in overflow-hidden rounded-2xl border border-border bg-bg-raised">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <span className="truncate text-sm font-medium text-fg">{session?.name ?? "Huddle"}</span>
        <button onClick={onDismiss} aria-label="Dismiss" className="text-fg-subtle hover:text-fg">
          <X className="h-4 w-4" strokeWidth={2} />
        </button>
      </div>

      <div ref={scrollRef} className="max-h-[28rem] overflow-y-auto p-3">
        {items.length === 0 ? (
          <div className="flex items-center gap-2 px-2 py-4 text-sm text-fg-subtle">
            <span className="huddle-animate-pulse h-1.5 w-1.5 rounded-full bg-accent" />
            Huddle is thinking…
          </div>
        ) : (
          <ul>
            {items.map((item, i) => (
              <FeedRow key={i} item={item} isLast={i === items.length - 1} isLive={turn?.active === true && i === items.length - 1} />
            ))}
          </ul>
        )}

        {artifacts.filter((a) => a.type === "image" && a.status === "ready").length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2 px-2">
            {artifacts
              .filter((a) => a.type === "image" && a.status === "ready")
              .map((artifact) => (
                <button key={artifact.id} onClick={() => setPreviewing(artifact)}>
                  <ArtifactThumbnail sessionId={sessionId} artifact={artifact} className="h-20 w-20" />
                </button>
              ))}
          </div>
        )}
      </div>

      {becameProject && (
        <div className="flex items-center justify-between gap-2 border-t border-border bg-bg-overlay px-4 py-3">
          <span className="text-xs text-fg-subtle">This has become a project.</span>
          <button
            onClick={() => onContinueInWorkspace(sessionId)}
            className="flex items-center gap-1 rounded-full bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg"
          >
            Continue in workspace
            <ArrowRight className="h-3 w-3" strokeWidth={2} />
          </button>
        </div>
      )}

      <div className="border-t border-border">
        {queued && (
          <div className="flex items-center justify-between gap-2 border-b border-border bg-bg-overlay px-3 py-1.5 text-xs text-fg-muted">
            <span className="flex min-w-0 items-center gap-1.5">
              <Clock className="h-3 w-3 shrink-0" strokeWidth={2} />
              <span className="truncate">Will send when Huddle is free: &ldquo;{queued}&rdquo;</span>
            </span>
            <span className="flex shrink-0 items-center gap-2">
              <button onClick={editQueued} className="text-fg-subtle hover:text-fg">
                Edit
              </button>
              <button onClick={discardQueued} aria-label="Cancel queued message" title="Cancel queued message" className="text-fg-subtle hover:text-danger">
                <X className="h-3 w-3" strokeWidth={2} />
              </button>
            </span>
          </div>
        )}
        {sendError && <p className="px-3 pt-2 text-xs text-danger">{sendError}</p>}
        <form onSubmit={sendFollowUp} className="flex gap-1.5 p-2.5">
          <input
            value={followUp}
            onChange={(e) => {
              setFollowUp(e.target.value);
              if (sendError) setSendError(null);
            }}
            placeholder={turn?.active ? "Ask a follow-up… (sends when Huddle is free)" : "Ask a follow-up…"}
            disabled={sending}
            className="flex-1 rounded-md border border-border bg-bg-raised px-2.5 py-1.5 text-xs text-fg outline-none placeholder:text-fg-subtle focus:border-border-strong disabled:opacity-50"
          />
          {turn?.active ? (
            <button
              type="button"
              onClick={cancelTurn}
              aria-label="Stop"
              className="flex items-center justify-center rounded-md border border-border p-1.5 text-fg-muted hover:bg-bg-raised"
            >
              <Square className="h-3.5 w-3.5" strokeWidth={2} />
            </button>
          ) : (
            <button
              type="submit"
              disabled={!followUp.trim() || sending}
              aria-label="Send"
              className="flex items-center justify-center rounded-md bg-accent p-1.5 text-accent-fg disabled:opacity-40"
            >
              <ArrowUp className="h-3.5 w-3.5" strokeWidth={2.5} />
            </button>
          )}
        </form>
      </div>

      {previewing && <ImageLightbox sessionId={sessionId} artifact={previewing} onClose={() => setPreviewing(null)} />}
    </div>
  );
}
