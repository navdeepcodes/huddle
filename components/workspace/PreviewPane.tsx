"use client";

import { useEffect, useRef, useState } from "react";
import { reloadPreview } from "@webcontainer/api";
import { RefreshCw, ExternalLink, Smartphone, Tablet, Monitor } from "lucide-react";

import { cn } from "@/lib/cn";
import { derivePreviewState } from "@/lib/preview/previewState";
import { BuildingPreviewScene } from "@/components/workspace/BuildingPreviewScene";
import { PreviewRecoveryScene } from "@/components/workspace/PreviewRecoveryScene";

import type { RuntimeHost } from "@/types/session";

interface Props {
  host: RuntimeHost | null;
}

type Viewport = "responsive" | "mobile" | "tablet" | "desktop";
const VIEWPORT_WIDTH: Record<Exclude<Viewport, "responsive">, number> = { mobile: 375, tablet: 768, desktop: 1280 };
const VIEWPORT_PRESETS: Array<{ id: Viewport; icon: typeof Smartphone; label: string }> = [
  { id: "mobile", icon: Smartphone, label: "Mobile width" },
  { id: "tablet", icon: Tablet, label: "Tablet width" },
  { id: "desktop", icon: Monitor, label: "Desktop width" },
];

/**
 * Phase 30: the iframe + reloadPreview logic (WebContainer preview
 * infrastructure itself, untouched) now sits behind a presentation
 * layer (derivePreviewState) instead of a single "isRunning ? iframe :
 * plain text" branch. The iframe is mounted as soon as a previewUrl
 * exists - which per RuntimeHost's own contract only happens once the
 * backend already confirmed a real HTTP response (waitForRealResponse,
 * runtimeSession.ts) - so its own `load` event firing is genuine
 * evidence the page rendered, not a guess; it sits opacity-0 behind
 * the building/recovery scene until then, and crossfades in once it
 * fires. This never delays actual readiness - the crossfade starts
 * the instant the real signal arrives.
 */
export function PreviewPane({ host }: Props) {
  const previewFrameRef = useRef<HTMLIFrameElement>(null);
  const [iframeLoaded, setIframeLoaded] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [viewport, setViewport] = useState<Viewport>("responsive");

  // Render-time state adjustment (React's own recommended pattern for
  // "reset derived state when an input changes" - same discipline as
  // CodeViewer.tsx's FileBody), not an effect: a new previewUrl (fresh
  // server/port after a restart) means a genuinely fresh load cycle -
  // the old iframe's prior `load` no longer speaks for the new one.
  //
  // Phase 30B: live-reproduced an infinite render loop ("Too many
  // re-renders") on every fresh session load - `host` starts `null`
  // before Firestore data arrives, so `host?.previewUrl` is
  // `undefined`, but the initial state below normalized that to
  // `null` via `?? null`. Comparing the RAW (unnormalized) `undefined`
  // against the normalized `null` state is true forever (`undefined
  // !== null` never becomes false), so this fired on every single
  // render while host was still null - exactly the first moment of
  // every page load. Both sides must be normalized the same way
  // before comparing.
  const previewUrl = host?.previewUrl ?? null;
  const [prevPreviewUrl, setPrevPreviewUrl] = useState(previewUrl);
  if (previewUrl !== prevPreviewUrl) {
    setPrevPreviewUrl(previewUrl);
    setIframeLoaded(false);
  }

  // Only ticks while NOT settled - the crashed-state grace period (previewState.ts) needs a live clock; a ready/idle preview doesn't need this timer running at all.
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

  function refresh() {
    if (previewFrameRef.current) void reloadPreview(previewFrameRef.current);
  }

  function openFullscreen() {
    if (host?.previewUrl) window.open(host.previewUrl, "_blank", "noopener,noreferrer");
  }

  function retry() {
    // The safest available action given the frozen runtime architecture
    // (see this phase's own scope constraints) - a fresh page load
    // re-runs the existing runtime-host claim/session flow from
    // scratch, the same real recovery path a manual reload always
    // triggers, rather than inventing a new backend retry mechanism.
    window.location.reload();
  }

  const info = derivePreviewState(host, iframeLoaded, now);
  const isReady = info.state === "ready";

  return (
    <div className="flex h-full flex-col">
      <div className="huddle-panel-header justify-between border-b border-border px-3">
        <span className="truncate text-xs text-fg-muted">{isReady ? host!.previewUrl : "Preview"}</span>
        <div className="flex items-center gap-1">
          <div className="flex items-center gap-0.5 border-r border-border pr-1.5">
            {VIEWPORT_PRESETS.map(({ id, icon: Icon, label }) => (
              <button
                key={id}
                onClick={() => setViewport((v) => (v === id ? "responsive" : id))}
                disabled={!isReady}
                aria-label={label}
                aria-pressed={viewport === id}
                title={label}
                className={cn(
                  "rounded p-1 hover:bg-bg-raised hover:text-fg disabled:opacity-30",
                  viewport === id ? "bg-bg-raised text-fg" : "text-fg-subtle"
                )}
              >
                <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
              </button>
            ))}
          </div>
          <button
            onClick={refresh}
            disabled={!isReady}
            aria-label="Refresh preview"
            title="Refresh preview"
            className="rounded p-1 text-fg-subtle hover:bg-bg-raised hover:text-fg disabled:opacity-30"
          >
            <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
          <button
            onClick={openFullscreen}
            disabled={!isReady}
            aria-label="Open fullscreen"
            title="Open fullscreen"
            className="rounded p-1 text-fg-subtle hover:bg-bg-raised hover:text-fg disabled:opacity-30"
          >
            <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
        </div>
      </div>

      <div
        className={cn(
          "relative min-h-0 flex-1 overflow-auto bg-bg-base",
          viewport !== "responsive" && isReady && "flex justify-center py-4"
        )}
      >
        <div
          className={cn(
            "relative h-full bg-white",
            viewport !== "responsive" && isReady && "shrink-0 overflow-hidden rounded-lg border border-border shadow-lg"
          )}
          style={viewport !== "responsive" && isReady ? { width: VIEWPORT_WIDTH[viewport] } : { width: "100%" }}
        >
          {host?.previewUrl && (
            <iframe
              ref={previewFrameRef}
              src={host.previewUrl}
              onLoad={() => setIframeLoaded(true)}
              className={`absolute inset-0 h-full w-full border-0 transition-opacity duration-300 ${isReady ? "opacity-100" : "pointer-events-none opacity-0"}`}
              title="Preview"
            />
          )}

          {!isReady && (
            <div className="huddle-animate-fade-in absolute inset-0">
              {info.state === "recovering" || info.state === "error" ? (
                <PreviewRecoveryScene state={info.state} label={info.label} detail={info.detail} onRetry={retry} />
              ) : (
                <BuildingPreviewScene label={info.label} detail={info.detail} />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
