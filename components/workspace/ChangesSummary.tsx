"use client";

import { useMemo } from "react";
import { Plus, Pencil } from "lucide-react";

import { computeCurrentTurnChanges } from "@/lib/agent/changesSummary";

import type { AgentTurn } from "@/types/session";

interface Props {
  turn: AgentTurn | null;
  checkpointPaths: Set<string> | null;
  onSelectPath: (path: string) => void;
}

/** Section 7: "Changed N files" - no diffs, just the fact and the path, click to open. */
export function ChangesSummary({ turn, checkpointPaths, onSelectPath }: Props) {
  const changes = useMemo(() => (turn ? computeCurrentTurnChanges(turn.log, checkpointPaths) : []), [turn, checkpointPaths]);

  if (changes.length === 0) return null;

  return (
    <div className="border-t border-border px-2.5 py-2">
      <p className="mb-1 text-2xs font-medium uppercase tracking-wide text-fg-subtle">
        Changed {changes.length} file{changes.length === 1 ? "" : "s"}
      </p>
      <ul className="space-y-0.5">
        {changes.map((c) => (
          <li key={c.path}>
            <button
              onClick={() => onSelectPath(c.path)}
              className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-xs text-fg-muted hover:bg-bg-raised"
            >
              {c.status === "added" ? (
                <Plus className="h-3 w-3 shrink-0 text-success" strokeWidth={2.5} />
              ) : (
                <Pencil className="h-3 w-3 shrink-0 text-warning" strokeWidth={2} />
              )}
              <span className="truncate">{c.path}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
