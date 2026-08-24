import { useEffect, useState } from "react";
import { Loader2, RotateCcw, CircleAlert } from "lucide-react";

import { deriveAgentStatus } from "@/lib/agent/agentStatus";
import { derivePreviewState } from "@/lib/preview/previewState";

import type { AgentTurn, RuntimeHost } from "@/types/session";

/**
 * Phase 30 Part 3/12: the ONE reusable "what's happening right now"
 * badge - used by WorkspaceHeader (compact) and ChatPanel (compact,
 * inline). Combines the two real signals that exist (deriveAgentStatus
 * for the agent loop, derivePreviewState for the runtime) into a
 * single concise line, with recovery taking priority when it's
 * happening - a user needs to know the preview is being restored more
 * than they need the granular "writing files" detail underneath it.
 * Never duplicates the full activity feed - this is a status surface,
 * not a second timeline.
 */
export function AgentStatusBadge({ turn, host, className = "" }: { turn: AgentTurn | null; host: RuntimeHost | null; className?: string }) {
  const agent = deriveAgentStatus(turn);

  // React forbids Date.now() during render (impure) - `now` is real
  // state instead, ticked only while it could actually matter (a
  // "crashed" host approaching the recovery grace period - see
  // previewState.ts). Every other host/turn change already re-renders
  // this component via its own props, so no timer runs the rest of
  // the time.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (host?.state !== "crashed") return;
    const id = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(id);
  }, [host?.state]);

  // The header doesn't track the fine-grained iframe `load` signal
  // PreviewPane owns for its own rich scene - "running" is a coarse
  // but honest enough signal for a compact status line (it already
  // means the backend confirmed a real response, per previewState.ts's
  // own doc comment).
  const preview = derivePreviewState(host, host?.state === "running", now);

  if (preview.state === "recovering" || preview.state === "error") {
    return (
      <span className={`flex items-center gap-1.5 text-xs ${preview.state === "error" ? "text-danger" : "text-fg-muted"} ${className}`}>
        {preview.state === "recovering" ? (
          <RotateCcw className="h-3 w-3 animate-spin text-accent" strokeWidth={2.5} style={{ animationDuration: "2s" }} />
        ) : (
          <CircleAlert className="h-3 w-3" strokeWidth={2.5} />
        )}
        {preview.state === "recovering" ? "Restoring preview" : "Needs attention"}
      </span>
    );
  }

  if (agent.status === "idle") {
    return (
      <span className={`flex items-center gap-1.5 text-xs text-fg-muted ${className}`}>
        <span className="h-2 w-2 rounded-full bg-success" />
        Ready
      </span>
    );
  }

  if (!agent.active) {
    const isBlocked = agent.status === "blocked";
    return (
      <span className={`flex items-center gap-1.5 text-xs ${isBlocked ? "text-warning" : "text-fg-muted"} ${className}`}>
        {isBlocked ? <CircleAlert className="h-3 w-3" strokeWidth={2.5} /> : <span className="h-2 w-2 rounded-full bg-success" />}
        {isBlocked ? "Needs attention" : "Ready"}
      </span>
    );
  }

  return (
    <span className={`flex items-center gap-1.5 text-xs text-fg-muted ${className}`}>
      <Loader2 className="h-3 w-3 animate-spin text-accent" strokeWidth={2.5} />
      {agent.label}
      {agent.detail && <span className="text-fg-subtle">· {agent.detail}</span>}
    </span>
  );
}
