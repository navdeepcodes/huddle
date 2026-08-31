import type { TaskState } from "@/types/session";

export interface ProjectIdentity {
  /** The model's own recorded objective (update_progress), truncated for a header line - never a paraphrase. */
  objective: string;
  /** "3 of 5 done" - null when no subgoals were ever tracked (a trivial turn, or before the first update_progress call). */
  progressLabel: string | null;
}

const MAX_OBJECTIVE_LENGTH = 80;

/**
 * Phase 33 STEP 5: "project-aware identity" without a memory system -
 * `taskState` is already client-visible on AgentTurn (a plain Firestore
 * field, see types/session.ts), so this is presentation over data that
 * already exists, reused identically by desktop's WorkspaceHeader and
 * the mobile header pill (STEP 6). Returns null when there's nothing
 * tracked yet, so callers can simply omit the line rather than show an
 * empty one.
 */
export function deriveProjectIdentity(taskState: TaskState | undefined): ProjectIdentity | null {
  if (!taskState?.objective) return null;

  const objective =
    taskState.objective.length > MAX_OBJECTIVE_LENGTH
      ? `${taskState.objective.slice(0, MAX_OBJECTIVE_LENGTH - 1)}…`
      : taskState.objective;

  const total = taskState.subgoals.length;
  const done = taskState.subgoals.filter((s) => s.status === "done").length;
  const progressLabel = total > 0 ? `${done} of ${total} done` : null;

  return { objective, progressLabel };
}
