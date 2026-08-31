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
  /**
   * Phase 37: the sole signal behind "is this a Project" - set true,
   * one-way, the moment batchWriteSessionFiles persists any path
   * outside artifacts/ (real application code, not a generated
   * artifact). Deliberately not a richer classification: a session
   * that has ever had real files written is unambiguously sustained
   * work, and a session that never has (pure Q&A, or an artifact-only
   * request) unambiguously isn't - no AI call, no new query, reuses a
   * write that already happens on every real file change. Absent/false
   * means "not yet a project" (still shown as a quick creation).
   */
  hasRealFiles?: boolean;
  /**
   * Phase 38: owner-controlled, off by default. When true, the new
   * unauthenticated /api/public/projects/[sessionId]/* routes will serve
   * this project's files and accept feedback for it - every other
   * existing route/rule stays exactly as strict as before (memberIds-
   * gated). Restricted to real Projects only (see isProjectWorthy) -
   * enforced server-side in the toggle route, not just hidden in the UI.
   */
  worldAccess?: boolean;
  /**
   * Phase 38: marks a session as an isolated proposal - a full copy of
   * proposalOf's files, seeded once and then turned by runAgentTurn
   * exactly like any other session (the loop itself needed zero changes,
   * see lib/agent/loop.ts). Absent on every ordinary session/project.
   */
  isProposal?: boolean;
  /** Phase 38: the real project this proposal was copied from - the only session that Accept ever writes files back into. */
  proposalOf?: string;
  /** Phase 38: the sessionFeedback doc (in proposalOf's collection) this proposal exists to try. */
  proposalFeedbackId?: string;
}

export type SessionFeedbackStatus = "new" | "trying" | "accepted" | "rejected" | "ignored";

/**
 * Phase 38: a public visitor's free-text suggestion on a world-access
 * project. Deliberately inert on write - submitting one NEVER touches
 * Nemotron/WebContainer/Qwen (see the public feedback route) - it only
 * becomes real work when the owner explicitly clicks "Try with Huddle",
 * which reads this doc and creates a proposal session from it.
 */
