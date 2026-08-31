import { TERMINATION_LABEL } from "@/lib/agent/activityFeed";
import { computeCurrentTurnChanges, findCurrentTurnEntries, type FileChange } from "@/lib/agent/changesSummary";

import type { AgentTurn, RuntimeHost } from "@/types/session";

export type CompletionStatus = "success" | "partial" | "failed" | "cancelled";

export interface CompletionSummary {
  status: CompletionStatus;
  /** Short headline - reuses activityFeed's own TERMINATION_LABEL text, never a second paraphrase of the same fact. */
  headline: string;
  /** What Huddle actually did, in its own words where it recorded them (done subgoals), falling back to the raw file-change count when no plan was tracked - never invented prose. */
  whatItDid: string[];
  changedFiles: FileChange[];
  /** True only when this turn's own last view_preview call succeeded - never inferred from a build or dev-server state. */
  verified: boolean;
  previewAvailable: boolean;
  /** Subgoals explicitly marked blocked - a real, self-reported limitation, distinct from `remaining`. */
  blocked: string[];
  /** Subgoals still pending/in_progress despite the turn ending - should normally be empty (the loop's own completion gate prevents this outside a bounded nudge budget), surfaced honestly when it isn't. */
  remaining: string[];
}

/**
 * Phase 33: STEP 4's five completion questions (what/succeeded/verified/
 * preview/remaining), answered from evidence that already exists on the
 * client - taskState (subgoals), turn.log (file writes, the last
 * view_preview's own ok flag), and RuntimeHost (preview availability).
 * No new backend field, no model-authored summary trusted at face
 * value - `verified` in particular is never true unless a view_preview
 * tool call in THIS turn's own log actually reported success, precisely
 * because this session's own live verification found the model
 * asserting "verified" in prose while the vision check underneath it
 * was flaky - a prose claim is not evidence, a logged tool result is.
 *
 * Returns null when there's nothing to say yet - the turn is still
 * active, doesn't exist, or produced no tool activity this turn (a
 * pure Q&A exchange with no execution has nothing to "complete").
 */
export function deriveCompletionSummary(
  turn: AgentTurn | null,
  checkpointPaths: Set<string> | null,
  host: RuntimeHost | null
): CompletionSummary | null {
  if (!turn || turn.active) return null;

  const currentTurnEntries = findCurrentTurnEntries(turn.log);
  const hasActivity = currentTurnEntries.some((m) => m.role === "tool");
  if (!hasActivity) return null;

  const reason = turn.telemetry.terminationReason;
  const taskState = turn.taskState;

  const done = taskState?.subgoals.filter((s) => s.status === "done") ?? [];
  const blocked = taskState?.subgoals.filter((s) => s.status === "blocked") ?? [];
  const remaining = taskState?.subgoals.filter((s) => s.status === "pending" || s.status === "in_progress") ?? [];

  const changedFiles = computeCurrentTurnChanges(turn.log, checkpointPaths);

  let lastPreviewOk: boolean | null = null;
  // Phase 35: real artifact-generation evidence, never the model's own
  // prose - only a tool result with ok:true ever contributes here, so
  // a failed create_presentation call can never surface as "created."
  const presentationFacts: string[] = [];
  // Phase 36: same evidence-only rule for create_image/edit_image.
  const imageFacts: string[] = [];
  for (const m of currentTurnEntries) {
    if (m.role === "tool" && m.toolName === "view_preview") lastPreviewOk = m.ok ?? false;
    if (m.role === "tool" && m.toolName === "create_presentation" && m.ok && m.content) {
      presentationFacts.push(m.content);
    }
    if (m.role === "tool" && (m.toolName === "create_image" || m.toolName === "edit_image") && m.ok && m.content) {
      imageFacts.push(m.content);
    }
  }

  const status: CompletionStatus =
    reason === "cancelled"
      ? "cancelled"
      : reason === "internal_error" || reason === "provider_error"
        ? "failed"
        : blocked.length > 0 || remaining.length > 0
          ? "partial"
          : "success";

  const headline =
    (reason && TERMINATION_LABEL[reason]) ?? (status === "success" ? "Completed" : "Stopped");

  const whatItDid = [
    ...(done.length > 0
      ? done.map((s) => s.description)
      : changedFiles.length > 0
        ? [`Updated ${changedFiles.length} file${changedFiles.length === 1 ? "" : "s"}`]
        : []),
    ...presentationFacts,
    ...imageFacts,
  ];

  return {
    status,
    headline,
    whatItDid,
    changedFiles,
    verified: lastPreviewOk === true,
    previewAvailable: Boolean(host?.previewUrl),
    blocked: blocked.map((s) => s.description),
    remaining: remaining.map((s) => s.description),
  };
}
