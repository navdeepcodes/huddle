/**
 * Phase 16: the core invariant is that the user's original objective
 * outranks any subproblem the agent runs into while pursuing it - see
 * TaskState's own doc comment (types/session.ts) for the full
 * rationale, and this file's own functions' doc comments for why each
 * exists. Everything here is pure - no Firestore, no provider, no
 * WebContainer - so the exact stagnation/completion-gate behavior is
 * directly testable (tests/taskProgress.test.ts) without a real model.
 *
 * Root cause this closes (2026-08-22, live-reproduced, Phase 15's
 * Ember sanity test): the loop had no representation of "what the user
 * actually asked for" beyond raw transcript text, and no way to notice
 * that 40 iterations of the SAME curl-check-produces-the-SAME-error
 * loop weren't progress. Nothing here forces a specific strategy - the
 * model still owns all engineering judgment - this only (a) gives the
 * loop a structured place to read what the model itself believes the
 * plan is, and (b) detects, from hard evidence (repeated identical
 * tool-call+result pairs), when repeating the current approach isn't
 * working, so a nudge can interrupt the loop before the whole budget
 * is spent on one subproblem.
 */

import type { ProjectContract, ProjectManifest, TaskState, TaskSubgoal } from "@/types/session";

const VALID_STATUSES = new Set<TaskSubgoal["status"]>(["pending", "in_progress", "blocked", "done"]);
const PROJECT_CONTRACT_FIELDS: Array<keyof ProjectContract> = [
  "framework",
  "router",
  "language",
  "styling",
  "pathAliases",
  "importConvention",
  "packageManager",
];

export type ParsedTaskStateUpdate =
  | { ok: true; taskState: TaskState }
  | { ok: false; error: string };

/**
 * Phase 18: optional on each call by design - see ProjectContract's own
 * doc comment for why this is merge-persisted (loop.ts), not required
 * every time like objective/subgoals are. Returns null (nothing to
 * merge) when the field is simply absent from this call's arguments;
 * returns an error string only when it's PRESENT but malformed, same
 * "never throws" discipline as the rest of this file.
 */
function parseProjectContract(raw: unknown): { ok: true; value: ProjectContract | null } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, value: null };
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, error: "update_progress's 'projectContract', if present, must be an object." };
  }

  const contract = {} as ProjectContract;
  for (const field of PROJECT_CONTRACT_FIELDS) {
    const value = (raw as Record<string, unknown>)[field];
    if (typeof value !== "string" || !value.trim()) {
      return {
        ok: false,
        error: `update_progress's 'projectContract.${field}' must be a non-empty string.`,
      };
    }
    contract[field] = value.trim();
  }

  return { ok: true, value: contract };
}

/**
 * Phase 42 §3: unlike projectContract, EVERY field here is individually
 * optional - the point is a tiny, cheap-to-state plan ("this is a small
 * website"), not a second required contract the model has to fill out
 * completely. A malformed shape (wrong type on a field that IS present)
 * is still rejected, same discipline as the rest of this file - it's
 * "every field optional," not "anything goes."
 */
function parseProjectManifest(raw: unknown): { ok: true; value: ProjectManifest | null } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, value: null };
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, error: "update_progress's 'manifest', if present, must be an object." };
  }

  const src = raw as Record<string, unknown>;
  const manifest: ProjectManifest = {};

  if (src.projectType !== undefined) {
    if (typeof src.projectType !== "string" || !src.projectType.trim()) {
      return { ok: false, error: "update_progress's 'manifest.projectType', if present, must be a non-empty string." };
    }
    manifest.projectType = src.projectType.trim();
  }
  if (src.routes !== undefined) {
    if (!Array.isArray(src.routes) || src.routes.some((r) => typeof r !== "string")) {
      return { ok: false, error: "update_progress's 'manifest.routes', if present, must be an array of strings." };
    }
    manifest.routes = src.routes as string[];
  }
  if (src.targetFiles !== undefined) {
    if (!Array.isArray(src.targetFiles) || src.targetFiles.some((f) => typeof f !== "string")) {
      return { ok: false, error: "update_progress's 'manifest.targetFiles', if present, must be an array of strings." };
    }
    manifest.targetFiles = src.targetFiles as string[];
  }
  if (src.fileBudget !== undefined) {
    if (typeof src.fileBudget !== "number" || !Number.isFinite(src.fileBudget)) {
      return { ok: false, error: "update_progress's 'manifest.fileBudget', if present, must be a number." };
    }
    manifest.fileBudget = src.fileBudget;
  }

  return { ok: true, value: Object.keys(manifest).length > 0 ? manifest : null };
}

