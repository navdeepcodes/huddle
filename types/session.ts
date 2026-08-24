import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

export interface Session {
  id: string;
  name: string;
  /** Phase 24: user-editable, optional - unlike `name` (auto-derived from the founding prompt), this is never set automatically. */
  description?: string;
  ownerId: string;
  memberIds: string[];
  createdAt: number;
  /** Phase 31: bumped by any real activity - a file write/delete (agent or user, via fileStore.ts's batch writes) or a rename/description edit. Drives the dashboard's "last activity" and sort order. Equals createdAt until the first real activity. */
  updatedAt: number;
  /** Phase 31: soft-delete for the dashboard's "delete/archive" requirement - hard-deleting a session would mean cascading across sessionFiles/agentTurns/presence/checkpoints/runtimeHosts, real cleanup risk for little benefit over just hiding it. Absent/false means visible. */
  archived?: boolean;
}

export interface SessionFile {
  id: string;
  sessionId: string;
  path: string;
  content: string;
  /** "base64" for binary assets (images, fonts) written as base64 text in
   *  Firestore's string-only content field; decoded back to real bytes
   *  before hitting the WebContainer filesystem. Omitted/"utf8" for
   *  everything else - source code, JSON, CSS. */
  encoding?: "utf8" | "base64";
  updatedAt: number;
  updatedBy: "agent" | "user";
  /** Phase 28: which specific human made this edit, when updatedBy is "user" - same reasoning as TurnMessage.uid. Absent for agent writes. */
  updatedByUid?: string;
}

export type RuntimeState =
  | "idle"
  | "starting"
  | "installing"
  | "running"
  | "crashed"
  /**
   * Phase 17: a bounded wait gave up without positive evidence of
   * either success or failure - distinct from "crashed" (a real error:
   * nonzero exit, a port that opened then stopped answering). Reserved
   * for new bounded-wait code (see lib/runtime/runtimeSession.ts's
   * quickReadinessCheck and lib/preview/viewPreview.ts) - the existing,
   * already-tested startDevServer/watchForRecovery timeout paths keep
   * reporting "crashed" exactly as before (those cases DO have positive
   * evidence: an ECONNREFUSED curl or a port that never opened at all).
   */
  | "timeout";

/**
 * Phase 17: lightweight, request-agnostic timing for one dev-server
 * startup attempt - enough to make a benchmark report evidence-based
 * without a real observability system. All relative to the attempt's
 * own start (right before `npm install`), not wall-clock.
 */
export interface RuntimeStartupTelemetry {
  devServerStartMs: number | null;
  portDetectedMs: number | null;
  realResponseMs: number | null;
  previewReadyMs: number | null;
  totalStartupMs: number | null;
  startupOutcome: "ready" | "crashed" | "timeout" | null;
}

export interface RuntimeHost {
  sessionId: string;
  state: RuntimeState;
  port: number | null;
  previewUrl: string | null;
  ownerTabId: string | null;
  heartbeatAt: number | null;
  errorMessage: string | null;
  updatedAt: number;
  startupTelemetry?: RuntimeStartupTelemetry;
}

/**
 * Phase 17: the structured result a background run_command call
 * returns instead of the old unconditional "Started in the
 * background." - see runtimeSession.ts's quickReadinessCheck. "crashed"
 * is deliberately not produced by the quick check itself (it has no
 * positive evidence of a real failure within its short bound) - that
 * stays owned by the existing startDevServer/watchForRecovery pipeline.
 */
export interface BackgroundRunReadiness {
  status: "ready" | "starting";
  port: number | null;
  url: string | null;
  retryable?: boolean;
}

export type TurnTerminationReason =
  | "done"
  | "step_budget_exhausted"
  | "cancelled"
  | "provider_error"
  | "truncated_no_action"
  | "internal_error"
  /**
   * Phase 16: the model declared itself finished and every tracked
   * subgoal is either "done" or explicitly "blocked" (none left
   * pending/in_progress) - a genuine, self-aware partial completion,
   * distinct from "done" (everything finished) so a partially-blocked
   * result is never silently reported as full success.
   */
  | "blocked"
  | null;

