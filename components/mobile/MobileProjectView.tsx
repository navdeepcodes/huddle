"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { reloadPreview } from "@webcontainer/api";
import { ArrowUp, ChevronLeft, ChevronRight, Circle, Clock, Maximize2, Settings, Square, Users, X } from "lucide-react";

import { useSessionDoc } from "@/hooks/useSessionDoc";
import { useAgentTurn } from "@/hooks/useAgentTurn";
import { useRuntimeHost } from "@/hooks/useRuntimeHost";
import { usePresence } from "@/hooks/usePresence";
import { useCheckpoints } from "@/hooks/useCheckpoints";
import { useHuddleComposer } from "@/hooks/useHuddleComposer";
import { buildUnifiedFeed, type UnifiedFeedItem } from "@/lib/agent/activityFeed";
import { derivePreviewState } from "@/lib/preview/previewState";
import { BuildingPreviewScene } from "@/components/workspace/BuildingPreviewScene";
import { AgentStatusBadge } from "@/components/workspace/AgentStatusBadge";
import { KIND_ICON } from "@/components/workspace/HuddlePanel";
import { cn } from "@/lib/cn";
import { MobilePreviewOverlay } from "@/components/mobile/MobilePreviewOverlay";
import { MobileConversationOverlay } from "@/components/mobile/MobileConversationOverlay";
import { MobileCollaboratorsSheet } from "@/components/mobile/MobileCollaboratorsSheet";
import { MobileShareSettingsSheet } from "@/components/mobile/MobileShareSettingsSheet";

type MobileView = "hub" | "preview" | "conversation";

/**
 * Phase 32: the project hub - output-first per the brief's own
 * hierarchy (header, then a large preview card, then status/activity,
 * then the composer, then deep actions in sheets). Every hook here is
 * the exact same one ProjectWorkspace (desktop) uses - useSessionFiles
 * and the file tree are deliberately NOT imported at all, since mobile
 * never needs them (performance: don't even fetch what the mobile
 * screens never render). Preview and Conversation are full-screen
 * client-state overlays, not separate routes, so this one component
 * keeps owning all the live subscriptions - switching "screens" never
 * re-subscribes or re-fetches anything.
 */
