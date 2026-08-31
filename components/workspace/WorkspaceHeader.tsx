"use client";

import { useState } from "react";
import { History, Link2, Check, Layers, Globe } from "lucide-react";

import { authedFetch } from "@/lib/firebase/authedFetch";
import { deriveProjectIdentity } from "@/lib/agent/projectIdentity";
import { CheckpointPanel } from "@/components/workspace/CheckpointPanel";
import { ArtifactsPanel } from "@/components/workspace/ArtifactsPanel";
import { WorldAccessPanel } from "@/components/workspace/WorldAccessPanel";
import { PresenceBar } from "@/components/workspace/PresenceBar";
import { AgentStatusBadge } from "@/components/workspace/AgentStatusBadge";
import type { CheckpointSummary } from "@/hooks/useCheckpoints";

import type { AgentTurn, Artifact, RuntimeHost, Session, SessionPresence } from "@/types/session";

interface Props {
  sessionId: string;
  session: Session | null;
  turn: AgentTurn | null;
  host: RuntimeHost | null;
  presence: SessionPresence[];
  checkpoints: CheckpointSummary[];
  onRestoreCheckpoint: (id: string) => Promise<boolean>;
  artifacts: Artifact[];
}

export function WorkspaceHeader({ sessionId, session, turn, host, presence, checkpoints, onRestoreCheckpoint, artifacts }: Props) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(session?.name ?? "");
  const [description, setDescription] = useState(session?.description ?? "");
  const [checkpointsOpen, setCheckpointsOpen] = useState(false);
  const [artifactsOpen, setArtifactsOpen] = useState(false);
  const [worldOpen, setWorldOpen] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);

  const isWorking = turn?.active ?? false;
  const identity = deriveProjectIdentity(turn?.taskState);

  /** The whole "sharing" model here: anyone with the link and anonymous auth can join (see joinSession.ts) - this is just surfacing that existing capability with a one-click copy, not a new permissions system. */
  async function copyShareLink() {
    await navigator.clipboard.writeText(window.location.href);
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 1500);
  }

  async function save() {
    setEditing(false);
    if (name.trim() === session?.name && description.trim() === (session?.description ?? "")) return;
    await authedFetch(`/api/sessions/${sessionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim(), description: description.trim() }),
    });
  }

  return (
    <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border px-4 py-2.5">
      <div className="min-w-0 flex-1">
        {editing ? (
          <div className="flex flex-col gap-1">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={save}
              onKeyDown={(e) => e.key === "Enter" && save()}
              autoFocus
              className="w-full max-w-md bg-transparent text-sm font-medium text-fg outline-none"
            />
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onBlur={save}
              onKeyDown={(e) => e.key === "Enter" && save()}
              placeholder="Add a description…"
              className="w-full max-w-md bg-transparent text-xs text-fg-subtle outline-none"
            />
          </div>
        ) : (
          <button onClick={() => setEditing(true)} className="block max-w-full text-left" title="Click to edit">
            <span className="block truncate text-sm font-medium text-fg">{session?.name ?? "Session"}</span>
            {session?.description && <span className="block truncate text-xs text-fg-subtle">{session.description}</span>}
          </button>
        )}
        {/* Phase 33 STEP 5: what Huddle currently understands the project to be, from its own tracked objective - not shown while editing, and omitted entirely once no taskState is recorded. */}
        {!editing && identity && (
          <p className="mt-0.5 truncate text-2xs text-fg-subtle">
            {identity.objective}
            {identity.progressLabel && <span className="text-fg-subtle"> · {identity.progressLabel}</span>}
          </p>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-3">
        <PresenceBar session={session} presence={presence} />

        <button
          onClick={copyShareLink}
          aria-label="Copy share link"
          title="Copy share link"
          className="flex items-center gap-1 rounded-md p-1.5 text-fg-subtle hover:bg-bg-raised hover:text-fg"
        >
          {linkCopied ? <Check className="h-3.5 w-3.5 text-success" strokeWidth={2} /> : <Link2 className="h-3.5 w-3.5" strokeWidth={1.75} />}
        </button>

        <div className="relative">
          <button
            onClick={() => setCheckpointsOpen((v) => !v)}
            aria-label="Checkpoints"
            title="Checkpoints"
            className={`flex items-center gap-1 rounded-md p-1.5 hover:bg-bg-raised hover:text-fg ${
              checkpointsOpen ? "bg-bg-raised text-fg" : "text-fg-subtle"
            }`}
          >
            <History className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
          {checkpointsOpen && (
            <CheckpointPanel
              checkpoints={checkpoints}
              onRestore={onRestoreCheckpoint}
              onClose={() => setCheckpointsOpen(false)}
              disabled={isWorking}
              disabledReason={isWorking ? "Cannot restore while the agent is working." : undefined}
            />
          )}
        </div>

        <div className="relative">
          <button
            onClick={() => setArtifactsOpen((v) => !v)}
            aria-label="Artifacts"
            title="Artifacts"
            className={`flex items-center gap-1 rounded-md p-1.5 hover:bg-bg-raised hover:text-fg ${
              artifactsOpen ? "bg-bg-raised text-fg" : "text-fg-subtle"
            }`}
          >
            <Layers className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
          {artifactsOpen && <ArtifactsPanel sessionId={sessionId} artifacts={artifacts} onClose={() => setArtifactsOpen(false)} />}
        </div>

        {!session?.isProposal && (
          <div className="relative">
            <button
              onClick={() => setWorldOpen((v) => !v)}
              aria-label="World access"
              title="World access"
              className={`flex items-center gap-1 rounded-md p-1.5 hover:bg-bg-raised hover:text-fg ${
                worldOpen || session?.worldAccess ? "bg-bg-raised text-fg" : "text-fg-subtle"
              }`}
            >
              <Globe className="h-3.5 w-3.5" strokeWidth={1.75} />
            </button>
            {worldOpen && (
              <WorldAccessPanel
                sessionId={sessionId}
                session={session}
                onClose={() => setWorldOpen(false)}
                onProposalCreated={(proposalSessionId) => {
                  // Deliberately a hard navigation, not router.push - see
                  // app/page.tsx's navigateToSession's own comment:
                  // crossOriginIsolated (WebContainer's SharedArrayBuffer
                  // requirement) is only set on a real document load, not
                  // a client-side SPA transition.
                  window.location.href = `/session/${proposalSessionId}`;
                }}
              />
            )}
          </div>
        )}

        <AgentStatusBadge turn={turn} host={host} />
      </div>
    </header>
  );
}