/** Never throws - a malformed update_progress call gets a clear rejection message back, same discipline as processWriteFileBatch. */
export function parseTaskStateUpdate(argumentsJson: string, now: number): ParsedTaskStateUpdate {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson || "{}");
  } catch {
    return { ok: false, error: "update_progress arguments weren't valid JSON." };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, error: "update_progress arguments must be an object." };
  }

  const { objective, subgoals, projectContract, manifest } = parsed as {
    objective?: unknown;
    subgoals?: unknown;
    projectContract?: unknown;
    manifest?: unknown;
  };

  if (typeof objective !== "string" || !objective.trim()) {
    return { ok: false, error: "update_progress requires a non-empty 'objective' string covering the full original request." };
  }
  if (!Array.isArray(subgoals)) {
    return { ok: false, error: "update_progress requires a 'subgoals' array." };
  }

  const parsedContract = parseProjectContract(projectContract);
  if (!parsedContract.ok) return { ok: false, error: parsedContract.error };

  const parsedManifest = parseProjectManifest(manifest);
  if (!parsedManifest.ok) return { ok: false, error: parsedManifest.error };

  const cleanSubgoals: TaskSubgoal[] = [];
  for (const raw of subgoals) {
    const description = typeof raw === "object" && raw !== null ? (raw as { description?: unknown }).description : undefined;
    const status = typeof raw === "object" && raw !== null ? (raw as { status?: unknown }).status : undefined;

    if (typeof description !== "string" || !description.trim()) {
      return { ok: false, error: "Each subgoal needs a non-empty 'description' string." };
    }
    if (typeof status !== "string" || !VALID_STATUSES.has(status as TaskSubgoal["status"])) {
      return { ok: false, error: `Each subgoal's 'status' must be one of: ${Array.from(VALID_STATUSES).join(", ")}.` };
    }
    cleanSubgoals.push({ description: description.trim(), status: status as TaskSubgoal["status"] });
  }

  return {
    ok: true,
    taskState: {
      objective: objective.trim(),
      subgoals: cleanSubgoals,
      ...(parsedContract.value ? { projectContract: parsedContract.value } : {}),
      ...(parsedManifest.value ? { manifest: parsedManifest.value } : {}),
      updatedAt: now,
    },
  };
}

/** One tool action's contribution to an iteration's stagnation signature - built by the caller (loop.ts) from whatever it already has (tool name, key argument, and the tool's own result). */
export interface IterationAction {
  toolName: string;
  /** The argument that identifies WHAT this call targeted - a path, a command string, etc. Not the full arguments blob, so two calls with irrelevant argument differences (e.g. a changed `reason` string) still compare equal. */
  argsKey: string;
  /** Whether the tool call itself succeeded. */
  ok: boolean;
  /** The tool's own result content - what matters is whether THIS changes between attempts, not the action itself. */
  resultContent: string;
}

/** Deterministic, dependency-free string hash - just needs to be stable and cheap, not cryptographic. */
function simpleHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (Math.imul(hash, 31) + input.charCodeAt(i)) | 0;
  }
  return hash.toString(36);
}

/**
 * One canonical string for everything that happened in an iteration -
 * every action taken AND every result it got back. Two iterations
 * signature-match only if they did the exact same things and got the
 * exact same results - a repeated command that returns a NEW error, or
 * a repeated check alongside other real work, never matches, which is
 * exactly the "don't treat every repeated command as failure" carve-out.
 */
