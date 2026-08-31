"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ListTodo,
  FilePlus2,
  Terminal,
  Eye,
  BookOpen,
  AlertTriangle,
  CheckCircle2,
  Circle,
  ChevronRight,
  Square,
  ArrowUp,
  Clock,
  X,
  Presentation as PresentationIcon,
  ImageIcon,
} from "lucide-react";

import { buildUnifiedFeed, type ActivityEntry, type ActivityKind, type UnifiedFeedItem } from "@/lib/agent/activityFeed";
import { deriveCompletionSummary } from "@/lib/agent/completionSummary";
import { cn } from "@/lib/cn";
import { auth } from "@/lib/firebase/client";
import { buildTeammateLabels, labelForUid } from "@/lib/presence/attribution";
import { useHuddleComposer } from "@/hooks/useHuddleComposer";
import { AgentStatusBadge } from "@/components/workspace/AgentStatusBadge";
import { CompletionCard } from "@/components/workspace/CompletionCard";

import type { AgentTurn, RuntimeHost, Session } from "@/types/session";

/** Exported for the mobile Conversation overlay - same row renderers, not a second rendering system. */
export const KIND_ICON: Record<ActivityKind, typeof ListTodo> = {
  planning: ListTodo,
  files: FilePlus2,
  running_command: Terminal,
  inspecting_preview: Eye,
  reading: BookOpen,
  fixing_error: AlertTriangle,
  presentation: PresentationIcon,
  image: ImageIcon,
  completed: CheckCircle2,
};

interface Props {
  sessionId: string;
  session: Session | null;
  turn: AgentTurn | null;
  host: RuntimeHost | null;
  /** For deriveCompletionSummary's changedFiles - same latestPaths ProjectWorkspace already threads to ChangesSummary, not a second checkpoint fetch. */
  checkpointPaths: Set<string> | null;
}

/**
 * Phase 31: activity and chat merged into one panel/timeline - they used
 * to be two stacked asides built from two independently-filtered views
 * over the exact same turn.log. Reading Huddle's own work and talking to
 * it are the same relationship, not two separate surfaces, so they now
 * share one scrollable thread (buildUnifiedFeed) with one input at the
 * bottom - "what Huddle did" and "what was said" interleaved in the
 * order they actually happened, the same shape Cursor/Copilot Chat use.
 * Still never shows raw tool-call arguments or model reasoning text -
 * buildUnifiedFeed produces the exact same pre-summarized activity
 * entries buildActivityFeed always did.
 */
