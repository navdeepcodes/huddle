"use client";

import { useEffect, useRef, useState } from "react";
import { reloadPreview } from "@webcontainer/api";
import { ChevronLeft, ExternalLink, RefreshCw } from "lucide-react";

import { derivePreviewState } from "@/lib/preview/previewState";
import { BuildingPreviewScene } from "@/components/workspace/BuildingPreviewScene";
import { PreviewRecoveryScene } from "@/components/workspace/PreviewRecoveryScene";

import type { RuntimeHost } from "@/types/session";

interface Props {
  host: RuntimeHost | null;
  onBack: () => void;
}

/**
 * Phase 32: full-screen immersive preview - one of the most important
 * mobile surfaces per the brief ("one of the most beautiful parts of
 * mobile Huddle"). Deliberately NOT desktop's PreviewPane: no
 * Code/Split toggle, no viewport-preset buttons (mobile IS already a
 * real device viewport - simulating others is a desktop-only concern),
 * just the immersive iframe plus the minimum chrome to navigate/refresh
 * it. Reuses the frozen preview state machine (derivePreviewState) and
 * the exact same BuildingPreviewScene/PreviewRecoveryScene desktop
 * uses - no second preview infrastructure, no second recovery UI.
 */
export function MobilePreviewOverlay({ host, onBack }: Props) {
  const previewFrameRef = useRef<HTMLIFrameElement>(null);
  const [iframeLoaded, setIframeLoaded] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // Same normalize-once discipline as desktop PreviewPane.tsx - see its
  // own doc comment for the exact infinite-render-loop bug this avoids.
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

  function refresh() {
    if (previewFrameRef.current) void reloadPreview(previewFrameRef.current);
  }

  function openFullscreen() {
    if (host?.previewUrl) window.open(host.previewUrl, "_blank", "noopener,noreferrer");
  }

  function retry() {
    window.location.reload();
  }

  const info = derivePreviewState(host, iframeLoaded, now);
  const isReady = info.state === "ready";

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-bg-base">
      <div className="huddle-safe-top flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 pb-2">
        <button
          onClick={onBack}
          aria-label="Back to project"
          className="flex h-11 w-11 items-center justify-center rounded-full text-fg-subtle hover:bg-bg-raised hover:text-fg"
        >
          <ChevronLeft className="h-5 w-5" strokeWidth={2} />
        </button>
        <span className="min-w-0 flex-1 truncate text-center text-xs text-fg-subtle">{isReady ? host!.previewUrl : "Preview"}</span>
        <div className="flex shrink-0 items-center gap-1">
          <button
            onClick={refresh}
            disabled={!isReady}
            aria-label="Refresh preview"
            className="flex h-11 w-11 items-center justify-center rounded-full text-fg-subtle hover:bg-bg-raised hover:text-fg disabled:opacity-30"
          >
            <RefreshCw className="h-4.5 w-4.5" strokeWidth={1.75} />
          </button>
          <button
            onClick={openFullscreen}
            disabled={!isReady}
            aria-label="Open in browser"
            className="flex h-11 w-11 items-center justify-center rounded-full text-fg-subtle hover:bg-bg-raised hover:text-fg disabled:opacity-30"
          >
            <ExternalLink className="h-4.5 w-4.5" strokeWidth={1.75} />
          </button>
        </div>
      </div>

      <div className="relative min-h-0 flex-1 bg-white">
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
  );
}
