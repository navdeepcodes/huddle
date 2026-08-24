"use client";

import { use } from "react";
import dynamic from "next/dynamic";

import { useSessionJoin } from "@/hooks/useSessionJoin";
import { useIsMobile } from "@/hooks/useIsMobile";

interface Props {
  params: Promise<{ sessionId: string }>;
}

/**
 * Phase 32: lazy-loaded, not a plain top-level import - the desktop
 * workspace pulls in react-syntax-highlighter (CodeViewer) and the
 * full file-tree machinery, none of which a mobile visitor should ever
 * have in their bundle ("don't load the code editor, file tree... until
 * the user actually requests them"). next/dynamic code-splits each
 * tree into its own chunk; only the one useIsMobile() actually selects
 * ever gets fetched. ssr:false on both is consistent with useIsMobile
 * itself already being client-only (its getServerSnapshot always
 * returns false) - this page was never going to pick a tree before
 * hydration regardless.
 */
const ProjectWorkspace = dynamic(() => import("@/components/workspace/ProjectWorkspace").then((m) => m.ProjectWorkspace), {
  ssr: false,
});
const MobileProjectView = dynamic(() => import("@/components/mobile/MobileProjectView").then((m) => m.MobileProjectView), {
  ssr: false,
});

export default function SessionPage({ params }: Props) {
  const { sessionId } = use(params);
  const joinStatus = useSessionJoin(sessionId);
  const isMobile = useIsMobile();

  if (joinStatus === "joining") {
    return <div className="flex h-screen items-center justify-center text-sm text-fg-subtle">Opening project…</div>;
  }
  if (joinStatus === "not_found") {
    return <div className="flex h-screen items-center justify-center text-sm text-fg-subtle">This project doesn&rsquo;t exist.</div>;
  }
  if (joinStatus === "error") {
    return <div className="flex h-screen items-center justify-center text-sm text-danger">Couldn&rsquo;t open this project. Try reloading.</div>;
  }

  return isMobile ? <MobileProjectView sessionId={sessionId} /> : <ProjectWorkspace sessionId={sessionId} />;
}