export interface TurnTelemetry {
  iterations: number;
  toolCalls: number;
  successfulActions: number;
  failedActions: number;
  iterationDurationsMs: number[];
  timeToFirstRunMs: number | null;
  timeToFirstPreviewMs: number | null;
  totalDurationMs: number | null;
  terminationReason: TurnTerminationReason;
  /** Phase 16: iterations whose evidence-based signature matched the prior one(s) - see lib/agent/taskProgress.ts's detectStagnation. Not itself a failure count; only stagnationNudgesSent crossing the threshold is. */
  repeatedIterations: number;
  /** How many times the loop interrupted the model with a strategy-escalation nudge (bounded per turn - see loop.ts). */
  stagnationNudgesSent: number;
  /** How many times the loop rejected a premature "done" because tracked subgoals were still pending/in_progress (bounded to 1 per turn). */
  incompleteObjectiveNudgesSent: number;
  /** Phase 21: how many times the loop told the model to switch from adding work to finishing/verifying because the remaining iteration budget is low (bounded to 1 per turn). */
  finishModeNudgesSent: number;
  /** Phase 21: how many times the loop rejected a premature "done" specifically because the last view_preview call didn't actually succeed (bounded to 1 per turn) - distinct from incompleteObjectiveNudgesSent, which is about tracked subgoal status, not real tool-result evidence. */
  blockingPreviewNudgesSent: number;
}

export interface TurnMessage {
  role: "user" | "assistant" | "tool";
  content: string | null;
  /** Phase 28: who actually sent this - only set on a genuine human `role: "user"` entry (never on isNudge system messages, never on assistant/tool entries), so the UI can tell "You" from "Teammate" the same way PresenceBar already does, instead of every chat message reading as anonymous. */
  uid?: string;
  toolName?: string;
  toolCallId?: string;
  /**
   * Phase 24: set only on a successful `write_file` tool-result entry -
   * the file path that was written. Added so change-visibility UI can
   * read a structured field instead of regex-parsing `content`'s
   * human-readable "Wrote X." acknowledgment string, which also varies
   * across the duplicate-superseded and error-message cases (see
   * processWriteFileBatch.ts). Absent on every other entry.
   */
  path?: string;
  /** Phase 24: whether this tool/update_progress call actually succeeded - set alongside `content` at the same log.push site (the result was already known there), not re-derived by parsing `content`'s human-readable text. Absent on user/assistant entries. */
  ok?: boolean;
  /** Phase 24: the tool call's salient argument (a run_command's command string, etc.) for activity-feed summaries - reuses the exact "argsKey" value loop.ts already computed for the stagnation signature at the same call site. */
  argsSummary?: string;
  /**
   * Phase 24: true on a synthetic system nudge (stagnation/incomplete-
   * objective/finish-mode/blocking-preview) - these are logged with
   * `role: "user"` because that's the shape the PROVIDER message needs
   * to be (see loop.ts's nudge injection sites), but a human never
   * typed them. UI-only tag; does not change what's sent to the model.
   */
  isNudge?: boolean;
  createdAt: number;
}

/**
 * Phase 16: the agent's own tracking of the CORE invariant - the
 * user's original objective is the highest-level goal, and a
 * subproblem (a blocker) must never silently replace it. `objective`
 * is meant to be the full original request (every part of it, not just
 * whatever the agent is currently focused on) - a session with "build
 * X and add Y" has one objective covering both, not two separate ones.
 * Populated by the model itself via the update_progress tool (it's the
 * only party that understands the request's semantics), but read and
 * enforced by the loop: a "blocked" subgoal is an explicit, honest
 * stop, not silence: a "pending"/"in_progress" one blocks a premature
 * "done".
 */
export interface TaskSubgoal {
  description: string;
  status: "pending" | "in_progress" | "blocked" | "done";
}

/**
 * Phase 18: root cause, confirmed live across three separate benchmark
 * runs (Ember x2, the Phase 17 coffee-testimonials run) - the model has
 * no structured place to record the stack decisions it already made
 * (Pages Router, JavaScript, no path alias configured), so a
 * continuation turn or a later file has nothing to check its own
 * assumptions against and defaults to its training data's most common
 * convention (a "@/" alias) even when nothing in THIS project
 * configures one. Set once, early, via update_progress (same tool,
 * same persistence as TaskState's own objective/subgoals) and enforced
 * by loop.ts's checkImportConventions - see that function's own doc
 * comment for exactly what it does and, deliberately, does not check.
 * Every field is a short, free-text description (not an enum) so the
 * model can state the ACTUAL project's reality, not pick from a fixed
 * list that might not fit - importConventionCheck.ts only ever reads
 * `pathAliases`/`language` structurally (a substring/extension check),
 * everything else here is informational context for the model itself.
 */
