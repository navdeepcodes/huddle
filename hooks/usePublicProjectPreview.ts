"use client";

import { useEffect, useRef, useState } from "react";

import { bootPublicPreview, type PublicProjectFile } from "@/lib/runtime/publicBoot";

import type { RuntimeState } from "@/types/session";

interface PublicProject {
  name: string;
  description: string | null;
  files: PublicProjectFile[];
}

interface PublicPreviewResult {
  state: RuntimeState | "fetching" | "not_found";
  previewUrl: string | null;
  project: PublicProject | null;
  errorMessage: string | null;
}

/**
 * Phase 38: the public page's own boot hook - fetches this ONE
 * project's files through the new no-auth /api/public/projects/[id]/
 * files route (never Firestore directly, never any authenticated
 * route), then boots a WebContainer local to this visitor's own tab
 * via bootPublicPreview. No runtime-host doc, no claim/heartbeat, no
 * multiplayer coordination - a solo anonymous viewer needs none of it.
 */
export function usePublicProjectPreview(sessionId: string): PublicPreviewResult {
  const [state, setState] = useState<PublicPreviewResult["state"]>("fetching");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [project, setProject] = useState<PublicProject | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    let teardown: (() => void) | null = null;

    async function run() {
      let files: PublicProjectFile[];
      let name: string;
      let description: string | null;
      try {
        const res = await fetch(`/api/public/projects/${sessionId}/files`);
        if (!res.ok) {
          if (!stopped) setState("not_found");
          return;
        }
        const body = await res.json();
        files = body.files;
        name = body.name;
        description = body.description;
      } catch {
        if (!stopped) setState("not_found");
        return;
      }

      if (stopped) return;
      setProject({ name, description, files });
      setState("starting");

      teardown = await bootPublicPreview(files, {
        onStateChange: (nextState, extra) => {
          if (stopped) return;
          setState(nextState);
          if (extra?.errorMessage) setErrorMessage(extra.errorMessage);
        },
        onPreviewUrl: (url) => {
          if (stopped) return;
          setPreviewUrl(url);
        },
      });
    }

    void run();

    return () => {
      stopped = true;
      teardown?.();
    };
  }, [sessionId]);

  return { state, previewUrl, project, errorMessage };
}
