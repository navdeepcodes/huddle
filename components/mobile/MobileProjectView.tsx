"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { reloadPreview } from "@webcontainer/api";
import {
  ArrowUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  Clock,
  ExternalLink,
  Maximize2,
  Settings,
  Square,
  Users,
  X,
} from "lucide-react";

import { useSessionDoc } from "@/hooks/useSessionDoc";
import { useAgentTurn } from "@/hooks/useAgentTurn";
import { useRuntimeHost } from "@/hooks/useRuntimeHost";
import { usePresence } from "@/hooks/usePresence";
import { useCheckpoints } from "@/hooks/useCheckpoints";
import { useHuddleComposer } from "@/hooks/useHuddleComposer";
import { buildUnifiedFeed, type ActivityEntry, type UnifiedFeedItem } from "@/lib/agent/activityFeed";
import { derivePreviewState } from "@/lib/preview/previewState";
import { KIND_ICON } from "@/components/workspace/HuddlePanel";
import { cn } from "@/lib/cn";
import { MobilePreviewOverlay } from "@/components/mobile/MobilePreviewOverlay";
import { MobileCollaboratorsSheet } from "@/components/mobile/MobileCollaboratorsSheet";
import { MobileShareSettingsSheet } from "@/components/mobile/MobileShareSettingsSheet";

import type { RuntimeHost } from "@/types/session";

/**
 * Phase 32b: reworked to match the reference screenshots the user
 * finally shared (Replit's mobile app) - the project screen is
 * conversation-first, not preview-first. The activity/chat timeline IS
 * the hub; the live output shows as a "presented output" card inside
 * that same flow (not a separate big card at the top with a small
 * activity teaser underneath it, which is what this file looked like
 * before this rework). Fullscreen Preview is still its own overlay for
 * the immersive view, reached by tapping that card or the persistent
 * "Open" row - same reasoning as before, just restructured around the
 * reference's actual hierarchy. Still the same data/hooks as desktop
 * (buildUnifiedFeed, useHuddleComposer) - only the presentation changed.
 */
