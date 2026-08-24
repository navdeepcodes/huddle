"use client";

import { useEffect, useMemo, useRef } from "react";
import { ArrowUp, ChevronLeft, Clock, Square, X } from "lucide-react";

import { buildUnifiedFeed } from "@/lib/agent/activityFeed";
import { auth } from "@/lib/firebase/client";
import { buildTeammateLabels, labelForUid } from "@/lib/presence/attribution";
import { useHuddleComposer } from "@/hooks/useHuddleComposer";
import { FeedRow, LiveRow } from "@/components/workspace/HuddlePanel";

import type { AgentTurn, RuntimeHost, Session } from "@/types/session";

interface Props {
  sessionId: string;
  session: Session | null;
  turn: AgentTurn | null;
  host: RuntimeHost | null;
  onBack: () => void;
}

/**
 * Phase 32: the full-height conversation view - same data (turn.log via
 * buildUnifiedFeed), same submit/queue/cancel state machine
 * (useHuddleComposer), and the exact same row renderers HuddlePanel
 * exports (FeedRow/LiveRow) - a mobile-sized shell around identical
 * logic, not a second agent system. host is only here for a11y parity
 * with HuddlePanel's own crashed-state signature; the hub screen
 * already surfaces the recovery banner prominently, so this view
 * doesn't repeat it.
 */
export function MobileConversationOverlay({ sessionId, session, turn, onBack }: Omit<Props, "host">) {
  const { followUp, setFollowUp, sending, sendError, setSendError, queued, sendFollowUp, cancelTurn, editQueued, discardQueued } =
    useHuddleComposer(sessionId, turn);
  const scrollRef = useRef<HTMLDivElement>(null);

  const selfUid = auth.currentUser?.uid;
  const teammateLabels = useMemo(() => buildTeammateLabels(session?.memberIds ?? [], selfUid), [session?.memberIds, selfUid]);

  const items = useMemo(
    () => (turn ? buildUnifiedFeed(turn.log, { active: turn.active, terminationReason: turn.telemetry.terminationReason }) : []),
    [turn]
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items.length]);

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-bg-base">
      <div className="huddle-safe-top flex shrink-0 items-center gap-2 border-b border-border px-2 pb-2">
        <button
          onClick={onBack}
          aria-label="Back to project"
          className="flex h-11 w-11 items-center justify-center rounded-full text-fg-subtle hover:bg-bg-raised hover:text-fg"
        >
          <ChevronLeft className="h-5 w-5" strokeWidth={2} />
        </button>
        <span className="text-sm font-medium text-fg">Huddle</span>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-2">
        {items.length === 0 ? (
          turn?.active ? (
            <ul>
              <LiveRow label="Planning" />
            </ul>
          ) : (
            <div className="flex h-full items-center justify-center p-6 text-center text-sm text-fg-subtle">
              Nothing here yet - say what you want built.
            </div>
          )
        ) : (
          <ul>
            {items.map((item, i) => (
              <FeedRow
                key={i}
                item={item}
                isLast={i === items.length - 1}
                isLive={turn?.active === true && i === items.length - 1}
                selfLabel={item.type === "message" && item.role === "user" ? labelForUid(item.uid, selfUid, teammateLabels) : undefined}
              />
            ))}
          </ul>
        )}
      </div>

      <div className="huddle-safe-bottom shrink-0 border-t border-border">
        {queued && (
          <div className="flex items-center justify-between gap-2 border-b border-border bg-bg-raised px-3 py-2 text-xs text-fg-muted">
            <span className="flex min-w-0 items-center gap-1.5">
              <Clock className="h-3 w-3 shrink-0" strokeWidth={2} />
              <span className="truncate">Will send when Huddle is free: &ldquo;{queued}&rdquo;</span>
            </span>
            <span className="flex shrink-0 items-center gap-3">
              <button onClick={editQueued} className="text-fg-subtle hover:text-fg">
                Edit
              </button>
              <button onClick={discardQueued} aria-label="Cancel queued message" className="text-fg-subtle hover:text-danger">
                <X className="h-3.5 w-3.5" strokeWidth={2} />
              </button>
            </span>
          </div>
        )}
        {sendError && <p className="px-3 pt-2 text-xs text-danger">{sendError}</p>}
        <form onSubmit={sendFollowUp} className="flex items-end gap-2 p-3">
          <textarea
            value={followUp}
            onChange={(e) => {
              setFollowUp(e.target.value);
              if (sendError) setSendError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
            rows={1}
            placeholder={turn?.active ? "Ask for a change… (sends when free)" : "Ask for a change…"}
            disabled={sending}
            className="max-h-32 min-h-11 flex-1 resize-none rounded-2xl border border-border bg-bg-raised px-4 py-2.5 text-base text-fg outline-none placeholder:text-fg-subtle focus:border-border-strong disabled:opacity-50"
          />
          {turn?.active ? (
            <button
              type="button"
              onClick={cancelTurn}
              aria-label="Stop"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-border text-fg-muted hover:bg-bg-raised"
            >
              <Square className="h-4 w-4" strokeWidth={2} />
            </button>
          ) : (
            <button
              type="submit"
              disabled={!followUp.trim() || sending}
              aria-label="Send"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent text-accent-fg transition-transform active:scale-95 disabled:opacity-40"
            >
              <ArrowUp className="h-5 w-5" strokeWidth={2.5} />
            </button>
          )}
        </form>
      </div>
    </div>
  );
}
