"use client";

import { useEffect, useState } from "react";
import { Check, Download, Globe, Laptop, Link2, Presentation, RotateCcw, Trash2 } from "lucide-react";

import { authedFetch } from "@/lib/firebase/authedFetch";
import { downloadArtifact } from "@/lib/artifacts/downloadArtifact";
import { isProjectWorthy } from "@/lib/projects/isProjectWorthy";
import { BottomSheet } from "@/components/mobile/BottomSheet";
import { ArtifactThumbnail } from "@/components/artifacts/ArtifactThumbnail";
import { ImageLightbox } from "@/components/artifacts/ImageLightbox";

import type { CheckpointSummary } from "@/hooks/useCheckpoints";
import type { Artifact, Session, SessionFeedback } from "@/types/session";

interface Props {
  open: boolean;
  onClose: () => void;
  sessionId: string;
  session: Session | null;
  turnActive: boolean;
  checkpoints: CheckpointSummary[];
  onRestoreCheckpoint: (id: string) => Promise<boolean>;
  artifacts: Artifact[];
  onArchived: () => void;
  onProposalCreated: (proposalSessionId: string) => void;
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/**
 * Phase 32: project metadata + the existing management capabilities
 * (rename, description, archive, share link, checkpoints/restore) laid
 * out for touch instead of duplicated - same PATCH /api/sessions/:id
 * and /checkpoints/:id/restore endpoints WorkspaceHeader/CheckpointPanel
 * already use on desktop. The desktop-prompt lives here too, as
 * product guidance ("need the full workspace?"), not an error state.
 */
function artifactStatusLabel(artifact: Artifact): string {
  if (artifact.status === "generating") return "Generating…";
  if (artifact.status === "failed") return artifact.errorMessage ?? "Generation failed";
  if (artifact.type === "presentation") return artifact.metadata?.slideCount ? `${artifact.metadata.slideCount} slides` : "Ready";
  if (artifact.metadata?.width && artifact.metadata?.height) return `${artifact.metadata.width} × ${artifact.metadata.height}`;
  return "Ready";
}

export function MobileShareSettingsSheet({
  open,
  onClose,
  sessionId,
  session,
  turnActive,
  checkpoints,
  onRestoreCheckpoint,
  artifacts,
  onArchived,
  onProposalCreated,
}: Props) {
  const [name, setName] = useState(session?.name ?? "");
  const [description, setDescription] = useState(session?.description ?? "");
  const [savingMeta, setSavingMeta] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState<Artifact | null>(null);

  // Render-time state adjustment (same pattern as PreviewPane.tsx's own
  // previewUrl-reset, not an effect) - local, optimistically-toggleable
  // state that re-syncs the moment the session doc's real value changes.
  const sessionWorldAccess = session?.worldAccess ?? false;
  const [worldAccess, setWorldAccess] = useState(sessionWorldAccess);
  const [prevSessionWorldAccess, setPrevSessionWorldAccess] = useState(sessionWorldAccess);
  if (sessionWorldAccess !== prevSessionWorldAccess) {
    setPrevSessionWorldAccess(sessionWorldAccess);
    setWorldAccess(sessionWorldAccess);
  }

  const [worldToggling, setWorldToggling] = useState(false);
  const [worldError, setWorldError] = useState<string | null>(null);
  const [worldLinkCopied, setWorldLinkCopied] = useState(false);
  const [feedback, setFeedback] = useState<SessionFeedback[] | null>(null);
  const [busyFeedbackId, setBusyFeedbackId] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !worldAccess) return;
    authedFetch(`/api/sessions/${sessionId}/feedback`)
      .then((res) => (res.ok ? res.json() : { feedback: [] }))
      .then((body) => setFeedback(body.feedback))
      .catch(() => setFeedback([]));
  }, [open, worldAccess, sessionId]);

  async function toggleWorldAccess(next: boolean) {
    setWorldToggling(true);
    setWorldError(null);
    const res = await authedFetch(`/api/sessions/${sessionId}/world-access`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: next }),
    });
    if (res.ok) setWorldAccess(next);
    else setWorldError((await res.json().catch(() => ({}))).error ?? "Couldn't change that - try again.");
    setWorldToggling(false);
  }

  async function copyWorldLink() {
    await navigator.clipboard.writeText(`${window.location.origin}/p/${sessionId}`);
    setWorldLinkCopied(true);
    setTimeout(() => setWorldLinkCopied(false), 1500);
  }

  async function ignoreFeedback(feedbackId: string) {
    setBusyFeedbackId(feedbackId);
    await authedFetch(`/api/sessions/${sessionId}/feedback/${feedbackId}/ignore`, { method: "POST" });
    setFeedback((list) => list?.map((f) => (f.id === feedbackId ? { ...f, status: "ignored" } : f)) ?? null);
    setBusyFeedbackId(null);
  }

  async function tryFeedback(feedbackId: string) {
    setBusyFeedbackId(feedbackId);
    const res = await authedFetch(`/api/sessions/${sessionId}/feedback/${feedbackId}/try`, { method: "POST" });
    if (res.ok) onProposalCreated((await res.json()).proposalSessionId);
    setBusyFeedbackId(null);
  }

  const worthy = session ? isProjectWorthy(session) : false;
  const newFeedback = feedback?.filter((f) => f.status === "new") ?? [];

  async function handleDownload(artifact: Artifact) {
    setDownloadingId(artifact.id);
    const extension = artifact.path.split(".").pop() ?? "pptx";
    await downloadArtifact(sessionId, artifact.id, `${artifact.title}.${extension}`);
    setDownloadingId(null);
  }

  async function saveMeta() {
    if (name.trim() === session?.name && description.trim() === (session?.description ?? "")) return;
    setSavingMeta(true);
    await authedFetch(`/api/sessions/${sessionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim(), description: description.trim() }),
    });
    setSavingMeta(false);
  }

  async function copyLink() {
    await navigator.clipboard.writeText(window.location.href);
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 1500);
  }

  async function handleRestore(id: string) {
    setRestoringId(id);
    await onRestoreCheckpoint(id);
    setRestoringId(null);
  }

  async function handleArchive() {
    setArchiving(true);
    const res = await authedFetch(`/api/sessions/${sessionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: true }),
    });
    setArchiving(false);
    if (res.ok) onArchived();
  }

  return (
    <BottomSheet open={open} onClose={onClose} title="Project">
      <div className="max-h-[75vh] space-y-6 overflow-y-auto pb-6">
        <div className="space-y-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={saveMeta}
            placeholder="Project name"
            className="w-full rounded-xl border border-border bg-bg-raised px-3.5 py-3 text-sm text-fg outline-none focus:border-border-strong"
          />
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onBlur={saveMeta}
            placeholder="Add a description…"
            className="w-full rounded-xl border border-border bg-bg-raised px-3.5 py-3 text-sm text-fg-muted outline-none focus:border-border-strong"
          />
          {savingMeta && <p className="px-1 text-xs text-fg-subtle">Saving…</p>}
        </div>

        <button
          onClick={copyLink}
          className="flex w-full items-center justify-between rounded-xl border border-border bg-bg-raised px-3.5 py-3.5 text-left"
        >
          <span className="flex items-center gap-2.5 text-sm text-fg">
            {linkCopied ? <Check className="h-4 w-4 text-success" strokeWidth={2} /> : <Link2 className="h-4 w-4 text-fg-subtle" strokeWidth={1.75} />}
            {linkCopied ? "Link copied" : "Copy share link"}
          </span>
        </button>

        {worthy && (
          <div>
            <p className="mb-2 px-1 text-xs font-medium uppercase tracking-wide text-fg-subtle">World access</p>
            <div className="rounded-xl border border-border bg-bg-raised px-3.5 py-3.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-fg-subtle">
                  {worldAccess ? "Anyone with the link can try your project and suggest improvements." : "Off - only people you invite can see this."}
                </span>
                <button
                  onClick={() => toggleWorldAccess(!worldAccess)}
                  disabled={worldToggling}
                  className={`shrink-0 rounded-full px-3 py-1.5 text-2xs font-medium disabled:opacity-50 ${
                    worldAccess ? "bg-accent text-accent-fg" : "border border-border text-fg-subtle"
                  }`}
                >
                  {worldAccess ? "ON" : "OFF"}
                </button>
              </div>
              {worldError && <p className="mt-1.5 text-2xs text-danger">{worldError}</p>}
              {worldAccess && (
                <button onClick={copyWorldLink} className="mt-2.5 flex items-center gap-1 text-xs text-accent">
                  <Globe className="h-3 w-3" strokeWidth={2} />
                  {worldLinkCopied ? "Link copied" : "Copy public link"}
                </button>
              )}
            </div>

            {worldAccess && newFeedback.length > 0 && (
              <div className="mt-2 space-y-1.5">
                {newFeedback.map((f) => (
                  <div key={f.id} className="rounded-xl border border-border px-3.5 py-3">
                    <p className="text-sm text-fg">{f.text}</p>
                    <div className="mt-2 flex items-center justify-end gap-2">
                      <button
                        onClick={() => ignoreFeedback(f.id)}
                        disabled={busyFeedbackId === f.id}
                        className="rounded-lg px-2.5 py-1.5 text-xs text-fg-subtle disabled:opacity-50"
                      >
                        Ignore
                      </button>
                      <button
                        onClick={() => tryFeedback(f.id)}
                        disabled={busyFeedbackId === f.id}
                        className="rounded-lg bg-accent px-2.5 py-1.5 text-xs font-medium text-accent-fg disabled:opacity-50"
                      >
                        {busyFeedbackId === f.id ? "Starting…" : "Try with Huddle"}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div>
          <p className="mb-2 px-1 text-xs font-medium uppercase tracking-wide text-fg-subtle">Checkpoints</p>
          {checkpoints.length === 0 ? (
            <p className="px-1 text-sm text-fg-subtle">A checkpoint is taken automatically before each turn.</p>
          ) : (
            <div className="space-y-1.5">
              {checkpoints.slice(0, 5).map((c) => (
                <div key={c.id} className="flex items-center justify-between gap-2 rounded-xl border border-border px-3.5 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm text-fg">{c.label}</p>
                    <p className="text-xs text-fg-subtle">
                      {formatTime(c.createdAt)} · {c.fileCount} file{c.fileCount === 1 ? "" : "s"}
                    </p>
                  </div>
                  <button
                    onClick={() => handleRestore(c.id)}
                    disabled={turnActive || restoringId === c.id}
                    className="flex shrink-0 items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs text-fg-muted disabled:opacity-40"
                  >
                    <RotateCcw className="h-3 w-3" strokeWidth={2} />
                    {restoringId === c.id ? "Restoring…" : "Restore"}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <p className="mb-2 px-1 text-xs font-medium uppercase tracking-wide text-fg-subtle">Artifacts</p>
          {artifacts.length === 0 ? (
            <p className="px-1 text-sm text-fg-subtle">Ask Huddle to create a presentation or an image and it&rsquo;ll show up here.</p>
          ) : (
            <div className="space-y-1.5">
              {artifacts.map((artifact) => (
                <div key={artifact.id} className="flex items-center justify-between gap-2.5 rounded-xl border border-border px-3.5 py-3">
                  <button
                    onClick={() => artifact.type === "image" && artifact.status === "ready" && setPreviewing(artifact)}
                    className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                  >
                    {artifact.type === "image" ? (
                      <ArtifactThumbnail sessionId={sessionId} artifact={artifact} className="h-12 w-12" />
                    ) : (
                      <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-bg-raised">
                        <Presentation className="h-4 w-4 text-fg-subtle" strokeWidth={1.75} />
                      </span>
                    )}
                    <div className="min-w-0">
                      <p className="truncate text-sm text-fg">{artifact.title}</p>
                      <p className={`text-xs ${artifact.status === "failed" ? "text-danger" : "text-fg-subtle"}`}>
                        {artifactStatusLabel(artifact)}
                      </p>
                    </div>
                  </button>
                  {artifact.status === "ready" && (
                    <button
                      onClick={() => handleDownload(artifact)}
                      disabled={downloadingId === artifact.id}
                      className="flex shrink-0 items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs text-fg-muted disabled:opacity-40"
                    >
                      <Download className="h-3 w-3" strokeWidth={2} />
                      {downloadingId === artifact.id ? "…" : "Download"}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {previewing && <ImageLightbox sessionId={sessionId} artifact={previewing} onClose={() => setPreviewing(null)} />}

        <div className="flex items-start gap-2.5 rounded-xl border border-border bg-bg-raised px-3.5 py-3.5">
          <Laptop className="mt-0.5 h-4 w-4 shrink-0 text-fg-subtle" strokeWidth={1.75} />
          <p className="text-xs text-fg-subtle">
            Need the full coding workspace? Open Huddle on desktop for collaborative coding, file editing, and the terminal.
          </p>
        </div>

        <div>
          {confirmingArchive ? (
            <div className="flex items-center justify-between gap-2 rounded-xl border border-danger/30 px-3.5 py-3">
              <span className="text-sm text-fg">Archive this project?</span>
              <span className="flex items-center gap-2">
                <button
                  onClick={handleArchive}
                  disabled={archiving}
                  className="rounded-lg bg-danger px-2.5 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                >
                  {archiving ? "Archiving…" : "Archive"}
                </button>
                <button onClick={() => setConfirmingArchive(false)} className="rounded-lg px-2.5 py-1.5 text-xs text-fg-muted">
                  Cancel
                </button>
              </span>
            </div>
          ) : (
            <button
              onClick={() => setConfirmingArchive(true)}
              className="flex w-full items-center gap-2.5 rounded-xl px-3.5 py-3 text-left text-sm text-danger"
            >
              <Trash2 className="h-4 w-4" strokeWidth={1.75} />
              Archive project
            </button>
          )}
        </div>
      </div>
    </BottomSheet>
  );
}
