"use client";

import { useState } from "react";
import { History, RotateCcw, X } from "lucide-react";

import type { CheckpointSummary } from "@/hooks/useCheckpoints";

interface Props {
  checkpoints: CheckpointSummary[];
  onRestore: (checkpointId: string) => Promise<boolean>;
  onClose: () => void;
  disabled: boolean;
  disabledReason?: string;
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function CheckpointPanel({ checkpoints, onRestore, onClose, disabled, disabledReason }: Props) {
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  async function handleConfirm(id: string) {
    setRestoringId(id);
    await onRestore(id);
    setRestoringId(null);
    setConfirmingId(null);
  }

  return (
    <div className="absolute right-0 top-full z-20 mt-1 w-80 rounded-lg border border-border bg-bg-overlay shadow-lg">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="flex items-center gap-1.5 text-xs font-medium text-fg">
          <History className="h-3.5 w-3.5" strokeWidth={1.75} />
          Checkpoints
        </span>
        <button onClick={onClose} className="text-fg-subtle hover:text-fg" aria-label="Close">
          <X className="h-3.5 w-3.5" strokeWidth={2} />
        </button>
      </div>

      {disabled && disabledReason && <p className="border-b border-border px-3 py-2 text-2xs text-fg-subtle">{disabledReason}</p>}

      <ul className="max-h-72 overflow-y-auto p-1.5">
        {checkpoints.length === 0 ? (
          <li className="px-2 py-3 text-xs text-fg-subtle">No checkpoints yet - one is taken automatically before each agent turn.</li>
        ) : (
          checkpoints.map((c) => (
            <li key={c.id} className="rounded px-2 py-1.5 hover:bg-bg-raised">
              <p className="truncate text-xs text-fg" title={c.label}>
                {c.label}
              </p>
              <div className="mt-0.5 flex items-center justify-between">
                <span className="text-2xs text-fg-subtle">
                  {formatTime(c.createdAt)} · {c.fileCount} file{c.fileCount === 1 ? "" : "s"}
                </span>
                {confirmingId === c.id ? (
                  <span className="flex items-center gap-1">
                    <button
                      onClick={() => handleConfirm(c.id)}
                      disabled={restoringId === c.id}
                      className="rounded bg-danger px-1.5 py-0.5 text-2xs font-medium text-white disabled:opacity-50"
                    >
                      {restoringId === c.id ? "Restoring…" : "Confirm"}
                    </button>
                    <button onClick={() => setConfirmingId(null)} className="rounded px-1.5 py-0.5 text-2xs text-fg-muted">
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    onClick={() => setConfirmingId(c.id)}
                    disabled={disabled}
                    className="flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs text-fg-muted hover:bg-bg-overlay hover:text-fg disabled:opacity-30"
                  >
                    <RotateCcw className="h-3 w-3" strokeWidth={2} />
                    Restore
                  </button>
                )}
              </div>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}