export interface ProjectContract {
  framework: string;
  router: string;
  language: string;
  styling: string;
  pathAliases: string;
  importConvention: string;
  packageManager: string;
}

export interface TaskState {
  objective: string;
  subgoals: TaskSubgoal[];
  /**
   * Optional and merge-persisted (see loop.ts's progressCalls handling)
   * rather than required on every update_progress call - once set, it
   * survives a call that only updates subgoals, and survives a
   * continuation turn the same way objective/subgoals already do. This
   * is the structural guarantee behind "a follow-up turn must not
   * suddenly forget aliases = NONE."
   */
  projectContract?: ProjectContract;
  updatedAt: number;
}

export interface AgentTurn {
  sessionId: string;
  active: boolean;
  startedAt: number;
  cancelledAt: number | null;
  log: TurnMessage[];
  telemetry: TurnTelemetry;
  /**
   * Root cause (2026-08-22, Phase 15): every call to runAgentTurn used
   * to build the provider-shape message array from scratch - just
   * [system, latest user message] - and `.set()` the whole agentTurns
   * doc, discarding the prior turn's history outright. A continuation
   * turn's model call therefore never saw the session's original
   * defining request, live-reproduced causing the model to fall back
   * to the system prompt's own worked example as if it were the actual
   * task. This field is the exact raw messages array a turn ends on -
   * loaded and extended (not replaced) by the next turn, so a
   * continuation genuinely continues the same conversation instead of
   * starting a new one that happens to share a session id. Optional
   * only for pre-fix turn docs written before this field existed.
   */
  providerMessages?: ChatCompletionMessageParam[];
  /** See TaskState's own doc comment. Absent until the model's first update_progress call; persists and is loaded by buildContinuationMessages's caller across continuation turns the same way providerMessages does. */
  taskState?: TaskState;
}

/**
 * The relay between the server-owned agent loop and the browser-owned
 * WebContainer: the agent loop (server) can't reach the runtime
 * directly (it only exists in one browser tab's memory), so a
 * run_command/capture_preview request is posted here, the host tab
 * (subscribed via onSnapshot) executes it locally and reports the
 * result through the /runtime-commands/[id]/complete route. Chosen
 * over a dedicated WebSocket bridge server for v1: same trust/latency
 * characteristics, zero new server process, reuses infrastructure
 * that already exists.
 */
export type RuntimeCommandKind = "run_command" | "capture_preview";

export interface RunCommandPayload {
  command: string;
  cwd?: string;
  background?: boolean;
}

export interface CapturePreviewPayload {
  viewport?: { width: number; height: number };
}

export type RuntimeCommandStatus = "pending" | "started" | "done" | "error";

export interface RuntimeCommand {
  id: string;
  sessionId: string;
  kind: RuntimeCommandKind;
  payload: RunCommandPayload | CapturePreviewPayload;
  status: RuntimeCommandStatus;
  result?: unknown;
  errorMessage?: string;
  createdAt: number;
  completedAt: number | null;
}

/**
 * Phase 24: a lightweight, whole-file-snapshot safety net - not git.
 * One checkpoint is taken automatically right before each agent turn
 * begins (see loop.ts), capturing every session file exactly as it
 * stood before that turn's own writes, so "the agent broke my project"
 * always has a one-click way back to the last known-working state.
 * Deliberately flat (no diffing/delta storage, no branching) - see this
 * type's own scope note in the Phase 24 brief: full git integration is
 * explicitly out of scope for this pass.
 */
export interface CheckpointFile {
  path: string;
  content: string;
  encoding?: "utf8" | "base64";
}

export interface Checkpoint {
  id: string;
  sessionId: string;
  createdAt: number;
  /** Short, human-facing label - the user message that's about to run, truncated. */
  label: string;
  files: CheckpointFile[];
}

/**
 * Phase 24: collaboration foundation. Deliberately separate from
 * RuntimeHost (which tracks WHICH TAB owns the live WebContainer, a
 * runtime-ownership concern) - this tracks which HUMANS currently have
 * the project open, for a "who's here" presence bar. Same
 * heartbeat-doc pattern RuntimeHost already proved out (see
 * useRuntimeHost.ts), reused for a different purpose, not a second
 * competing state system for the same concern.
 */
export interface SessionPresence {
  sessionId: string;
  uid: string;
  tabId: string;
  heartbeatAt: number;
}