export function MobileProjectView({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const session = useSessionDoc(sessionId);
  const turn = useAgentTurn(sessionId);
  const host = useRuntimeHost(sessionId);
  const presence = usePresence(sessionId);
  const { checkpoints, restore } = useCheckpoints(sessionId, turn?.active);
  const composer = useHuddleComposer(sessionId, turn);

  const [view, setView] = useState<MobileView>("hub");
  const [collabOpen, setCollabOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const items = useMemo(
    () => (turn ? buildUnifiedFeed(turn.log, { active: turn.active, terminationReason: turn.telemetry.terminationReason }) : []),
    [turn]
  );
  const recentItems = items.slice(-2);

  if (view === "preview") return <MobilePreviewOverlay host={host} onBack={() => setView("hub")} />;
  if (view === "conversation") {
    return <MobileConversationOverlay sessionId={sessionId} session={session} turn={turn} onBack={() => setView("hub")} />;
  }

  return (
    <div className="flex min-h-dvh flex-col bg-bg-base">
      <header className="huddle-safe-top flex shrink-0 items-center gap-2 border-b border-border px-3 pb-2.5">
        <Link
          href="/"
          aria-label="Back to home"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-fg-subtle hover:bg-bg-raised hover:text-fg"
        >
          <ChevronLeft className="h-5 w-5" strokeWidth={2} />
        </Link>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-fg">{session?.name ?? "Project"}</p>
          <AgentStatusBadge turn={turn} host={host} className="text-2xs" />
        </div>
        <button
          onClick={() => setCollabOpen(true)}
          aria-label="Collaborators"
          className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-fg-subtle hover:bg-bg-raised hover:text-fg"
        >
          <Users className="h-4.5 w-4.5" strokeWidth={1.75} />
        </button>
        <button
          onClick={() => setSettingsOpen(true)}
          aria-label="Project settings and share"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-fg-subtle hover:bg-bg-raised hover:text-fg"
        >
          <Settings className="h-4.5 w-4.5" strokeWidth={1.75} />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-4 pb-3 pt-4">
        <PreviewCard host={host} onOpen={() => setView("preview")} />

        <button
          onClick={() => setView("conversation")}
          className="mt-4 flex w-full items-start justify-between gap-3 rounded-2xl border border-border bg-bg-raised px-4 py-3.5 text-left active:opacity-80"
        >
          <div className="min-w-0 flex-1">
            <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-fg-subtle">Activity</p>
            {recentItems.length === 0 ? (
              <p className="text-sm text-fg-subtle">{turn?.active ? "Huddle is planning…" : "No activity yet - say what you want built."}</p>
            ) : (
              <div className="space-y-1">
                {recentItems.map((item, i) => (
                  <TeaserLine key={i} item={item} isLive={turn?.active === true && i === recentItems.length - 1} />
                ))}
              </div>
            )}
          </div>
          <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-fg-subtle" strokeWidth={2} />
        </button>
      </div>

      <div className="huddle-safe-bottom shrink-0 border-t border-border">
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
            placeholder={turn?.active ? "Ask for a change… (sends when free)" : "Ask for a change…"}
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

/** The hub's own preview surface - the same live iframe/derivePreviewState the fullscreen overlay uses, sized to a card. Tapping opens the immersive fullscreen view (MobilePreviewOverlay); only one of the two is ever mounted at a time (view state), so there's never a second live preview rendering simultaneously. */
function PreviewCard({ host, onOpen }: { host: import("@/types/session").RuntimeHost | null; onOpen: () => void }) {
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
    const settled = (host?.state === "running" && iframeLoaded) || !host || host.state === "idle";
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
    <button onClick={onOpen} className="block w-full text-left active:opacity-90">
      <div className="relative aspect-[9/12] w-full overflow-hidden rounded-2xl border border-border bg-white">
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
        {/*
         * BuildingPreviewScene for every non-ready state, including
         * recovering/error - NOT PreviewRecoveryScene here specifically,
         * even though it's the "correct" scene for those states
         * elsewhere. PreviewRecoveryScene renders its own real
         * interactive "Try again"/"View details" <button>s, and this
         * whole card is already one big <button> (tap-anywhere opens
         * the fullscreen overlay) - nesting them is invalid HTML
         * (live-reproduced as a React hydration error during this
         * phase's own verification, same bug class fixed in the
         * Activity teaser above). The card is purely navigational; the
         * real recovery controls live in MobilePreviewOverlay's
         * fullscreen view, which correctly renders PreviewRecoveryScene
         * un-nested.
         */}
        {!isReady && (
          <div className="huddle-animate-fade-in absolute inset-0">
            <BuildingPreviewScene label={info.label} detail={info.detail} />
          </div>
        )}
        {isReady && (
          <div className="absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-full bg-black/40 text-white backdrop-blur-sm">
            <Maximize2 className="h-4 w-4" strokeWidth={2} />
          </div>
        )}
      </div>
    </button>
  );
}

/**
 * A single read-only summary line for the hub's Activity teaser -
 * deliberately NOT HuddlePanel's own FeedRow/ActivityRow (which render
 * their own interactive expand/collapse <button> for multi-item
 * entries). Nesting that inside this teaser's own tap-to-open-
 * conversation <button> would be an invalid <button> inside <button>
 * (live-reproduced: a real React hydration error, confirmed via
 * console during this phase's own verification). The full, interactive
 * per-item rendering still happens exactly once, un-nested, inside
 * MobileConversationOverlow - this is only ever a compact preview of
 * the same data.
 */
function TeaserLine({ item, isLive }: { item: UnifiedFeedItem; isLive: boolean }) {
  const text = item.type === "message" ? item.content : item.entry.summary;
  const isError = item.type === "activity" && item.entry.kind === "fixing_error" && !item.entry.ok;
  const Icon = item.type === "activity" ? KIND_ICON[item.entry.kind] : Circle;

  return (
    <p className={cn("flex items-center gap-1.5 truncate text-sm", isError ? "text-danger" : "text-fg-muted")}>
      {isLive ? (
        <span className="huddle-animate-pulse h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
      ) : (
        <Icon className="h-3 w-3 shrink-0 text-fg-subtle" strokeWidth={1.75} />
      )}
      <span className="truncate">{text}</span>
    </p>
  );
}