export function buildIterationSignature(actions: IterationAction[]): string {
  if (actions.length === 0) return "";
  return actions
    .map((a) => `${a.toolName}:${a.argsKey}:${a.ok}:${simpleHash(a.resultContent.slice(0, 1000))}`)
    .sort() // action order within a step isn't meaningful to compare on
    .join("|");
}

/** True only when the last `threshold` iterations are byte-for-byte the same signature - hard evidence, not a guess. */
export function detectStagnation(recentSignatures: string[], threshold = 3): boolean {
  if (recentSignatures.length < threshold) return false;
  const lastN = recentSignatures.slice(-threshold);
  if (lastN[0] === "") return false; // an empty signature means "no tool calls that step" - not a repeatable action
  return lastN.every((s) => s === lastN[0]);
}

export function hasUnresolvedSubgoals(taskState: TaskState | undefined): boolean {
  if (!taskState) return false;
  return taskState.subgoals.some((s) => s.status === "pending" || s.status === "in_progress");
}

/** True when every non-done subgoal is specifically blocked (not merely never attempted) - the genuine "best effort, partially blocked" case Phase 9 asks to distinguish from plain "done". */
export function hasOnlyBlockedRemaining(taskState: TaskState | undefined): boolean {
  if (!taskState) return false;
  const remaining = taskState.subgoals.filter((s) => s.status !== "done");
  return remaining.length > 0 && remaining.every((s) => s.status === "blocked");
}

/** Injected as a user-role message when detectStagnation fires - the strategy-escalation nudge (Phase 6): break the loop's blind repetition without dictating what to try next. */
export function buildStagnationNudge(taskState: TaskState | undefined): string {
  const objectiveLine = taskState?.objective
    ? ` Your original objective: "${taskState.objective}".`
    : "";
  return (
    "Your last several attempts produced the exact same result - this specific approach isn't working." +
    objectiveLine +
    " If this is genuinely blocked, record it as blocked via update_progress (say what the specific obstacle is) and move on to a different, independent part of the objective instead of repeating the same thing again. If it's not genuinely blocked, try a fundamentally different approach - inspect different state, reduce to a minimal case, or work around it - rather than retrying what already failed."
  );
}

/** Injected when the model declares itself done but tracked subgoals are still pending/in_progress - the completion gate (Phase 9). */
export function buildIncompleteObjectiveNudge(taskState: TaskState): string {
  const remaining = taskState.subgoals.filter((s) => s.status === "pending" || s.status === "in_progress");
  const list = remaining.map((s) => `- ${s.description} (${s.status})`).join("\n");
  return (
    `Before finishing: your own tracked plan still shows this unfinished:\n${list}\n\n` +
    `Your original objective was: "${taskState.objective}". If this work is actually already done, call update_progress to mark it done and explain why. If it's genuinely blocked, mark it blocked with the specific reason. Otherwise, please continue with it now - don't end the turn while it's still pending.`
  );
}

/**
 * Phase 21: injected once, bounded, when the remaining iteration budget
 * drops below a threshold and real work is still tracked as unresolved
 * - the live-reproduced gap this closes: the Phase 20 Japanese-furniture
 * benchmark ran out of budget mid-way through a thorough (correct!)
 * check of every page for an import-order bug, with a genuine render
 * error still unresolved. Deliberately a PRIORITIZATION framework (five
 * questions), not a coding sequence - the model still owns how to
 * actually fix anything; this only reorders what it should be spending
 * its few remaining iterations on.
 */
export function buildFinishModeNudge(taskState: TaskState | undefined, remainingIterations: number): string {
  const objectiveLine = taskState?.objective ? ` Your original objective: "${taskState.objective}".` : "";
  const remaining = taskState?.subgoals.filter((s) => s.status === "pending" || s.status === "in_progress") ?? [];
  const remainingList =
    remaining.length > 0
      ? remaining.map((s) => `- ${s.description} (${s.status})`).join("\n")
      : "(none currently tracked as remaining)";

  return (
    `Roughly ${remainingIterations} iterations left in this turn.${objectiveLine} Switch from adding work to finishing it. Before your next action, answer for yourself:\n` +
    `1. Does the app currently render without a blocking error?\n` +
    `2. Which of these tracked pieces is still incomplete?\n${remainingList}\n` +
    `3. What is the smallest set of actions that gets to a genuinely working, verified state?\n\n` +
    `Stop adding optional features, new components, alternative libraries, or cosmetic polish for the rest of this turn. If something is genuinely stuck after real attempts, mark it blocked via update_progress with the specific reason and move to what's still achievable - a working app missing one polish item is a better result than a broken app with everything attempted.`
  );
}

