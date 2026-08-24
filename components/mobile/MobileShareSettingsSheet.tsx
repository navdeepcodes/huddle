"use client";

import { useState } from "react";
import { Check, Laptop, Link2, RotateCcw, Trash2 } from "lucide-react";

import { authedFetch } from "@/lib/firebase/authedFetch";
import { BottomSheet } from "@/components/mobile/BottomSheet";

import type { CheckpointSummary } from "@/hooks/useCheckpoints";
import type { Session } from "@/types/session";

interface Props {
  open: boolean;
  onClose: () => void;
  sessionId: string;
  session: Session | null;
  turnActive: boolean;
  checkpoints: CheckpointSummary[];
  onRestoreCheckpoint: (id: string) => Promise<boolean>;
  onArchived: () => void;
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
export function MobileShareSettingsSheet({
  open,
  onClose,
  sessionId,
  session,
  turnActive,
  checkpoints,
  onRestoreCheckpoint,
  onArchived,
}: Props) {
  const [name, setName] = useState(session?.name ?? "");
  const [description, setDescription] = useState(session?.description ?? "");
  const [savingMeta, setSavingMeta] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  const [archiving, setArchiving] = useState(false);

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
