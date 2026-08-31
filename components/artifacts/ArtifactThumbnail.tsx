"use client";

import { ImageIcon } from "lucide-react";

import { useArtifactImageUrl } from "@/hooks/useArtifactImageUrl";
import { cn } from "@/lib/cn";

import type { Artifact } from "@/types/session";

/** Shared by desktop's ArtifactsPanel and the mobile artifacts sheet - a real thumbnail once the image is ready, a quiet icon placeholder otherwise (never a fake preview image). */
export function ArtifactThumbnail({ sessionId, artifact, className }: { sessionId: string; artifact: Artifact; className?: string }) {
  const url = useArtifactImageUrl(sessionId, artifact.id, artifact.status === "ready");

  return (
    <div className={cn("flex shrink-0 items-center justify-center overflow-hidden rounded-lg bg-bg-raised", className)}>
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element -- a blob: object URL, next/image can't optimize this.
        <img src={url} alt={artifact.title} className="h-full w-full object-cover" />
      ) : (
        <ImageIcon className="h-4 w-4 text-fg-subtle" strokeWidth={1.75} />
      )}
    </div>
  );
}