/**
 * Phase 42 §7: injected once, bounded, when several files have been
 * written this turn but a build has never been attempted - Phase 41C's
 * own real trace measured 19 files and 14 iterations with zero build
 * attempts. The prompt already says to build the bare scaffold, then
 * build again after the first implementation batch (prompt.ts §2,
 * steps 6/8); this is what fires when that advisory sequence doesn't
 * get followed on its own. Not a coding instruction - it doesn't say
 * what's wrong, only that evidence is overdue.
 */
export function buildEarlyBuildNudge(fileCount: number): string {
  return (
    `${fileCount} files have been written this turn without a single \`npm run build\` yet. ` +
    `Run the build now, before writing more files - it's a cheap, fast, deterministic check, and finding a real error now costs far less than discovering it after the page is fully built out. ` +
    `Fix whatever it reports, then continue. Optional sections and polish can wait until after the core page is proven to compile.`
  );
}

/**
 * Phase 21: injected once, bounded, when the model declares itself done
 * but the last view_preview call this turn didn't actually succeed -
 * real tool-result evidence, independent of whatever taskState itself
 * claims (a model could mark every subgoal "done" including "verify
 * the browser" while the actual last capture failed). Complements
 * buildIncompleteObjectiveNudge, which only checks tracked subgoal
 * status, not what the tools actually reported.
 */
export function buildBlockingPreviewNudge(taskState: TaskState | undefined): string {
  const objectiveLine = taskState?.objective ? ` Your original objective: "${taskState.objective}".` : "";
  return (
    `Before finishing: your last view_preview call this turn didn't actually succeed.${objectiveLine} ` +
    `A build passing or the dev server running isn't the same as the browser actually rendering the requested product - ` +
    `call view_preview again and resolve whatever it reports before declaring this done.`
  );
}

/**
 * Phase 39 (Batch 1): injected once, bounded, for a turn whose actual
 * work this turn is a web project (see loop.ts's isWebProjectTurn) but
 * lacks one or more of the hard, orchestrator-checked facts a
 * completion requires - real files, a passed build, a verified
 * preview. Distinct from buildIncompleteObjectiveNudge (which only
 * checks the model's own self-reported subgoal status) and
 * buildBlockingPreviewNudge (which only checks the last view_preview
 * call) - this is the combined evidence check the orchestrator
 * ultimately decides completion on, not the model's own claim.
 */
export function buildEvidenceNudge(
  taskState: TaskState | undefined,
  status: { filesWritten: boolean; buildPassed: boolean; previewVerified: boolean }
): string {
  const objectiveLine = taskState?.objective ? ` Your original objective: "${taskState.objective}".` : "";
  const missing = [
    !status.filesWritten && "no real project files have been written yet",
    !status.buildPassed && "the last build attempt this turn hasn't passed (or a build hasn't been run yet)",
    !status.previewVerified && "the last preview check this turn hasn't actually succeeded",
  ]
    .filter((line): line is string => Boolean(line))
    .join("; ");
  return (
    `Before finishing: this looks like a web project, but ${missing}.${objectiveLine} ` +
    `Run \`npm run build\` and resolve any errors, then call view_preview and confirm it actually renders, before declaring this done.`
  );
}

/**
 * Phase 41C §7: injected exactly once, at the moment a turn switches
 * providers mid-flight (e.g. Ultra exhausted its attempt budget,
 * Lightning is taking over). The rest of the message history already
 * carries everything the new provider needs - every file written, every
 * tool result, the full taskState trail - so this doesn't repeat any of
 * that; it exists only to state the one fact the history can't imply on
 * its own: a DIFFERENT model is now driving, and it must not mistake
 * "unfamiliar to me" for "not done yet." Reusing taskState/buildState/
 * previewState here (not inventing a new summary shape) keeps this
 * consistent with buildEvidenceNudge's own facts.
 */