export function MobileProjectView({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const session = useSessionDoc(sessionId);
  const turn = useAgentTurn(sessionId);
  const host = useRuntimeHost(sessionId);
  const presence = usePresence(sessionId);
  const { checkpoints, restore } = useCheckpoints(sessionId, turn?.active);
  const composer = useHuddleComposer(sessionId, turn);

  const [previewOpen, setPreviewOpen] = useState(false);
  const [collabOpen, setCollabOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const items = useMemo(
    () => (turn ? buildUnifiedFeed(turn.log, { active: turn.active, terminationReason: turn.telemetry.terminationReason }) : []),
    [turn]
  );
  const rendered = useMemo(() => groupForMobile(items), [items]);
  const hasOutput = Boolean(host?.previewUrl);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items.length, hasOutput]);

  if (previewOpen) return <MobilePreviewOverlay host={host} onBack={() => setPreviewOpen(false)} />;

  return (
    <div className="flex h-dvh flex-col bg-bg-base">
      <header className="huddle-safe-top flex shrink-0 items-center gap-2 border-b border-border px-3 pb-2.5">
        <Link
          href="/"
          aria-label="Back to home"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-fg-subtle hover:bg-bg-raised hover:text-fg"
        >
          <ChevronLeft className="h-5 w-5" strokeWidth={2} />
        </Link>
        <button
          onClick={() => setSettingsOpen(true)}
          className="flex min-w-0 flex-1 items-center gap-1 rounded-full border border-border bg-bg-raised py-2 pl-3.5 pr-2.5 active:opacity-80"
        >
          <span className="truncate text-sm font-medium text-fg">{session?.name ?? "Project"}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-fg-subtle" strokeWidth={2} />
        </button>
        <button
          onClick={() => setCollabOpen(true)}
          aria-label="Collaborators"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-bg-raised text-fg-subtle hover:text-fg"
        >
          <Users className="h-4.5 w-4.5" strokeWidth={1.75} />
        </button>
        <button
          onClick={() => setSettingsOpen(true)}
          aria-label="Project settings and share"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-bg-raised text-fg-subtle hover:text-fg"
        >
          <Settings className="h-4.5 w-4.5" strokeWidth={1.75} />
        </button>
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3">
        {rendered.length === 0 && !hasOutput ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-fg-subtle">
            {turn?.active ? "Huddle is planning…" : "Nothing here yet - say what you want built."}
          </div>
        ) : (
          <div className="space-y-0.5">
            {rendered.map((row, i) =>
              row.type === "message" ? (
                <MessageRow key={i} item={row.item} />
              ) : (
                <ActivityGroupRow key={i} entries={row.entries} isLive={row.isLive} />
              )
            )}
          </div>
        )}

        {hasOutput && <OutputCard host={host} onOpen={() => setPreviewOpen(true)} />}
      </div>

      <div className="huddle-safe-bottom shrink-0 border-t border-border">
        {hasOutput && (
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <button
              onClick={() => setPreviewOpen(true)}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-full bg-bg-raised px-4 py-2.5 text-sm font-medium text-fg active:opacity-80"
            >
              Open {session?.name ? shortName(session.name) : "project"}
            </button>
            <button
              onClick={() => host?.previewUrl && window.open(host.previewUrl, "_blank", "noopener,noreferrer")}
              aria-label="Open in browser"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-bg-raised text-fg-subtle hover:text-fg"
            >
              <ExternalLink className="h-4 w-4" strokeWidth={1.75} />
            </button>
          </div>
        )}

        {composer.queued && (
          <div className="flex items-center justify-between gap-2 border-b border-border bg-bg-raised px-3 py-2 text-xs text-fg-muted">
            <span className="flex min-w-0 items-center gap-1.5">
              <Clock className="h-3 w-3 shrink-0" strokeWidth={2} />
              <span className="truncate">Will send when Huddle is free: &ldquo;{composer.queued}&rdquo;</span>
            </span>
            <span className="flex shrink-0 items-center gap-3">
              <button onClick={composer.editQueued} className="text-fg-subtle hover:text-fg">
                Edit
              </button>
              <button onClick={composer.discardQueued} aria-label="Cancel queued message" className="text-fg-subtle hover:text-danger">
                <X className="h-3.5 w-3.5" strokeWidth={2} />
              </button>
            </span>
          </div>
        )}
        {composer.sendError && <p className="px-3 pt-2 text-xs text-danger">{composer.sendError}</p>}
        <form onSubmit={composer.sendFollowUp} className="flex items-end gap-2 p-3">
          <textarea
            value={composer.followUp}
            onChange={(e) => {
              composer.setFollowUp(e.target.value);
              if (composer.sendError) composer.setSendError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
            rows={1}
            placeholder={turn?.active ? "Make, test, iterate… (sends when free)" : "Make, test, iterate…"}
            disabled={composer.sending}
            className="max-h-28 min-h-11 flex-1 resize-none rounded-2xl border border-border bg-bg-raised px-4 py-2.5 text-base text-fg outline-none placeholder:text-fg-subtle focus:border-border-strong disabled:opacity-50"
          />
          {turn?.active ? (
            <button
              type="button"
              onClick={composer.cancelTurn}
              aria-label="Stop"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-border text-fg-muted hover:bg-bg-raised"
            >
              <Square className="h-4 w-4" strokeWidth={2} />
            </button>
          ) : (
            <button
              type="submit"
              disabled={!composer.followUp.trim() || composer.sending}
              aria-label="Send"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent text-accent-fg transition-transform active:scale-95 disabled:opacity-40"
            >
              <ArrowUp className="h-5 w-5" strokeWidth={2.5} />
            </button>
          )}
        </form>
      </div>

      <MobileCollaboratorsSheet open={collabOpen} onClose={() => setCollabOpen(false)} session={session} presence={presence} />
      <MobileShareSettingsSheet
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        sessionId={sessionId}
        session={session}
        turnActive={turn?.active ?? false}
        checkpoints={checkpoints}
        onRestoreCheckpoint={restore}
        onArchived={() => router.push("/")}
      />
    </div>
  );
}

function shortName(name: string): string {
  const first = name.trim().split(/\s+/).slice(0, 2).join(" ");
  return first.length > 24 ? `${first.slice(0, 24)}…` : first;
}

type MobileRow =
  | { type: "message"; item: Extract<UnifiedFeedItem, { type: "message" }> }
  | { type: "activity-group"; entries: ActivityEntry[]; isLive: boolean };

/**
 * Presentation-only regrouping for mobile - buildUnifiedFeed already
 * merges consecutive SAME-kind tool entries ("Wrote 6 files"), but
 * adjacent DIFFERENT-kind entries (plan, then files, then a command)
 * still arrive as separate items. The reference groups a whole run of
 * tool activity between two messages into one compact "N actions" chip
 * row - this does exactly that, over the same data, without touching
 * buildUnifiedFeed itself (desktop's HuddlePanel still wants the
 * ungrouped per-kind rows).
 */
function groupForMobile(items: UnifiedFeedItem[]): MobileRow[] {
  const rows: MobileRow[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.type === "message") {
      rows.push({ type: "message", item });
      continue;
    }
    const last = rows[rows.length - 1];
    if (last?.type === "activity-group") {
      last.entries.push(item.entry);
      last.isLive = i === items.length - 1;
    } else {
      rows.push({ type: "activity-group", entries: [item.entry], isLive: i === items.length - 1 });
    }
  }
  return rows;
}