export interface SessionFeedback {
  id: string;
  sessionId: string;
  text: string;
  viewport?: { width: number; height: number };
  status: SessionFeedbackStatus;
  createdAt: number;
  /** Set once a "Try with Huddle" click creates a proposal session from this feedback. */
  proposalSessionId?: string;
  /** Opt-in only (see the public feedback route) - lets a visitor who left one check back without creating any account. */
  notifyToken?: string;
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
  /**
   * Phase 40 §2: identity for one runtime startup/recovery attempt.
   * Incremented by claimRuntimeHost whenever a genuinely new attempt
   * begins. Every asynchronous readiness worker captures the generation
   * it started under and passes it back when reporting; a report whose
   * generation is older than the current one is DISCARDED.
   *
   * This exists because the diagnosis found five independent writers of
   * `state` (startDevServer, watchForRecovery,
   * continueWatchingForReadiness, runBackgroundWithReadiness, and
   * onPreviewUrl) with no ordering between them - several of them
   * long-running and fire-and-forget, so a stale curl result, an old
   * crash watcher, or a late timeout could overwrite the state of a
   * newer attempt. Ordering was previously left to timing; this makes
   * it explicit identity instead.
   *
   * Optional only for RuntimeHost docs written before this field
   * existed - treated as generation 0.
   */
  generation?: number;
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
  /**
   * Phase 39 (Batch 1): the model believes it's done and no subgoal is
   * pending/blocked - but the hard, orchestrator-checked evidence (a
   * real successful build, a real verified preview, real files) for a
   * turn that generated a web project doesn't back that up. Distinct
   * from "blocked" (an explicit, self-aware stop naming what's
   * blocked) and from "done" (fully evidenced) - same reasoning as
   * why "blocked" itself exists, extended to evidence the model can't
   * just self-attest.
   */
  | "evidence_incomplete"
  /**
   * Phase 39 (Batch 1): this process's claim on the turn (see
   * lib/agent/turnRegistry.ts's claimTurnAuthoritative) was reclaimed
   * as stale - almost always a crashed or restarted process - before
   * this process could finish normally. The orphaned turn's own
   * `active` flag is flipped to false by the SAME transaction that
   * grants the new claim, specifically so a crashed turn never stays
   * silently "active" forever in the UI.
   */
  | "claim_expired"
  /**
   * Phase 40 §7: the turn hit its hard elapsed-time ceiling
   * (TURN_WALL_CLOCK_BUDGET_MS) and stopped starting new work.
   * Distinct from step_budget_exhausted (ran out of ITERATIONS, which
   * says nothing about time) - this one means the turn was taking
   * pathologically long regardless of how much of the iteration budget
   * it had left, which before Phase 40 had no bound at all.
   */
  | "wall_clock_exhausted"
  /**
   * Phase 40 §6A: the build failed and the code-enforced repair budget
   * (MAX_BUILD_ATTEMPTS) is spent. Previously the "2-3 attempts" cap
   * existed only as prompt text with nothing reading buildState.attempt,
   * so a model could rebuild indefinitely inside the step budget.
   */
  | "build_repair_budget_exhausted"
  | null;

export interface TurnTelemetry {
  iterations: number;
  toolCalls: number;
  successfulActions: number;
  failedActions: number;
  iterationDurationsMs: number[];
  timeToFirstRunMs: number | null;
  timeToFirstPreviewMs: number | null;
  /** Phase 42 §6: elapsed ms from turn start to the first build ATTEMPT (pass or fail) - "is the agent building early," not "did it eventually pass." Phase 41C's own trace measured null the entire 20-minute turn: 0 build attempts across 14 iterations. */
  timeToFirstBuildMs: number | null;
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
  /** Phase 39 (Batch 1): how many times the loop rejected a premature "done" for a web-project turn because real build/preview/file evidence was missing (bounded to 1 per turn) - see BuildState/PreviewVerificationState and loop.ts's evidence gate. */
  evidenceNudgesSent: number;
  /**
   * Phase 39C: how many times a provider-side truncation produced zero
   * tool calls and the loop gave the step one more chance instead of
   * ending the turn (bounded to 1 per turn). A non-zero value here on
   * an otherwise successful turn is the signal that the shared
   * reasoning/output budget came close to costing real work - see the
   * truncation branch in loop.ts's step loop.
   */
  truncatedNoActionRetries: number;
  /**
   * Phase 41C §12: the one provider-transition record this turn needed
   * - not a new state architecture, just enough evidence to know what
   * happened. `activated` is false for the overwhelming majority of
   * turns (primary succeeded outright). When true, `fromProviderId`/
   * `toProviderId` name the switch (e.g. "nvidia" -> "nvidia-lightning")
   * and `reason` is the AgentProviderError kind (or
   * "truncated_no_action_exhausted") that caused it - internal/debug
   * detail, never shown to the user verbatim (see activityFeed.ts's
   * sanitized copy for what the user actually sees).
   */
  providerFallback: {
    activated: boolean;
    fromProviderId: string | null;
    toProviderId: string | null;
    reason: string | null;
  };
  /** Phase 42 §2: whether fileBudget.ts's guardrail fired this turn - observability only, the write itself is never blocked (see fileBudget.ts's own doc comment). Bounded to firing once. */
  fileBudgetWarningSent: boolean;
  /** Phase 42 §7: whether the one-time "you've written several files but never built" nudge fired - see loop.ts's early-build check. */
  buildEarlyNudgeSent: boolean;
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

/**
 * Phase 42: a deliberately tiny plan, not a file manifest architecture.
 * Every field is optional - the point isn't to force the model to plan
 * exhaustively (that risks the same hidden-reasoning-budget cost
 * Phase 40 already found competing with tool-call emission), it's to
 * establish "this is a small website" up front so fileBudget.ts has
 * something better than a blind default to work from. Merge-persisted
 * exactly like projectContract - stated once, remembered automatically.
 */
export interface ProjectManifest {
  /** Free text, e.g. "marketing_site", "portfolio", "saas_dashboard" - informational, not an enum. */
  projectType?: string;
  /** Real routes/pages this product needs, e.g. ["/"] for a single landing page. */
  routes?: string[];
  /** The files the model actually intends to write for the first working version - not exhaustive, just the plan. */
  targetFiles?: string[];
  /** An explicit file-count guideline for THIS project, if the model wants to state one directly instead of implying it via targetFiles/routes. */
  fileBudget?: number;
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
  /** Phase 42: same merge-persist discipline as projectContract - see ProjectManifest's own doc comment. */
  manifest?: ProjectManifest;
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
  /**
   * Phase 39 (Batch 1): a real, orchestrator-checked fact - "has THIS
   * turn produced a successful build" - not text the model has to
   * remember. Deliberately NOT carried across a continuation turn
   * (unlike taskState/providerMessages): the question is whether this
   * exact turn's edits build, not whether the project has ever built.
   * Falls out automatically from runAgentTurn's turnRef.set(turn) full
   * overwrite at turn start, which never spreads this field from the
   * prior turn doc.
   */
  buildState?: BuildState;
  /**
   * Phase 39 (Batch 1): a real, orchestrator-checked fact for whether
   * this turn's preview was actually verified - runtime responding,
   * preview URL set, a real captured response, sufficiently ready -
   * not merely "view_preview was called" or "the model said so". Same
   * per-turn-only rule as buildState.
   */
  previewState?: PreviewVerificationState;
}

/**
 * Phase 39 (Batch 1): "BUILD PASSED" used to be effectively a string
 * living only in a tool-result the model had to remember - nothing
 * else in the system could answer "did this turn's build actually
 * pass" without parsing chat text. This is that missing fact,
 * populated in loop.ts from executeTool.ts's run_command handling
 * (see ToolExecutionResult.buildEvidence) whenever the command is
 * recognized as a build command (isBuildCommand).
 */
export interface BuildState {
  status: "passed" | "failed";
  /** How many build attempts this turn has made so far (1-indexed) - not itself enforced as a cap here, see loop.ts's repeat-error handling for that. */
  attempt: number;
  startedAt: number;
  completedAt: number;
  /** The exact command that was classified as a build, for observability. */
  command: string;
  /** Only set when status is "failed" - the same truncated tail already shown to the model, not a fresh capture. */
  errorSummary?: string;
}

/**
 * Phase 39 (Batch 1): the "PREVIEW_VERIFIED" fact the completion gate
 * needs. Deliberately just a persistence of what viewPreview() already
 * establishes (runtime responding + preview URL set + a real captured
 * response after the paint-ready backoff) - no new verification logic,
 * see executeTool.ts's view_preview case for where this gets set.
 */
export interface PreviewVerificationState {
  verified: boolean;
  checkedAt: number;
  previewUrl: string | null;
  /** Only set when verified is false. */
  reason?: string;
}

/**
 * Phase 39 (Batch 1): the persistent, transactional counterpart to
 * lib/agent/turnRegistry.ts's in-memory activeControllers Map - see
 * that file's own doc comment for why the Map alone isn't sufficient
 * (a process restart or multi-instance deploy silently loses it).
 * Deliberately a SEPARATE collection from agentTurns, not fields
 * bolted onto it - mirrors the runtimeHost-vs-sessions split so this
 * doc's claim-establishing transaction never contends with the loop's
 * own frequent, unrelated per-iteration agentTurns updates. Modeled
 * directly on RuntimeHost's claimRuntimeHost pattern (see
 * runtimeHostAdmin.ts) - server-only, no firestore.rules entry needed,
 * same precedent as checkpoints/sessionPresence (Admin-SDK-only
 * collections with no client-direct access).
 */
export interface TurnClaim {
  sessionId: string;
  active: boolean;
  /** Opaque token this specific claim holder must present to heartbeat/release - so a superseded (reclaimed-as-stale) process can never clobber a newer legitimate claim's state. */
  turnToken: string;
  claimedAt: number;
  heartbeatAt: number;
  releasedAt: number | null;
  /** Last known outcome, for observability only - NEVER read as a gate; the agentTurns doc's own telemetry.terminationReason is authoritative for that. */
  terminationReason: TurnTerminationReason;
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

/**
 * Phase 35: the smallest representation that lets a project own a
 * generated creative artifact - designed so a second `type` (image,
 * document, spreadsheet, website...) is just a new union member and a
 * new generator later, not a redesign. Deliberately does NOT hold the
 * artifact's own bytes - `path` points at the real file already
 * persisted through the EXISTING sessionFiles store (same base64
 * mechanism write_file already uses), so artifact sync/permissions/
 * collaborator visibility are inherited for free rather than rebuilt.
 * `status` exists specifically so the UI can show "generating" before
 * the file write completes, and "failed" without ever leaving a
 * phantom/partial file passed off as a real artifact.
 */
/** Phase 36: images join presentations as a second artifact type - same collection, same storage mechanism, no redesign. */
export type ArtifactType = "presentation" | "image";
export type ArtifactStatus = "generating" | "ready" | "failed";

export interface Artifact {
  id: string;
  sessionId: string;
  type: ArtifactType;
  title: string;
  /** Session-relative path into sessionFiles once status is "ready" - the artifact's real storage reference, not a copy of its content. */
  path: string;
  status: ArtifactStatus;
  createdAt: number;
  createdBy: "agent" | "user";
  createdByUid?: string;
  /** Set only when status is "failed" - the real reason, never fabricated. */
  errorMessage?: string;
  /** Optional, type-specific, useful-for-preview facts - a presentation's slide count, or an image's real pixel dimensions and the prompt that produced it. Never the artifact's actual binary content. */
  metadata?: { slideCount?: number; width?: number; height?: number; prompt?: string };
}