export function buildProviderTransitionNudge(
  taskState: TaskState | undefined,
  status: { buildPassed: boolean; previewVerified: boolean }
): string {
  const objectiveLine = taskState?.objective ? ` The original objective: "${taskState.objective}".` : "";
  const done = taskState?.subgoals.filter((s) => s.status === "done").map((s) => s.description) ?? [];
  const doneLine = done.length > 0 ? ` Already completed: ${done.join("; ")}.` : "";
  const evidenceLine = ` Build passed so far: ${status.buildPassed}. Preview verified so far: ${status.previewVerified}.`;
  return (
    "You are continuing an existing build after the primary coding provider failed." +
    objectiveLine +
    doneLine +
    evidenceLine +
    " Do not recreate completed work - inspect the current project state (read_file/list_files) before writing anything, and continue only the remaining task."
  );
}

/**
 * Phase 40 §7: the honest record when a turn hits its hard elapsed-time
 * ceiling. Deliberately states the ceiling and what was actually
 * finished, so "it stopped" is never indistinguishable from "it failed"
 * or from a silent hang - which is exactly what an unbounded turn used
 * to look like from the outside.
 */
export function buildWallClockExhaustedSummary(
  taskState: TaskState | undefined,
  budgetMs: number
): string {
  const minutes = Math.round(budgetMs / 60_000);
  const header = `(stopped: this turn hit its ${minutes}-minute time limit and will not start further work)`;
  if (!taskState) return header;

  const done = taskState.subgoals.filter((s) => s.status === "done").map((s) => s.description);
  const remaining = taskState.subgoals
    .filter((s) => s.status !== "done")
    .map((s) => `${s.description} (${s.status})`);

  return [
    header,
    `OBJECTIVE: ${taskState.objective}`,
    done.length > 0 ? `COMPLETED: ${done.join("; ")}` : "COMPLETED: (nothing finished)",
    remaining.length > 0 ? `REMAINING: ${remaining.join("; ")}` : "REMAINING: (none tracked)",
  ].join("\n");
}

/**
 * The structured OBJECTIVE/COMPLETED/BLOCKED/LAST DIAGNOSIS/NEXT
 * RECOMMENDED ACTION summary Phase 8 asks for when the turn ends on
 * step_budget_exhausted - so a run that hits the budget while stuck
 * leaves a genuinely useful record instead of a bare "ran out of
 * iterations".
 */
export function buildBudgetExhaustedSummary(
  taskState: TaskState | undefined,
  lastAssistantContent: string | null
): string {
  if (!taskState) {
    return "(ran out of iterations - no task plan was recorded this turn via update_progress, so no structured objective/progress summary is available)";
  }

  const completed = taskState.subgoals.filter((s) => s.status === "done");
  const blocked = taskState.subgoals.filter((s) => s.status === "blocked");
  const remaining = taskState.subgoals.filter((s) => s.status === "pending" || s.status === "in_progress");

  const nextAction =
    remaining.length > 0
      ? `continue with "${remaining[0].description}"`
      : blocked.length > 0
        ? `investigate the blocker on "${blocked[0].description}"`
        : "review the result - all tracked subgoals show done";

  return [
    "(ran out of iterations)",
    `OBJECTIVE: ${taskState.objective}`,
    `COMPLETED: ${completed.length > 0 ? completed.map((s) => s.description).join("; ") : "(none recorded)"}`,
    `BLOCKED: ${blocked.length > 0 ? blocked.map((s) => s.description).join("; ") : "(none)"}`,
    `REMAINING: ${remaining.length > 0 ? remaining.map((s) => s.description).join("; ") : "(none)"}`,
    `LAST DIAGNOSIS: ${lastAssistantContent?.trim() ? lastAssistantContent.trim().slice(0, 400) : "(no final commentary recorded)"}`,
    `NEXT RECOMMENDED ACTION: ${nextAction}`,
  ].join("\n");
}