function MessageRow({ item }: { item: Extract<UnifiedFeedItem, { type: "message" }> }) {
  const label = item.role === "user" ? "You" : "Huddle";
  return (
    <div className="flex items-start gap-2.5 rounded-xl px-1 py-2.5">
      <span
        className={cn(
          "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full",
          item.role === "user" ? "bg-bg-raised text-fg-subtle" : "bg-accent/15 text-accent"
        )}
      >
        <Circle className="h-1.5 w-1.5 fill-current" strokeWidth={0} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="mb-0.5 text-xs font-medium text-fg-subtle">{label}</p>
        <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-fg">{item.content}</p>
      </div>
    </div>
  );
}

/** A run of tool activity between two messages - one row if there's only one entry, a collapsed icon-chip cluster ("N actions") if there are several, matching the reference's grouped-actions pattern. */
function ActivityGroupRow({ entries, isLive }: { entries: ActivityEntry[]; isLive: boolean }) {
  const [expanded, setExpanded] = useState(false);

  if (entries.length === 1) {
    const entry = entries[0];
    const Icon = KIND_ICON[entry.kind];
    const isError = entry.kind === "fixing_error" && !entry.ok;
    return (
      <div className="flex items-center gap-2 rounded-xl px-1 py-2 text-sm">
        {isLive ? (
          <span className="flex h-5 w-5 shrink-0 items-center justify-center">
            <span className="huddle-animate-pulse h-1.5 w-1.5 rounded-full bg-accent" />
          </span>
        ) : (
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-bg-raised">
            <Icon className={cn("h-3 w-3", isError ? "text-danger" : "text-fg-subtle")} strokeWidth={1.75} />
          </span>
        )}
        <span className={cn("truncate", isError ? "text-danger" : "text-fg-subtle")}>{entry.summary}</span>
      </div>
    );
  }

  return (
    <div className="px-1 py-1">
      <button onClick={() => setExpanded((v) => !v)} className="flex items-center gap-2 rounded-full bg-bg-raised px-2.5 py-1.5">
        <span className="flex items-center -space-x-1">
          {entries.slice(0, 4).map((entry, i) => {
            const Icon = KIND_ICON[entry.kind];
            return (
              <span
                key={i}
                className="flex h-5 w-5 items-center justify-center rounded-full border border-bg-base bg-bg-overlay"
                style={{ zIndex: 4 - i }}
              >
                <Icon className="h-2.5 w-2.5 text-fg-subtle" strokeWidth={2} />
              </span>
            );
          })}
        </span>
        <span className="text-xs text-fg-subtle">
          {isLive && <span className="mr-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent align-middle" />}
          {entries.length} action{entries.length === 1 ? "" : "s"}
        </span>
        <ChevronDown className={cn("h-3 w-3 text-fg-subtle transition-transform", expanded && "rotate-180")} strokeWidth={2} />
      </button>

      {expanded && (
        <div className="huddle-animate-fade-in ml-1 mt-1 space-y-1 border-l border-border pl-3">
          {entries.map((entry, i) => {
            const Icon = KIND_ICON[entry.kind];
            const isError = entry.kind === "fixing_error" && !entry.ok;
            return (
              <div key={i} className="flex items-center gap-1.5 text-xs">
                <Icon className={cn("h-3 w-3 shrink-0", isError ? "text-danger" : "text-fg-subtle")} strokeWidth={1.75} />
                <span className={cn("truncate", isError ? "text-danger" : "text-fg-subtle")}>{entry.summary}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * The reference's "Presented output" card - a real live thumbnail of
 * what Huddle built, embedded at the point in the flow where it's
 * relevant (here: always at the bottom of the current history, since
 * it reflects the CURRENT live state, not one specific past moment).
 * Same live iframe + derivePreviewState this app already uses
 * elsewhere - not a static screenshot (no thumbnail-capture
 * infrastructure exists, and building one is out of scope), so this is
 * always genuinely current, never a stale placeholder image.
 */
function OutputCard({ host, onOpen }: { host: RuntimeHost | null; onOpen: () => void }) {
  const previewFrameRef = useRef<HTMLIFrameElement>(null);
  const [iframeLoaded, setIframeLoaded] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const previewUrl = host?.previewUrl ?? null;
  const [prevPreviewUrl, setPrevPreviewUrl] = useState(previewUrl);
  if (previewUrl !== prevPreviewUrl) {
    setPrevPreviewUrl(previewUrl);
    setIframeLoaded(false);
  }

  useEffect(() => {
    const settled = host?.state === "running" && iframeLoaded;
    if (settled) return;
    const id = setInterval(() => setNow(Date.now()), 2_000);
    return () => clearInterval(id);
  }, [host, iframeLoaded]);

  useEffect(() => {
    if (host?.state === "running" && host.previewUrl && previewFrameRef.current) {
      void reloadPreview(previewFrameRef.current);
    }
  }, [host?.state, host?.previewUrl]);

  const info = derivePreviewState(host, iframeLoaded, now);
  const isReady = info.state === "ready";

  return (
    <div className="mt-3 overflow-hidden rounded-2xl border border-border bg-bg-raised">
      <button onClick={onOpen} className="block w-full text-left active:opacity-90">
        <div className="relative aspect-video w-full overflow-hidden bg-white">
          {host?.previewUrl && (
            <iframe
              ref={previewFrameRef}
              src={host.previewUrl}
              onLoad={() => setIframeLoaded(true)}
              className={`pointer-events-none absolute inset-0 h-full w-full border-0 transition-opacity duration-300 ${isReady ? "opacity-100" : "opacity-0"}`}
              title="Preview"
              tabIndex={-1}
            />
          )}
          {!isReady && (
            <div className="absolute inset-0 flex items-center justify-center bg-bg-overlay">
              <span className="huddle-animate-pulse text-xs text-fg-subtle">{info.label}</span>
            </div>
          )}
          {isReady && (
            <div className="absolute right-2.5 top-2.5 flex h-8 w-8 items-center justify-center rounded-full bg-black/40 text-white backdrop-blur-sm">
              <Maximize2 className="h-3.5 w-3.5" strokeWidth={2} />
            </div>
          )}
        </div>
      </button>
      <div className="flex items-center justify-between gap-2 px-3.5 py-3">
        <span className="flex min-w-0 items-center gap-2">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent">
            <Circle className="h-2 w-2 fill-current" strokeWidth={0} />
          </span>
          <span className="min-w-0">
            <p className="truncate text-sm text-fg">Live preview</p>
            <p className="text-2xs text-fg-subtle">Website</p>
          </span>
        </span>
        <button onClick={onOpen} className="flex shrink-0 items-center gap-1 rounded-lg bg-bg-overlay px-2.5 py-1.5 text-xs text-fg">
          Open
          <ChevronRight className="h-3 w-3" strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}
