"use client";

import { useState } from "react";
import { Download, Layers, X } from "lucide-react";

import { downloadArtifact } from "@/lib/artifacts/downloadArtifact";
import { ArtifactThumbnail } from "@/components/artifacts/ArtifactThumbnail";
import { ImageLightbox } from "@/components/artifacts/ImageLightbox";

import type { Artifact } from "@/types/session";

interface Props {
  sessionId: string;
  artifacts: Artifact[];
  onClose: () => void;
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function statusLabel(artifact: Artifact): string {
  if (artifact.status === "generating") return "Generating…";
  if (artifact.status === "failed") return artifact.errorMessage ?? "Generation failed";
  if (artifact.type === "presentation") return artifact.metadata?.slideCount ? `${artifact.metadata.slideCount} slides` : "Ready";
  if (artifact.metadata?.width && artifact.metadata?.height) return `${artifact.metadata.width} × ${artifact.metadata.height}`;
  return "Ready";
}

/** Phase 35/36 STEP 10: same dropdown-panel precedent as CheckpointPanel - a small, honest list, never a full asset-management UI. Images get a real thumbnail + fullscreen preview (STEP 10/11); presentations keep the download-only card (no PPTX preview backend, deliberately, per Phase 35). */
export function ArtifactsPanel({ sessionId, artifacts, onClose }: Props) {
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState<Artifact | null>(null);

  async function handleDownload(artifact: Artifact) {
    setDownloadingId(artifact.id);
    setDownloadError(null);
    const extension = artifact.path.split(".").pop() ?? "pptx";
    const ok = await downloadArtifact(sessionId, artifact.id, `${artifact.title}.${extension}`);
    if (!ok) setDownloadError("Couldn't download that file - try again.");
    setDownloadingId(null);
  }

  return (
    <>
      <div className="absolute right-0 top-full z-20 mt-1 w-80 rounded-lg border border-border bg-bg-overlay shadow-lg">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="flex items-center gap-1.5 text-xs font-medium text-fg">
            <Layers className="h-3.5 w-3.5" strokeWidth={1.75} />
            Artifacts
          </span>
          <button onClick={onClose} className="text-fg-subtle hover:text-fg" aria-label="Close">
            <X className="h-3.5 w-3.5" strokeWidth={2} />
          </button>
        </div>

        {downloadError && <p className="border-b border-border px-3 py-2 text-2xs text-danger">{downloadError}</p>}

        <ul className="max-h-72 overflow-y-auto p-1.5">
          {artifacts.length === 0 ? (
            <li className="px-2 py-3 text-xs text-fg-subtle">No artifacts yet - ask Huddle to create a presentation or image.</li>
          ) : (
            artifacts.map((artifact) => (
              <li key={artifact.id} className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-bg-raised">
                {artifact.type === "image" && (
                  <button onClick={() => artifact.status === "ready" && setPreviewing(artifact)} className="shrink-0">
                    <ArtifactThumbnail sessionId={sessionId} artifact={artifact} className="h-8 w-8" />
                  </button>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs text-fg" title={artifact.title}>
                    {artifact.title}
                  </p>
                  <div className="mt-0.5 flex items-center justify-between gap-2">
                    <span className={`truncate text-2xs ${artifact.status === "failed" ? "text-danger" : "text-fg-subtle"}`}>
                      {formatTime(artifact.createdAt)} · {statusLabel(artifact)}
                    </span>
                    {artifact.status === "ready" && (
                      <button
                        onClick={() => handleDownload(artifact)}
                        disabled={downloadingId === artifact.id}
                        className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-2xs text-fg-muted hover:bg-bg-overlay hover:text-fg disabled:opacity-50"
                      >
                        <Download className="h-3 w-3" strokeWidth={2} />
                        {downloadingId === artifact.id ? "…" : "Download"}
                      </button>
                    )}
                  </div>
                </div>
              </li>
            ))
          )}
        </ul>
      </div>

      {previewing && <ImageLightbox sessionId={sessionId} artifact={previewing} onClose={() => setPreviewing(null)} />}
    </>
  );
}
