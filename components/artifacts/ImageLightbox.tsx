"use client";

import { useState } from "react";
import { Download, X } from "lucide-react";

import { useArtifactImageUrl } from "@/hooks/useArtifactImageUrl";
import { downloadArtifact } from "@/lib/artifacts/downloadArtifact";

import type { Artifact } from "@/types/session";

interface Props {
  sessionId: string;
  artifact: Artifact;
  onClose: () => void;
}

/**
 * Phase 36 STEP 10/13: the one fullscreen preview surface, shared by
 * desktop's ArtifactsPanel and the mobile artifacts sheet - not two
 * separate implementations. Real image, real scaling, a real loading
 * state while the blob fetches, never a fake/placeholder preview.
 */
export function ImageLightbox({ sessionId, artifact, onClose }: Props) {
  const [downloading, setDownloading] = useState(false);
  const url = useArtifactImageUrl(sessionId, artifact.id, artifact.status === "ready");

  async function handleDownload() {
    setDownloading(true);
    await downloadArtifact(sessionId, artifact.id, `${artifact.title}.${artifact.path.split(".").pop() ?? "png"}`);
    setDownloading(false);
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/90 backdrop-blur-sm" onClick={onClose}>
      <div className="flex items-center justify-between px-4 py-3" onClick={(e) => e.stopPropagation()}>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-white">{artifact.title}</p>
          {artifact.metadata?.width && artifact.metadata?.height && (
            <p className="text-xs text-white/60">
              {artifact.metadata.width} × {artifact.metadata.height}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            onClick={handleDownload}
            disabled={downloading}
            className="flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-xs text-white hover:bg-white/20 disabled:opacity-50"
          >
            <Download className="h-3.5 w-3.5" strokeWidth={2} />
            {downloading ? "Downloading…" : "Download"}
          </button>
          <button onClick={onClose} aria-label="Close" className="rounded-full bg-white/10 p-1.5 text-white hover:bg-white/20">
            <X className="h-4 w-4" strokeWidth={2} />
          </button>
        </div>
      </div>

      <div className="flex flex-1 items-center justify-center overflow-hidden px-6 pb-6" onClick={(e) => e.stopPropagation()}>
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element -- a blob: object URL, next/image can't optimize this and doesn't need to.
          <img src={url} alt={artifact.title} className="max-h-full max-w-full rounded-lg object-contain" />
        ) : (
          <div className="huddle-animate-pulse text-sm text-white/60">Loading…</div>
        )}
      </div>
    </div>
  );
}