export function HuddlePanel({ sessionId, session, turn, host, checkpointPaths }: Props) {
  const { followUp, setFollowUp, sending, sendError, setSendError, queued, sendFollowUp, cancelTurn, editQueued, discardQueued } =
    useHuddleComposer(sessionId, turn);
  const scrollRef = useRef<HTMLDivElement>(null);

  const selfUid = auth.currentUser?.uid;
  const teammateLabels = useMemo(() => buildTeammateLabels(session?.memberIds ?? [], selfUid), [session?.memberIds, selfUid]);

  const items = useMemo(
    () => (turn ? buildUnifiedFeed(turn.log, { active: turn.active, terminationReason: turn.telemetry.terminationReason }) : []),
    [turn]
  );
  const completion = useMemo(() => deriveCompletionSummary(turn, checkpointPaths, host), [turn, checkpointPaths, host]);

  // Keeps the thread pinned to the latest entry as Huddle works - the
  // one thing a stacked activity-then-chat layout never needed, since
  // each panel was short enough to not require it.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items.length]);

  return (
    <div className="flex h-full flex-col">
      <div className="huddle-panel-header shrink-0 border-b border-border px-3">
        <span className="text-2xs font-medium uppercase tracking-wide text-fg-subtle">Huddle</span>
      </div>

      {/* The live per-row pulse below already says "working" - this compact banner is now reserved for the one thing the feed itself can't show: the runtime silently trying to recover. */}
      {host?.state === "crashed" && (
        <div className="border-b border-border px-3 py-1.5">
          <AgentStatusBadge turn={turn} host={host} />
        </div>
      )}

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-2">
        {items.length === 0 ? (
          turn?.active ? (
            <ul>
              <LiveRow label="Planning" />
            </ul>
          ) : (
            <div className="flex h-full items-center justify-center p-4 text-xs text-fg-subtle">
              Nothing here yet - say what you want built.
            </div>
          )
        ) : (
          <ul>
            {items.map((item, i) => {
              const isLast = i === items.length - 1;
              // The unified feed's own final "completed" row is replaced with the richer,
              // evidence-backed CompletionCard (Phase 33 STEP 4) - same underlying event,
              // just not rendered as a plain activity summary anymore.
              if (isLast && completion && item.type === "activity" && item.entry.kind === "completed") {
                return (
                  <li key={i} className="huddle-animate-rise-in px-2 py-1.5">
                    <CompletionCard summary={completion} />
                  </li>
                );
              }
              return (
                <FeedRow
                  key={i}
                  item={item}
                  isLast={isLast}
                  isLive={turn?.active === true && isLast}
                  selfLabel={item.type === "message" && item.role === "user" ? labelForUid(item.uid, selfUid, teammateLabels) : undefined}
                />
              );
            })}
          </ul>
        )}
      </div>

      <div className="border-t border-border">
        {queued && (
          <div className="flex items-center justify-between gap-2 border-b border-border bg-bg-raised px-2.5 py-1.5 text-xs text-fg-muted">
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
        {sendError && <p className="px-2.5 pt-2 text-xs text-danger">{sendError}</p>}
        <form onSubmit={sendFollowUp} className="flex gap-1.5 p-2.5">
          <input
            value={followUp}
            onChange={(e) => {
              setFollowUp(e.target.value);
              if (sendError) setSendError(null);
            }}
            placeholder={turn?.active ? "Ask for a change… (sends when Huddle is free)" : "Ask for a change…"}
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
    </div>
  );
}

/** Exported for the mobile Conversation overlay. */
export function LiveRow({ label }: { label: string }) {
  return (
    <li className="flex items-start gap-2 rounded px-2 py-1.5 text-xs text-fg-muted">
      <span className="mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center">
        <span className="huddle-animate-pulse h-1.5 w-1.5 rounded-full bg-accent" />
      </span>
      {label}
    </li>
  );
}

/** One row in the unified thread - an activity summary or a chat message, sharing the same icon-rail + connector-line treatment so the whole thing reads as one continuous timeline instead of two visual languages stitched together. Exported for the mobile Conversation overlay - same row renderer, not a second one. */
export function FeedRow({
  item,
  isLast,
  isLive,
  selfLabel,
}: {
  item: UnifiedFeedItem;
  isLast: boolean;
  isLive: boolean;
  selfLabel?: string;
}) {
  if (item.type === "message") {
    const label = item.role === "user" ? (selfLabel ?? "You") : "Huddle";
    return (
      <li className="huddle-animate-rise-in relative flex items-start gap-2 rounded px-2 py-1.5 text-xs">
        {!isLast && <span className="absolute left-[15px] top-6 bottom-0 w-px bg-border" aria-hidden />}
        <span
          className={cn(
            "relative z-10 mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-bg-base text-[8px] font-semibold",
            item.role === "user" ? "text-fg-subtle" : "text-accent"
          )}
        >
          <Circle className="h-1.5 w-1.5 fill-current" strokeWidth={0} />
        </span>
        <div className="min-w-0 flex-1">
          <span className="mb-0.5 block font-medium text-fg-subtle">{label}</span>
          <p className="whitespace-pre-wrap text-fg-muted">{item.content}</p>
        </div>
      </li>
    );
  }

  return <ActivityRow entry={item.entry} isLast={isLast} isLive={isLive} />;
}

function ActivityRow({ entry, isLast, isLive }: { entry: ActivityEntry; isLast: boolean; isLive: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const Icon = KIND_ICON[entry.kind];
  const isFailure = entry.kind === "fixing_error" && !entry.ok;
  // Phase 33 STEP 3/8: an error still at the top of the timeline (isLast, mid-turn) reads as
  // an active problem - danger red. The same error once Huddle has moved past it (superseded by
  // later activity) reads as a handled, historical note - a milder warning tone, not a standing
  // alarm for something already resolved.
  const isActiveFailure = isFailure && isLast;
  const isPastFailure = isFailure && !isLast;
  const expandable = entry.detail.length > 1;

  return (
    <li className="huddle-animate-rise-in relative flex items-start gap-2 rounded px-2 py-1.5 text-xs">
      {!isLast && <span className="absolute left-[15px] top-6 bottom-0 w-px bg-border" aria-hidden />}

      <span className="relative z-10 mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center bg-bg-base">
        {isLive ? (
          <span className="huddle-animate-pulse h-1.5 w-1.5 rounded-full bg-accent" />
        ) : (
          <Icon
            className={cn(
              "h-3.5 w-3.5",
              isActiveFailure ? "text-danger" : isPastFailure ? "text-warning" : entry.kind === "completed" ? "text-success" : "text-fg-subtle"
            )}
            strokeWidth={1.75}
          />
        )}
      </span>

      <div className="min-w-0 flex-1">
        <button
          onClick={() => expandable && setExpanded((v) => !v)}
          disabled={!expandable}
          className={cn(
            "flex w-full items-center gap-1 text-left",
            isActiveFailure ? "text-danger" : isPastFailure ? "text-warning" : entry.kind === "completed" ? "text-fg" : "text-fg-muted"
          )}
        >
          <span className="min-w-0 flex-1 truncate">{entry.summary}</span>
          {expandable && (
            <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", expanded && "rotate-90")} strokeWidth={2} />
          )}
        </button>

        {expandable && expanded && (
          <ul className="huddle-animate-fade-in mt-1 space-y-0.5 border-l border-border pl-2">
            {entry.detail.map((d, i) => (
              <li key={i} className="flex items-center gap-1.5 truncate text-2xs text-fg-subtle">
                <Circle className="h-1.5 w-1.5 shrink-0 fill-current" strokeWidth={0} />
                {d}
              </li>
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}
