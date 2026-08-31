import "server-only";

import { adminDb } from "@/lib/firebase/admin";
import { resolveAgentProviders } from "@/lib/agent/providerResolution";
import { generateStepWithRecovery } from "@/lib/agent/providerRecovery";
import { AgentProviderError } from "@/lib/agent/provider";
import { computeFileBudget, buildFileBudgetWarning } from "@/lib/agent/fileBudget";
import { logProviderCall } from "@/lib/agent/providerTelemetry";
import { buildTeammateLabels } from "@/lib/presence/attribution";
import { AGENT_TOOLS } from "@/lib/agent/tools";
import { SYSTEM_PROMPT } from "@/lib/agent/prompt";
import { executeTool, refuseForBudget, isRuntimeRestartCall } from "@/lib/agent/executeTool";
import { batchWriteSessionFiles } from "@/lib/files/fileStore";
import { registerTurn, unregisterTurn, heartbeatTurnClaim, releaseTurnClaim } from "@/lib/agent/turnRegistry";
import { processWriteFileBatch } from "@/lib/agent/processWriteFileBatch";
import { checkImportConventions, autoFixBrandIcons } from "@/lib/agent/importConventionCheck";
import { createCheckpoint } from "@/lib/checkpoints/checkpointStore";
import {
  parseTaskStateUpdate,
  buildIterationSignature,
  detectStagnation,
  hasUnresolvedSubgoals,
  hasOnlyBlockedRemaining,
  buildStagnationNudge,
  buildIncompleteObjectiveNudge,
  buildFinishModeNudge,
  buildBlockingPreviewNudge,
  buildBudgetExhaustedSummary,
  buildEvidenceNudge,
  buildWallClockExhaustedSummary,
  buildProviderTransitionNudge,
  buildEarlyBuildNudge,
} from "@/lib/agent/taskProgress";

import type { IterationAction } from "@/lib/agent/taskProgress";
import type {
  AgentTurn,
  BuildState,
  PreviewVerificationState,
  TaskState,
  TurnMessage,
  TurnTelemetry,
  TurnTerminationReason,
} from "@/types/session";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

/**
 * Fixed for v1, per the required adjustment - not scaled to plan size.
 * There isn't enough data yet to design that intelligently; this
 * instruments everything a future dynamic budget would need
 * (iterations, timings, termination reason) without committing to an
 * algorithm now. 40 gives real headroom for a multi-file build +
 * install + run + view + one fix pass without being unbounded.
 */
const STEP_BUDGET = 40;

/**
 * Phase 29: the provider list used to be a fixed module-level array
 * (nemotron then deepseek, sharing one credential each for every
 * user). It's now resolved per turn by resolveAgentProviders(uid) -
 * see that file's own doc comment - so the requesting user's own
 * Nemotron credential (personal, or the platform fallback) is what
 * generateStepWithRecovery actually calls. deepseek stays the
 * fallback provider, unchanged, for when nemotron's own retries are
 * exhausted - same ordering/semantics as before, just no longer a
 * fixed constant.
 */

/** Compact, single-line context so the model knows who's asking without turning every message into a metadata dump - see buildTeammateLabels' own doc comment for why numbering comes from memberIds order, not presence. Omitted entirely for a solo project (nothing useful to say). */
export function buildRequesterContext(memberIds: string[], uid: string | undefined): string | null {
  if (!uid || memberIds.length <= 1) return null;
  const labels = buildTeammateLabels(memberIds, undefined);
  const requesterLabel = labels.get(uid) ?? "a project collaborator";
  const collaboratorLabels = memberIds.map((m) => labels.get(m)).filter((l): l is string => Boolean(l));
  return `[Current requester: ${requesterLabel}. Project collaborators: ${collaboratorLabels.join(", ")}.]`;
}

/**
 * Phase 16 bounds. STAGNATION_THRESHOLD (consecutive identical
 * iteration signatures before a nudge) is evidence-based, not a blind
 * step count - see taskProgress.ts's detectStagnation. The two nudge
 * caps bound the NUDGING mechanism itself so a stubborn model can't
 * turn one bug into an infinite back-and-forth; they don't dictate any
 * particular debugging strategy.
 */
const STAGNATION_THRESHOLD = 3;
const MAX_STAGNATION_NUDGES = 2;
const MAX_INCOMPLETE_OBJECTIVE_NUDGES = 1;
/**
 * Phase 21: how many iterations of headroom counts as "the end of the
 * turn" - live-reproduced gap this closes: the Phase 20 benchmark spent
 * its final ~15 iterations still doing open-ended work (adding pages,
 * checking every file for a bug class) with a real render error
 * unresolved, and ran out before fixing it. 8 gives real room to
 * actually finish something (diagnose + fix + reverify) without firing
 * so early it interrupts genuinely necessary mid-build work.
 */
const FINISH_MODE_REMAINING_THRESHOLD = 8;
const MAX_FINISH_MODE_NUDGES = 1;
const MAX_BLOCKING_PREVIEW_NUDGES = 1;
/** Phase 39 (Batch 1): same tier as the other bounded nudges above - one chance to supply the missing build/preview/file evidence before the turn honestly reports evidence_incomplete instead of a false "done". */
const MAX_EVIDENCE_NUDGES = 1;
/**
 * Phase 39C: exactly one retry after a provider-side truncation that
 * produced no tool call - see the truncation branch in the step loop
 * for the live failure this closes. Strictly bounded, same discipline
 * as every nudge cap above: if the retry truncates the same way, the
 * turn ends honestly as truncated_no_action rather than looping.
 */
const MAX_TRUNCATED_NO_ACTION_RETRIES = 1;

/**
 * Phase 40 §7: the hard elapsed-time ceiling for one turn. STEP_BUDGET
 * bounds ITERATIONS but nothing bounded elapsed TIME, and the two are
 * not equivalent: with a 180s per-request provider timeout and bounded
 * retries, a single pathological iteration can run for many minutes, so
 * 40 of them had no meaningful upper bound at all (measured worst case
 * before this: ~12 hours).
 *
 * 20 minutes is chosen from the real observed distribution of this
 * system's own successful builds, not invented: 10.7 min (Bloom &
 * Stem), 17.5 min (Pathway SaaS), 23.2 min (Flour & Fig), against
 * pathological runs measured in hours. 20 min clears the great majority
 * of legitimate builds while cutting the tail that can only be a stuck
 * system. It is deliberately a CEILING, not a target - a healthy build
 * should finish far inside it.
 */
const TURN_WALL_CLOCK_BUDGET_MS = 20 * 60_000;

/**
 * Phase 40 §8: the claim heartbeat used to fire only at iteration
 * boundaries, so a single long provider call could exceed
 * TURN_CLAIM_STALE_MS (5 min) and let a genuinely-alive turn be
 * reclaimed out from under itself. Rather than making the claim
 * immortal (explicitly rejected) or shrinking the provider timeout
 * (would kill legitimately slow calls - 132s and 177s both observed
 * live), the heartbeat runs on this cadence FOR THE DURATION OF an
 * in-flight provider call and is cleared the moment it returns. Scoped
 * to one call's lifetime, never free-running: an abandoned process
 * stops beating immediately and its claim still goes stale normally.
 */
const CLAIM_HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * Phase 40 §6A: total build attempts allowed in one turn. The prompt
 * has always said "cap yourself at 2-3 build attempts against the same
 * underlying error", and buildState.attempt has always been INCREMENTED
 * - but nothing ever read it, so the cap was advisory and a model could
 * rebuild until the step budget ran out. This is that cap, enforced.
 * 3 matches the prompt's own wording so the two can't drift.
 */
const MAX_BUILD_ATTEMPTS = 3;

/**
 * Phase 40 §6B: total dev-server restarts/recoveries allowed in one
 * turn. Previously prompt-only ("restarting is expensive and should be
 * rare"), with the sole code-level guard being an exact-string reuse
 * memo in runtimeSession - so any varied restart command spawned
 * freely and nothing counted them.
 */
const MAX_RUNTIME_RESTARTS = 2;

/**
 * Phase 42 §7: "the agent can write for 14 iterations without ever
 * building" - Phase 41C's own real trace, 19 files, 0 build attempts.
 * The prompt already says to build the bare scaffold and then the
 * first implementation batch (prompt.ts §2, steps 6/8) - this is the
 * code-enforced backstop for when that advisory sequence doesn't get
 * followed. 4 files is deliberately close to fileBudget.ts's own
 * DEFAULT_FILE_BUDGET (8) 's midpoint - enough that a genuinely tiny
 * edit never trips it, small enough to catch the problem while there's
 * still time saved by catching it.
 */
const EARLY_BUILD_FILE_THRESHOLD = 4;

function emptyTelemetry(): TurnTelemetry {
  return {
    iterations: 0,
    toolCalls: 0,
    successfulActions: 0,
    failedActions: 0,
    iterationDurationsMs: [],
    timeToFirstRunMs: null,
    timeToFirstPreviewMs: null,
    timeToFirstBuildMs: null,
    totalDurationMs: null,
    terminationReason: null,
    repeatedIterations: 0,
    stagnationNudgesSent: 0,
    incompleteObjectiveNudgesSent: 0,
    finishModeNudgesSent: 0,
    blockingPreviewNudgesSent: 0,
    evidenceNudgesSent: 0,
    truncatedNoActionRetries: 0,
    providerFallback: { activated: false, fromProviderId: null, toProviderId: null, reason: null },
    fileBudgetWarningSent: false,
    buildEarlyNudgeSent: false,
  };
}

/**
 * A continuation turn must genuinely continue the conversation, not
 * start a new one - see AgentTurn.providerMessages's own doc comment
 * for the live-reproduced failure this closes. Pure and unit-tested
 * (tests/loop.test.ts) so the exact preservation/fallback behavior is
 * verifiable without a real provider or Firestore.
 */
export function buildContinuationMessages(
  existing: AgentTurn | null,
  userMessage: string,
  systemPrompt: string
): ChatCompletionMessageParam[] {
  if (existing?.providerMessages && existing.providerMessages.length > 0) {
    // Always use the current system prompt (a later Huddle deploy may
    // have fixed something) - drop whatever was persisted for it and
    // keep everything else, which is the real conversation history.
    const withoutSystem = existing.providerMessages.filter((m) => m.role !== "system");
    return [
      { role: "system", content: systemPrompt },
      ...withoutSystem,
      { role: "user", content: userMessage },
    ];
  }

  const firstLogEntry = existing?.log?.[0];
  if (firstLogEntry?.role === "user" && firstLogEntry.content) {
    // Continuation of a turn written before this field existed - no
    // raw provider-shape history to replay, but the session's original
    // defining request is still recoverable from the simplified log,
    // which is enough to prevent the exact Phase 14 failure (zero
    // product context on a follow-up).
    return [
      { role: "system", content: systemPrompt },
      { role: "user", content: firstLogEntry.content },
      { role: "user", content: userMessage },
    ];
  }

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ];
}

/**
 * Server-owned: started detached from the HTTP request that triggered
 * it (see app/api/sessions/[sessionId]/turn/route.ts, which doesn't
 * await this), so a browser disconnect never kills a running turn -
 * only an explicit POST /turn/cancel (turnRegistry.cancelTurn) does,
 * via the AbortSignal threaded through every provider call and every
 * dispatched runtime command.
 *
 * Phase 28 Test D: registerTurn used to happen after two Firestore
 * round-trips (turnRef.get() then turnRef.set()) below - live-
 * reproduced that this left a real window where two genuinely
 * concurrent POST /turn requests for the same session could both
 * pass the route's isTurnActive check, both reach here, and both
 * start a full turn writing to the same agentTurns doc. Moving
 * registerTurn to the first synchronous statement (paired with the
 * route moving its isTurnActive check to immediately before this
 * call, with no `await` in between) closes the race: Node's single-
 * threaded execution guarantees no other request's code can run
 * between one request's check and its registration. The try/catch
 * around the original pre-registration setup exists only so a setup
 * failure (e.g. the initial turnRef.get() rejecting) still releases
 * the lock it just claimed, instead of leaving the session
 * permanently stuck "active" - the existing try/finally further down
 * already did this for every failure after setup; this extends the
 * same guarantee to setup itself now that registration comes first.
 */
export async function runAgentTurn(
  sessionId: string,
  userMessage: string,
  uid: string,
  /**
   * Phase 39 (Batch 1): proof this process actually holds the
   * authoritative claim on this turn (see turnRegistry.ts's
   * claimTurnAuthoritative) - the caller must claim BEFORE calling
   * this function, not the other way around, since the claim is what
   * decides whether a turn may start at all (a rejected claim means
   * the caller returns 409 without ever reaching runAgentTurn).
   */
  turnToken: string,
  /**
   * Phase 39 (Batch 1): whether this session already had real project
   * files before this turn started (Session.hasRealFiles at claim
   * time) - feeds the completion gate's FILES_WRITTEN check alongside
   * whatever this turn itself writes, so a continuation turn on an
   * already-real project isn't wrongly treated as having written
   * nothing. A brand-new session (first-ever turn) passes false.
   */
  hasRealFilesAtTurnStart: boolean,
  memberIds: string[] = []
): Promise<void> {
  const controller = registerTurn(sessionId);
  const signal = controller.signal;

  const turnRef = adminDb.collection("agentTurns").doc(sessionId);
  const startedAt = Date.now();

  let telemetry: TurnTelemetry;
  let log: TurnMessage[];
  let messages: ChatCompletionMessageParam[];
  let taskState: TaskState | undefined;

  try {
    const existingSnap = await turnRef.get();
    const existing = existingSnap.exists ? (existingSnap.data() as AgentTurn) : null;

    telemetry = emptyTelemetry();
    log = [...(existing?.log ?? []), { role: "user", content: userMessage, createdAt: startedAt, uid }];
    // Phase 29 Part 2/4: the model-facing message carries a compact
    // requester/collaborator line the human-readable `log` (ChatPanel)
    // deliberately does NOT - a user should never see "[Current
    // requester: Teammate 2...]" prepended to their own typed message.
    const requesterContext = buildRequesterContext(memberIds, uid);
    const modelFacingMessage = requesterContext ? `${requesterContext}\n${userMessage}` : userMessage;
    messages = buildContinuationMessages(existing, modelFacingMessage, SYSTEM_PROMPT);
    // Phase 16: survives a continuation the same way providerMessages does -
    // a follow-up turn still knows what's completed/blocked, not just the
    // raw transcript.
    taskState = existing?.taskState;

    const turn: AgentTurn = {
      sessionId,
      active: true,
      startedAt,
      cancelledAt: null,
      log,
      telemetry,
      providerMessages: messages,
      // Firestore's Admin SDK rejects `undefined` field values outright
      // (see the finally block's own comment below for the live crash
      // this exact class of bug already caused once) - taskState is
      // genuinely undefined until the model's first update_progress call,
      // so it's only included once it exists, same pattern as
      // fileStore.ts's batchWriteSessionFiles uses for optional fields.
      ...(taskState ? { taskState } : {}),
    };
    await turnRef.set(turn);
  } catch (error) {
    unregisterTurn(sessionId);
    throw error;
  }

  // Phase 24: snapshot every file exactly as it stood before this
  // turn's own writes - the safety net behind "agent broke my project
  // -> restore the previous working state." Deliberately fire-and-swallow:
  // a checkpoint failure must never block the actual agent turn it
  // exists to protect (product-feature addition, not part of any frozen
  // runtime system - see checkpointStore.ts's own doc comment).
  createCheckpoint(sessionId, userMessage).catch((error) => {
    console.error(`Checkpoint creation failed for session ${sessionId}:`, error);
  });

  // Phase 29 Part 1/9: resolved ONCE per turn, for this uid alone -
  // every generateStepWithRecovery call in this turn's step loop
  // reuses the SAME resolved providers, so a turn can never
  // mid-flight start using a different user's credential. See
  // resolveAgentProviders' own doc comment for the personal-vs-
  // platform-fallback policy.
  const { providers: agentProviders } = await resolveAgentProviders(uid);

  let terminationReason: TurnTerminationReason = "step_budget_exhausted";
  const recentSignatures: string[] = [];
  /**
   * Phase 21: real tool-result evidence for the completion gate, kept
   * separate from taskState (which is only what the model claims). null
   * until the first view_preview call this turn; then reflects whether
   * that specific call actually succeeded, independent of what any
   * subgoal says.
   */
  let lastViewPreviewOk: boolean | null = null;
  /**
   * Phase 26: per-turn-scoped, in-memory only (same discipline as
   * lastViewPreviewOk above - reset every turn, never persisted) -
   * lets view_preview skip a redundant vision call on an unchanged
   * screenshot, and lets executeTool tell the model plainly once
   * vision has failed repeatedly in a row this turn instead of leaving
   * it to guess from an unchanging error string.
   */
  let previousPreviewCheck: { screenshotHash: string; critique: string; provider: string } | undefined;
  let consecutiveVisionFailures = 0;
  /**
   * Phase 39 (Batch 1): real, orchestrator-checked facts for THIS turn
   * only (never carried across a continuation, unlike taskState) - see
   * BuildState/PreviewVerificationState's own doc comments. Populated
   * from executeTool's buildEvidence/previewEvidence, persisted on
   * AgentTurn, and read by the completion gate below.
   */
  let buildState: BuildState | undefined;
  let previewState: PreviewVerificationState | undefined;
  /**
   * Phase 39 (Batch 1): the intent-aware signal for the completion
   * gate - is this turn's actual work a web project? scaffoldCalledThisTurn
   * alone is unambiguous evidence; wroteFileThisTurn is required
   * alongside an INHERITED projectContract (see the gate itself) so a
   * continuation turn that only does something unrelated (e.g.
   * create_presentation) on an existing web-project session is never
   * wrongly gated on build/preview evidence it never needed.
   */
  let scaffoldCalledThisTurn = false;
  let wroteFileThisTurn = false;
  /**
   * Phase 40 §7: one absolute timestamp, computed once, threaded to
   * every place that can start expensive work (the iteration gate
   * below, generateStepWithRecovery's retry loop, and executeTool's
   * expensive-tool gate). Deliberately an absolute deadline rather than
   * a duration each layer re-derives - there is exactly one definition
   * of "this turn is out of time."
   */
  const turnDeadline = startedAt + TURN_WALL_CLOCK_BUDGET_MS;
  /** Phase 40 §6B: per-turn cap on runtime restarts/recoveries (see MAX_RUNTIME_RESTARTS). */
  let runtimeRestartsThisTurn = 0;
  /**
   * Phase 41C §3: which provider in `agentProviders` owns the REST of
   * this turn. Starts at the primary (0). generateStepWithRecovery is
   * only ever given `agentProviders.slice(committedProviderIndex)` -
   * once a later provider succeeds, this advances and the primary is
   * never retried again this turn. Without this, every iteration would
   * independently start back at the primary, re-paying its full attempt
   * budget on every single step even after it's already shown itself to
   * be failing - "primary -> fallback -> primary -> fallback" oscillation,
   * exactly what Phase 41 explicitly ruled out. This is the ONE place
   * that decides provider ownership; generateStepWithRecovery itself is
   * unchanged and still just tries whatever list it's handed, in order.
   */
  let committedProviderIndex = 0;
  /**
   * Phase 42 §2/§7: distinct NEW file paths written THIS turn - not
   * pre-existing files from a continuation, since the budget is about
   * this turn's own generation effort. Backs both the file-budget
   * warning and the early-build nudge below.
   */
  const wroteFilePaths = new Set<string>();

  try {
    for (let i = 0; i < STEP_BUDGET; i++) {
      if (signal.aborted) {
        terminationReason = "cancelled";
        break;
      }

      // Phase 40 §7: the wall-clock ceiling, checked BEFORE any new
      // expensive work is started. An already-in-flight request is
      // allowed to finish (interrupting it would waste what it already
      // spent); this only guarantees nothing NEW begins past the
      // deadline. Expensive per-tool operations enforce the same
      // deadline themselves - see executeTool's ExecuteToolContext.
      if (Date.now() >= turnDeadline) {
        terminationReason = "wall_clock_exhausted";
        log.push({
          role: "assistant",
          content: buildWallClockExhaustedSummary(taskState, TURN_WALL_CLOCK_BUDGET_MS),
          createdAt: Date.now(),
        });
        break;
      }

      telemetry.iterations++;
      const iterationStartedAt = Date.now();

      let step;
      const callStartedAt = Date.now();
      // Phase 41C §3: only the providers from the current commit point
      // onward are ever offered - see committedProviderIndex's own doc
      // comment for why (no primary/fallback oscillation across
      // iterations).
      const candidateProviders = agentProviders.slice(committedProviderIndex);
      // Phase 40 §8: keep the turn claim alive across a long provider
      // call. Cleared unconditionally in the finally below, so this can
      // never outlive the call it belongs to.
      const claimHeartbeat = setInterval(() => {
        void heartbeatTurnClaim(sessionId, turnToken).catch(() => {
          // A failed beat is not itself fatal - the split-brain guard
          // after the iteration is what actually acts on lost ownership.
        });
      }, CLAIM_HEARTBEAT_INTERVAL_MS);
      try {
        const result = await generateStepWithRecovery(candidateProviders, messages, AGENT_TOOLS, signal, undefined, turnDeadline);
        step = result.step;
        logProviderCall({
          uid,
          sessionId,
          provider: result.providerId,
          model: agentProviders.find((p) => p.id === result.providerId)?.model ?? "unknown",
          turnId: `${sessionId}_${startedAt}`,
          success: true,
          latencyMs: Date.now() - callStartedAt,
          attempts: result.attempts,
          usage: step.usage,
        });

        // Phase 41C §3/§12: the primary in THIS call's candidate list
        // failed and a later provider served the step - commit to it for
        // the rest of the turn and record the one transition fact.
        if (result.providerId !== candidateProviders[0]?.id) {
          const newIndex = agentProviders.findIndex((p) => p.id === result.providerId);
          telemetry.providerFallback = {
            activated: true,
            fromProviderId: candidateProviders[0]?.id ?? null,
            toProviderId: result.providerId,
            reason: "provider_exhausted",
          };
          if (newIndex >= 0) committedProviderIndex = newIndex;
          // Phase 41C §"USER-FACING ACTIVITY": honest but simple, never
          // the raw provider error text.
          log.push({
            role: "assistant",
            content: "Huddle switched to a backup model and continued.",
            createdAt: Date.now(),
          });
          const transitionNudge = buildProviderTransitionNudge(taskState, {
            buildPassed: buildState?.status === "passed",
            previewVerified: previewState?.verified === true,
          });
          messages.push({ role: "user", content: transitionNudge });
          log.push({ role: "user", content: transitionNudge, isNudge: true, createdAt: Date.now() });
        }
      } catch (error) {
        logProviderCall({
          uid,
          sessionId,
          provider: candidateProviders[0]?.id ?? "unknown",
          model: candidateProviders[0]?.model ?? "unknown",
          turnId: `${sessionId}_${startedAt}`,
          success: false,
          latencyMs: Date.now() - callStartedAt,
          // Phase 41C: worst-case attempt count for telemetry only (the
          // real count is unknowable here - the error already discarded
          // it) - summed per-provider budgets, since a fallback provider
          // can now have a smaller one than the default.
          attempts: candidateProviders.reduce((sum, p) => sum + (p.maxAttempts ?? 4), 0),
        });
        terminationReason = signal.aborted ? "cancelled" : "provider_error";
        // Phase 41C §"USER-FACING ACTIVITY": never expose raw provider
        // internals (HTTP status, "NVIDIA", model names) in the normal
        // log - the technical detail still lives in providerTelemetry's
        // own logs for debugging.
        log.push({
          role: "assistant",
          content:
            error instanceof AgentProviderError && error.kind === "cancelled"
              ? "(cancelled)"
              : "Huddle couldn't finish this build right now. Your project is saved and can be continued.",
          createdAt: Date.now(),
        });
        break;
      } finally {
        clearInterval(claimHeartbeat);
      }

      messages.push(step.message);
      if (typeof step.message.content === "string" && step.message.content) {
        log.push({ role: "assistant", content: step.message.content, createdAt: Date.now() });
      }

      const toolCalls = step.message.tool_calls ?? [];
      if (toolCalls.length === 0) {
        // Root cause (2026-08-22, Phase 15 investigation, Phase 8): this
        // used to also require step.message.content to be empty before
        // recognizing a truncated step - live-reproduced (Phase 14,
        // Benchmark B) that a response CAN be truncated (finish_reason
        // "length") while still having emitted a few words of visible
        // commentary first ("Now I'll create the collection page...")
        // before running out of budget - that partial sentence made the
        // old `!step.message.content` check false, so a genuine
        // mid-plan truncation got reported as terminationReason "done"
        // (a deliberate stop), when the model had explicitly stated
        // unfinished work and never got the chance to act on it. Having
        // SOME visible text doesn't mean the model chose to stop - only
        // an untruncated response with no tool call does.
        if (step.truncated) {
          // Phase 39C: this used to terminate the whole turn on the
          // FIRST provider-side truncation, which threw away every
          // tool result the turn had already earned. Live-reproduced
          // (2026-08-28, session VZ54JRXfEATLzAtji1hi): iteration 1
          // reasoned briefly and successfully called
          // scaffold_nextjs_project (7 real files written); iteration 2
          // then spent essentially its whole 8000-token output budget
          // on hidden reasoning tokens (enable_thinking is on for this
          // provider - reasoning and tool-call emission compete for ONE
          // budget), emitted ~175 visible chars, and returned
          // finish_reason "length" with zero tool calls. The turn died
          // with a perfectly good scaffold on disk and nothing wrong
          // with the project at all.
          //
          // This is a transient provider-side outcome, not a decision
          // by the model to stop - so it now gets the same bounded
          // second chance every other transient failure in this system
          // already gets. Retrying is safe by construction: tool calls
          // only ever execute AFTER a step returns (see
          // providerRecovery.ts's own doc comment on the same
          // property), so a retry can never re-run an earlier tool
          // call, and `messages`/`taskState` are only appended to -
          // the retry genuinely continues from the current state
          // rather than restarting anything.
          if (telemetry.truncatedNoActionRetries < MAX_TRUNCATED_NO_ACTION_RETRIES) {
            telemetry.truncatedNoActionRetries++;
            // Deliberately terse, and only ever injected on this exact
            // path - the normal reasoning behavior the system prompt
            // asks for is unchanged for every other step.
            const recovery =
              "The previous response used its output budget before producing the next tool call. Continue immediately from the current project state. Do not provide extended planning or explanation. Take the next required tool action now.";
            messages.push({ role: "user", content: recovery });
            log.push({ role: "user", content: recovery, isNudge: true, createdAt: Date.now() });
            telemetry.iterationDurationsMs.push(Date.now() - iterationStartedAt);
            await turnRef.update({
              log,
              telemetry,
              providerMessages: messages,
              ...(taskState ? { taskState } : {}),
              ...(buildState ? { buildState } : {}),
              ...(previewState ? { previewState } : {}),
            });
            continue;
          }

          /**
           * Phase 41C §5: truncation exhausted its own bounded retry -
           * before giving up on the whole turn, try the next provider
           * (if one hasn't been tried yet this turn). Genuinely
           * provider-side and transient (see the comment above), so it's
           * treated exactly like an AgentProviderError exhaustion for
           * fallback purposes - the same committedProviderIndex
           * mechanism, the same one-time transition nudge. The new
           * provider gets its OWN fresh truncatedNoActionRetries budget
           * (reset here) rather than inheriting an already-spent one -
           * this specific failure mode hasn't happened to it yet.
           */
          if (committedProviderIndex + 1 < agentProviders.length) {
            const fromProvider = agentProviders[committedProviderIndex];
            committedProviderIndex++;
            telemetry.truncatedNoActionRetries = 0;
            telemetry.providerFallback = {
              activated: true,
              fromProviderId: fromProvider?.id ?? null,
              toProviderId: agentProviders[committedProviderIndex]?.id ?? null,
              reason: "truncated_no_action_exhausted",
            };
            log.push({
              role: "assistant",
              content: "Huddle switched to a backup model and continued.",
              createdAt: Date.now(),
            });
            const transitionNudge = buildProviderTransitionNudge(taskState, {
              buildPassed: buildState?.status === "passed",
              previewVerified: previewState?.verified === true,
            });
            messages.push({ role: "user", content: transitionNudge });
            log.push({ role: "user", content: transitionNudge, isNudge: true, createdAt: Date.now() });
            telemetry.iterationDurationsMs.push(Date.now() - iterationStartedAt);
            await turnRef.update({
              log,
              telemetry,
              providerMessages: messages,
              ...(taskState ? { taskState } : {}),
              ...(buildState ? { buildState } : {}),
              ...(previewState ? { previewState } : {}),
            });
            continue;
          }

          terminationReason = "truncated_no_action";
          log.push({
            role: "assistant",
            content: "(ran out of response budget before taking any action)",
            createdAt: Date.now(),
          });
          break;
        }

        // Phase 16 completion gate: a candidate "done" is not accepted
        // at face value while the model's own tracked plan still shows
        // unfinished work - see taskProgress.ts's own doc comment for
        // why (the core invariant: the original objective outranks
        // whatever subproblem the model was just focused on). Bounded
        // to one nudge so a model that insists it's done isn't bounced
        // forever.
        if (
          hasUnresolvedSubgoals(taskState) &&
          telemetry.incompleteObjectiveNudgesSent < MAX_INCOMPLETE_OBJECTIVE_NUDGES
        ) {
          telemetry.incompleteObjectiveNudgesSent++;
          const nudge = buildIncompleteObjectiveNudge(taskState as TaskState);
          messages.push({ role: "user", content: nudge });
          log.push({ role: "user", content: nudge, isNudge: true, createdAt: Date.now() });
          telemetry.iterationDurationsMs.push(Date.now() - iterationStartedAt);
          await turnRef.update({ log, telemetry, providerMessages: messages });
          continue;
        }

        // Phase 21 completion gate: real tool-result evidence, not just
        // tracked subgoal status - a model could mark "verify the
        // browser" done while its own last view_preview call actually
        // failed. Independent of the subgoal check above (both can fire
        // in the same turn, on different candidate "done" attempts).
        if (
          lastViewPreviewOk === false &&
          telemetry.blockingPreviewNudgesSent < MAX_BLOCKING_PREVIEW_NUDGES
        ) {
          telemetry.blockingPreviewNudgesSent++;
          const nudge = buildBlockingPreviewNudge(taskState);
          messages.push({ role: "user", content: nudge });
          log.push({ role: "user", content: nudge, isNudge: true, createdAt: Date.now() });
          telemetry.iterationDurationsMs.push(Date.now() - iterationStartedAt);
          await turnRef.update({ log, telemetry, providerMessages: messages });
          continue;
        }

        // Phase 39 (Batch 1) hard termination contract: for a turn
        // whose actual work is a web project, "done" requires real,
        // orchestrator-checked evidence - not just an absence of
        // tracked/blocked subgoals and not just "view_preview didn't
        // explicitly fail" (the two gates above). isWebProjectTurn is
        // deliberately code-derived, not model-declared: a scaffold
        // call this turn is unambiguous; an INHERITED projectContract
        // (continuation turns keep it across turns by design) only
        // counts alongside wroteFileThisTurn, so a follow-up turn that
        // does something unrelated on an existing web-project session
        // (e.g. create_presentation, no file writes) is never wrongly
        // gated on evidence it never needed to produce.
        const isWebProjectTurn = scaffoldCalledThisTurn || (Boolean(taskState?.projectContract) && wroteFileThisTurn);
        const filesWritten = hasRealFilesAtTurnStart || wroteFileThisTurn;
        const evidenceMissing =
          isWebProjectTurn && (!filesWritten || buildState?.status !== "passed" || previewState?.verified !== true);

        // Phase 40 §6A: if the build budget is spent and the build
        // still never passed, nudging again is pointless - the model
        // has no way to produce the missing evidence, because the one
        // tool that could is now refused. Terminate honestly with the
        // specific reason instead of spending the evidence nudge on an
        // impossible request.
        if (
          evidenceMissing &&
          buildState?.status !== "passed" &&
          (buildState?.attempt ?? 0) >= MAX_BUILD_ATTEMPTS
        ) {
          terminationReason = "build_repair_budget_exhausted";
          break;
        }

        if (evidenceMissing && telemetry.evidenceNudgesSent < MAX_EVIDENCE_NUDGES) {
          telemetry.evidenceNudgesSent++;
          const nudge = buildEvidenceNudge(taskState, {
            filesWritten,
            buildPassed: buildState?.status === "passed",
            previewVerified: previewState?.verified === true,
          });
          messages.push({ role: "user", content: nudge });
          log.push({ role: "user", content: nudge, isNudge: true, createdAt: Date.now() });
          telemetry.iterationDurationsMs.push(Date.now() - iterationStartedAt);
          await turnRef.update({
            log,
            telemetry,
            providerMessages: messages,
            ...(buildState ? { buildState } : {}),
            ...(previewState ? { previewState } : {}),
          });
          continue;
        }

        // Phase 41: the nudge above is bounded to MAX_INCOMPLETE_OBJECTIVE_NUDGES
        // (1) so a model that insists it's done isn't bounced forever - but that
        // left a real gap. When the nudge budget is spent and the model still has
        // genuinely unresolved (pending/in_progress, never explicitly marked
        // "blocked") subgoals, hasOnlyBlockedRemaining is false, and this used to
        // fall through to "done" by default - silently reporting an unbuilt,
        // unverified, never-previewed project as a full success. Live-reproduced:
        // a restaurant build stopped after one nudge with "Build Contact page" and
        // "Verify build passes" both still pending, npm run build/view_preview
        // never called even once, and still landed as terminationReason "done".
        // hasOnlyBlockedRemaining already correctly distinguishes "the model
        // explicitly gave up on specific items" ("blocked") from "everything
        // finished" ("done") - the missing case is "neither": still unresolved,
        // not explicitly blocked, just stopped. That's the same "ran out of
        // runway before finishing" situation step_budget_exhausted already means,
        // and reusing it also gets the existing budget-exhausted summary (below)
        // for free instead of silently reporting nothing.
        //
        // Phase 39 (Batch 1) adds one more branch: even with no
        // unresolved/blocked subgoals, a web-project turn missing real
        // build/preview/file evidence (evidenceMissing, computed above,
        // still true after the nudge budget was already spent) lands on
        // "evidence_incomplete" rather than a false "done" - the same
        // "self-reported completion isn't backed by real facts" gap
        // "blocked" was originally added to close, extended to evidence
        // the model can't just self-attest.
        terminationReason = hasOnlyBlockedRemaining(taskState)
          ? "blocked"
          : hasUnresolvedSubgoals(taskState)
            ? "step_budget_exhausted"
            : evidenceMissing
              ? "evidence_incomplete"
              : "done";
        break;
      }

      const writeFileCalls = toolCalls.filter((tc) => tc.type === "function" && tc.function.name === "write_file");
      const progressCalls = toolCalls.filter((tc) => tc.type === "function" && tc.function.name === "update_progress");
      const otherCalls = toolCalls.filter(
        (tc) =>
          !(tc.type === "function" && tc.function.name === "write_file") &&
          !(tc.type === "function" && tc.function.name === "update_progress")
      );

      const iterationActions: IterationAction[] = [];

      if (progressCalls.length > 0) {
        for (const tc of progressCalls) {
          if (tc.type !== "function") continue;
          telemetry.toolCalls++;

          const parsed = parseTaskStateUpdate(tc.function.arguments, Date.now());
          const resultContent = parsed.ok
            ? `Tracked. ${parsed.taskState.subgoals.length} subgoal(s): ${parsed.taskState.subgoals
                .map((s) => `${s.description} [${s.status}]`)
                .join("; ")}${parsed.taskState.projectContract ? " | project contract recorded." : ""}${parsed.taskState.manifest ? " | project manifest recorded." : ""}`
            : `INVALID_TOOL_ARGUMENTS: ${parsed.error}`;

          if (parsed.ok) {
            // Phase 18: projectContract is merge-persisted, not
            // required every call (unlike objective/subgoals) - a call
            // that only updates subgoal statuses doesn't wipe out an
            // already-declared contract. See ProjectContract's own doc
            // comment for why this matters (a continuation turn must
            // not "forget" pathAliases = NONE). Conditional spread, not
            // a direct assignment: Firestore rejects an explicit
            // `undefined` field value even nested inside an object (the
            // exact class of bug fixed for taskState itself in Phase
            // 16) - the merged contract must be OMITTED, not present as
            // undefined, when neither this call nor any prior one set one.
            const mergedContract = parsed.taskState.projectContract ?? taskState?.projectContract;
            // Phase 42 §3: manifest gets the exact same merge-persist
            // treatment - a later call that only updates subgoal status
            // must not silently erase an already-stated fileBudget/plan.
            const mergedManifest = parsed.taskState.manifest ?? taskState?.manifest;
            taskState = {
              ...parsed.taskState,
              ...(mergedContract ? { projectContract: mergedContract } : {}),
              ...(mergedManifest ? { manifest: mergedManifest } : {}),
            };
            telemetry.successfulActions++;
          } else {
            telemetry.failedActions++;
          }

          messages.push({ role: "tool", tool_call_id: tc.id, content: resultContent });
          log.push({ role: "tool", toolName: "update_progress", toolCallId: tc.id, content: resultContent, ok: parsed.ok, createdAt: Date.now() });
          // Deliberately excluded from the stagnation signature - this
          // is bookkeeping about the work, not the work itself, and
          // updating it every step (even with unchanged content)
          // shouldn't ever read as "the agent is stuck."
        }
      }

      if (writeFileCalls.length > 0) {
        // Decision logic (validation, dedup, partial-batch semantics)
        // lives in processWriteFileBatch - pure and unit-tested. This
        // is only the side effect (persist) and bookkeeping around it.
        // See that function's own doc comment for the exact bug this
        // closes (a missing path silently becoming the literal string
        // "undefined" and colliding every such call onto one doc).
        const batch = processWriteFileBatch(
          writeFileCalls.map((tc) => ({
            id: tc.id,
            argumentsJson: tc.type === "function" ? tc.function.arguments : "{}",
          }))
        );

        // Phase 39: silently substitute an unavailable brand/logo icon
        // (Github, Linkedin, ...) BEFORE the reject check even runs -
        // see autoFixBrandIcons' own doc comment for why this replaced
        // a reject-and-retry cycle that kept recurring live even with
        // strong prompt guidance in place. Applied to batch.toWrite's
        // own content in place, so both persistence and the contract
        // check below see the corrected file, never the original.
        const iconFixNotes = new Map<string, string>();
        for (const file of batch.toWrite) {
          const fix = autoFixBrandIcons(file.content);
          if (fix) {
            file.content = fix.content;
            iconFixNotes.set(
              file.path,
              ` (auto-corrected: ${fix.fixed.map((f) => `${f.from}→${f.to}`).join(", ")} - brand/logo icons aren't available in lucide-react, substituted automatically, no action needed. For the real icon next time, import from react-icons/fa or react-icons/si instead.)`
            );
          }
        }

        // Phase 18: reject a write that violates the project's own
        // declared conventions (e.g. an "@/" import when no alias is
        // configured) BEFORE it's persisted - catches the mistake at
        // generation time instead of a runtime/build error minutes
        // later. Only ever active once update_progress has actually
        // set a projectContract - see checkImportConventions's own doc
        // comment for exactly what it does and does not check.
        const contractViolations = new Map<string, string>();
        for (const file of batch.toWrite) {
          const violation = checkImportConventions(file.path, file.content, taskState?.projectContract);
          if (violation) contractViolations.set(file.path, violation);
        }
        const toPersist = batch.toWrite.filter((f) => !contractViolations.has(f.path));

        if (toPersist.length > 0) {
          await batchWriteSessionFiles(
            sessionId,
            toPersist.map((f) => ({ ...f, updatedBy: "agent" as const }))
          );
        }

        writeFileCalls.forEach((tc, i) => {
          telemetry.toolCalls++;
          const structural = batch.results[i];

          // Phase 39 (Batch 1 follow-up): a call may now describe
          // several files at once (see validateWriteFileCallArgs) - the
          // structural result already carries one outcome per file
          // (dedup/malformed-json only). Contract violations and icon
          // auto-fixes are checked here, per file, since they depend on
          // taskState.projectContract, which processWriteFileBatch
          // deliberately doesn't know about (kept pure/Firestore-free).
          let filePaths: Array<{ path: string; content: string }> = [];
          try {
            const args = JSON.parse(tc.type === "function" ? tc.function.arguments : "{}");
            if (Array.isArray(args.files)) {
              filePaths = args.files
                .filter((f: unknown): f is { path: string; content: string } => {
                  const rec = f as Record<string, unknown> | null;
                  return typeof rec?.path === "string" && typeof rec?.content === "string";
                })
                .map((f: { path: string; content: string }) => ({ path: f.path, content: f.content }));
            } else if (typeof args.path === "string" && typeof args.content === "string") {
              filePaths = [{ path: args.path, content: args.content }];
            }
          } catch {
            // Malformed args already reported via structural.ok below - the signature just won't be meaningful for this call.
          }

          // Three real outcomes per file, not a boolean: "written" (persisted),
          // "superseded" (a later call in this same step won the same path -
          // expected, not an error), "violation" (rejected for a project-
          // convention violation - a real error). Only "violation" should
          // ever count as a failure; "superseded" is the model's intent
          // still being honored, just by a different call.
          type EffectiveFile = { path: string; status: "written" | "superseded" | "violation"; note?: string; violationMessage?: string };
          const effectiveFiles: EffectiveFile[] = structural.files.map((f) => {
            if (!f.written) return { path: f.path, status: "superseded" };
            const violation = contractViolations.get(f.path);
            if (violation) return { path: f.path, status: "violation", violationMessage: `INVALID_TOOL_ARGUMENTS (content): ${violation}` };
            const iconFixNote = iconFixNotes.get(f.path);
            return { path: f.path, status: "written", ...(iconFixNote ? { note: iconFixNote } : {}) };
          });

          const hasViolation = effectiveFiles.some((f) => f.status === "violation");
          const anyWritten = effectiveFiles.some((f) => f.status === "written");
          // Structural failure (malformed/invalid, zero files identified) or
          // a real convention violation are the only failure cases -
          // superseded-only is still a successful, well-formed call.
          const allOk = structural.ok && !hasViolation;

          let combinedMessage: string;
          if (effectiveFiles.length === 0) {
            // Malformed/structurally invalid call - original message stands as-is.
            combinedMessage = structural.message;
          } else if (effectiveFiles.length === 1) {
            const f = effectiveFiles[0];
            combinedMessage = f.violationMessage ?? `${structural.message}${f.note ?? ""}`;
          } else {
            const written = effectiveFiles.filter((f) => f.status === "written");
            const violated = effectiveFiles.filter((f) => f.status === "violation");
            const superseded = effectiveFiles.filter((f) => f.status === "superseded");
            const parts: string[] = [];
            if (written.length > 0) {
              parts.push(
                `Wrote ${written.length} file(s): ${written.map((f) => `${f.path}${f.note ?? ""}`).join(", ")}.`
              );
            }
            if (violated.length > 0) {
              parts.push(`Rejected ${violated.length} file(s) for a project-convention violation: ${violated.map((f) => `${f.path} (${f.violationMessage})`).join("; ")}`);
            }
            if (superseded.length > 0) {
              parts.push(
                `${superseded.length} file(s) in this same call were superseded by a later write_file call to the same path in this same step: ${superseded.map((f) => f.path).join(", ")} - that later call's content is what was actually persisted.`
              );
            }
            combinedMessage = parts.join(" ");
          }

          if (allOk) telemetry.successfulActions++;
          else telemetry.failedActions++;
          if (anyWritten) wroteFileThisTurn = true;

          // Phase 42 §2/§13: track distinct NEW files against the
          // budget and append the warning to THIS call's own result
          // text (not a separate message) - the model sees it in the
          // same round trip as the write that crossed the line. Never
          // blocks the write itself (fileBudget.ts's own doc comment).
          // Recomputed from taskState.manifest each time (not cached
          // once) since the manifest can arrive on the first
          // update_progress call, which may land before or after the
          // first write_file in the same iteration's tool_calls.
          const newlyWrittenPaths = effectiveFiles.filter((f) => f.status === "written").map((f) => f.path);
          for (const p of newlyWrittenPaths) wroteFilePaths.add(p);
          if (!telemetry.fileBudgetWarningSent && newlyWrittenPaths.length > 0) {
            const budget = computeFileBudget(taskState?.manifest);
            if (wroteFilePaths.size > budget) {
              telemetry.fileBudgetWarningSent = true;
              combinedMessage += buildFileBudgetWarning(wroteFilePaths.size, budget, newlyWrittenPaths);
            }
          }

          messages.push({ role: "tool", tool_call_id: tc.id, content: combinedMessage });

          if (effectiveFiles.length === 0) {
            log.push({
              role: "tool",
              toolName: "write_file",
              toolCallId: tc.id,
              content: combinedMessage,
              ok: false,
              createdAt: Date.now(),
            });
          } else {
            // Phase 24: structured path for change-visibility UI - see
            // TurnMessage.path's own doc comment. One log ROW per file
            // (even though this was one tool_call/one provider message),
            // so a batched call still shows each real file change
            // individually - only set (with a real path) when that
            // specific file was actually persisted.
            for (const f of effectiveFiles) {
              log.push({
                role: "tool",
                toolName: "write_file",
                toolCallId: tc.id,
                content: f.violationMessage ?? combinedMessage,
                ok: f.status !== "violation",
                createdAt: Date.now(),
                ...(f.status === "written" ? { path: f.path } : {}),
              });
            }
          }

          // Stagnation signature: joins every file this call touched, by
          // path and content - two calls writing the SAME set of files
          // with the SAME content read as a genuine repeat; any real
          // difference (even to one file among several) does not.
          const argsKey = filePaths.length > 0 ? filePaths.map((f) => f.path).join(",") : "unknown";
          const combinedContent = filePaths.map((f) => f.content).join(" ");
          iterationActions.push({ toolName: "write_file", argsKey, ok: allOk, resultContent: combinedContent });
        });
      }

      for (const tc of otherCalls) {
        if (tc.type !== "function") continue;
        telemetry.toolCalls++;

        /**
         * Phase 40 §6A/§6B/§7: budgets enforced HERE, at the one
         * boundary every expensive tool call passes through, rather
         * than as prompt text the model may ignore. A refusal is
         * returned as an ordinary failed tool result so the model sees
         * a clear, machine-readable reason and can react - it is never
         * a silent no-op, and never a new retry loop.
         */
        const budgetRefusal = refuseForBudget(tc, {
          buildAttempts: buildState?.attempt ?? 0,
          maxBuildAttempts: MAX_BUILD_ATTEMPTS,
          runtimeRestarts: runtimeRestartsThisTurn,
          maxRuntimeRestarts: MAX_RUNTIME_RESTARTS,
          deadlinePassed: Date.now() >= turnDeadline,
        });

        const result = budgetRefusal
          ? { ok: false, content: budgetRefusal }
          : await executeTool(
              sessionId,
              tc,
              tc.function.name === "view_preview"
                ? { previousPreview: previousPreviewCheck, consecutiveVisionFailures }
                : {}
            );

        if (!budgetRefusal && isRuntimeRestartCall(tc)) runtimeRestartsThisTurn++;

        if (result.ok) {
          telemetry.successfulActions++;
          if (tc.function.name === "scaffold_nextjs_project") scaffoldCalledThisTurn = true;
        } else telemetry.failedActions++;

        if (result.isFirstSuccessfulRun && telemetry.timeToFirstRunMs === null) {
          telemetry.timeToFirstRunMs = Date.now() - startedAt;
        }
        if (result.isFirstSuccessfulPreview && telemetry.timeToFirstPreviewMs === null) {
          telemetry.timeToFirstPreviewMs = Date.now() - startedAt;
        }
        if (result.buildEvidence) {
          // Phase 42 §6: the first build ATTEMPT, pass or fail - "is
          // the agent building early," not "did it eventually pass."
          if (telemetry.timeToFirstBuildMs === null) {
            telemetry.timeToFirstBuildMs = Date.now() - startedAt;
          }
          // Phase 39 (Batch 1): attempt increments across repeated
          // build commands this turn - a real, orchestrator-tracked
          // fact, not text the model has to remember. Always reflects
          // the MOST RECENT build's outcome (a later passing build
          // supersedes an earlier failure, and vice versa).
          const now = Date.now();
          buildState = {
            status: result.buildEvidence.ok ? "passed" : "failed",
            attempt: (buildState?.attempt ?? 0) + 1,
            startedAt: now,
            completedAt: now,
            command: result.buildEvidence.command,
            ...(result.buildEvidence.ok ? {} : { errorSummary: result.buildEvidence.errorSummary }),
          };
        }
        if (tc.function.name === "view_preview") {
          lastViewPreviewOk = result.ok;
          if (result.previewEvidence) {
            previewState = {
              verified: result.previewEvidence.verified,
              checkedAt: Date.now(),
              previewUrl: result.previewEvidence.previewUrl,
              ...(result.previewEvidence.reason ? { reason: result.previewEvidence.reason } : {}),
            };
          }
          if (result.previewCheck) {
            consecutiveVisionFailures = result.previewCheck.visionOk ? 0 : consecutiveVisionFailures + 1;
            previousPreviewCheck =
              result.previewCheck.visionOk && result.previewCheck.critique && result.previewCheck.provider
                ? {
                    screenshotHash: result.previewCheck.screenshotHash,
                    critique: result.previewCheck.critique,
                    provider: result.previewCheck.provider,
                  }
                : undefined;
          }
        }

        let argsKey = tc.function.name;
        try {
          const args = JSON.parse(tc.function.arguments || "{}");
          argsKey = String(args.command ?? args.path ?? tc.function.name);
        } catch {
          // Malformed args - fall back to the tool name alone as the key.
        }
        iterationActions.push({ toolName: tc.function.name, argsKey, ok: result.ok, resultContent: result.content });

        messages.push({ role: "tool", tool_call_id: tc.id, content: result.content });
        log.push({
          role: "tool",
          toolName: tc.function.name,
          toolCallId: tc.id,
          content: result.content,
          ok: result.ok,
          argsSummary: argsKey,
          createdAt: Date.now(),
        });
      }

      // Phase 16 progress detection: evidence-based, not a step count -
      // see taskProgress.ts's detectStagnation. Fires only on hard
      // evidence (the exact same actions producing the exact same
      // results, repeated), so genuinely different repeated checks
      // (e.g. polling a dev server that's still starting) never trip it.
      const signature = buildIterationSignature(iterationActions);
      recentSignatures.push(signature);
      const isStagnating = detectStagnation(recentSignatures, STAGNATION_THRESHOLD);
      if (isStagnating) telemetry.repeatedIterations++;

      const remainingIterations = STEP_BUDGET - i - 1;

      /**
       * Phase 40 §10: EXACTLY ONE recovery nudge per iteration, chosen
       * by explicit priority. These were two independent `if` blocks
       * with no `else` between them, and their trigger conditions
       * describe the same situation - a stuck late-stage build - so
       * both fired together and handed the model two contradictory
       * instructions in one turn ("change your approach" alongside
       * "stop changing things and finish"). Stagnation wins: being
       * stuck is a harder, more specific signal than merely being near
       * the end of the budget, and finish-mode advice is actively
       * counterproductive while the current approach isn't working.
       * (The three completion gates above each end in `continue`, so
       * they are already mutually exclusive with this block and with
       * each other - this closes the one remaining overlap.)
       *
       * Phase 42 §7: buildEarly slots between the two - not as urgent
       * as an actively stuck loop, but more actionable than "consider
       * wrapping up" (which only fires late anyway): if several files
       * exist and nothing has been built yet, proving that now is
       * useful at ANY point in the turn, not just near the end.
       */
      const stagnationNudgeDue = isStagnating && telemetry.stagnationNudgesSent < MAX_STAGNATION_NUDGES;
      const buildEarlyNudgeDue =
        !telemetry.buildEarlyNudgeSent && buildState === undefined && wroteFilePaths.size >= EARLY_BUILD_FILE_THRESHOLD;
      const finishModeNudgeDue =
        remainingIterations > 0 &&
        remainingIterations <= FINISH_MODE_REMAINING_THRESHOLD &&
        hasUnresolvedSubgoals(taskState) &&
        telemetry.finishModeNudgesSent < MAX_FINISH_MODE_NUDGES;

      if (stagnationNudgeDue) {
        telemetry.stagnationNudgesSent++;
        const nudge = buildStagnationNudge(taskState);
        messages.push({ role: "user", content: nudge });
        log.push({ role: "user", content: nudge, isNudge: true, createdAt: Date.now() });
        recentSignatures.length = 0; // give the model a genuinely fresh window after the nudge
      } else if (buildEarlyNudgeDue) {
        telemetry.buildEarlyNudgeSent = true;
        const nudge = buildEarlyBuildNudge(wroteFilePaths.size);
        messages.push({ role: "user", content: nudge });
        log.push({ role: "user", content: nudge, isNudge: true, createdAt: Date.now() });
      } else if (finishModeNudgeDue) {
        telemetry.finishModeNudgesSent++;
        const nudge = buildFinishModeNudge(taskState, remainingIterations);
        messages.push({ role: "user", content: nudge });
        log.push({ role: "user", content: nudge, isNudge: true, createdAt: Date.now() });
      }

      telemetry.iterationDurationsMs.push(Date.now() - iterationStartedAt);
      await turnRef.update({
        log,
        telemetry,
        providerMessages: messages,
        ...(taskState ? { taskState } : {}),
        ...(buildState ? { buildState } : {}),
        ...(previewState ? { previewState } : {}),
      });

      // Phase 39 (Batch 1) split-brain guard: this doubles as the
      // turn's heartbeat AND a check that this process still owns the
      // claim. A `false` here means claimTurnAuthoritative decided
      // this claim went stale (TURN_CLAIM_STALE_MS of silence) and was
      // reclaimed by a newer attempt - astronomically rare given a
      // real per-iteration write just happened above, but if it does
      // happen, this process must stop touching Firestore immediately
      // rather than race the new claimant for the rest of the budget.
      if (!(await heartbeatTurnClaim(sessionId, turnToken))) {
        terminationReason = "claim_expired";
        break;
      }
    }

    if (terminationReason === "step_budget_exhausted" || terminationReason === "evidence_incomplete") {
      // Phase 16 / Phase 8: never let the budget run out silently - the
      // final log entry states OBJECTIVE/COMPLETED/BLOCKED/LAST
      // DIAGNOSIS/NEXT RECOMMENDED ACTION from whatever the model
      // itself tracked, so hitting the budget while stuck still leaves
      // a genuinely useful record instead of just stopping. Phase 39
      // (Batch 1): the same applies to evidence_incomplete - a self-
      // reported "done" that the orchestrator rejected for missing
      // build/preview/file evidence deserves the same real record, not
      // just the bare termination label.
      const lastAssistantEntry = [...log].reverse().find((m) => m.role === "assistant");
      log.push({
        role: "assistant",
        content: buildBudgetExhaustedSummary(taskState, lastAssistantEntry?.content ?? null),
        createdAt: Date.now(),
      });
    }
  } catch (error) {
    // Anything that throws outside the provider-call try/catch above
    // (a tool executor bug, a Firestore write rejecting bad input) used
    // to propagate past this function entirely, leaving
    // terminationReason at its unset default - which read as "done"/
    // "step_budget_exhausted" even though the turn actually crashed.
    // Confirmed live: an unhandled Firestore "undefined value" error
    // from a run_command call with no cwd argument reported as
    // step_budget_exhausted after only 9 of 40 iterations. Caught here
    // so a real crash is never misreported as a deliberate stop.
    terminationReason = "internal_error";
    console.error(`Agent turn ${sessionId} crashed mid-loop:`, error);
    log.push({
      role: "assistant",
      content: `(internal error: ${error instanceof Error ? error.message : String(error)})`,
      createdAt: Date.now(),
    });
  } finally {
    telemetry.totalDurationMs = Date.now() - startedAt;
    telemetry.terminationReason = terminationReason;

    await turnRef.update({
      active: false,
      log,
      telemetry,
      providerMessages: messages,
      ...(taskState ? { taskState } : {}),
      ...(buildState ? { buildState } : {}),
      ...(previewState ? { previewState } : {}),
      cancelledAt: terminationReason === "cancelled" ? Date.now() : null,
    });

    // Phase 39 (Batch 1): release the authoritative claim - a no-op if
    // this turn's claim was already reclaimed as stale (the split-brain
    // guard above already broke out of the loop in that case), so a
    // late-finishing orphaned process can never clobber a newer,
    // legitimate claim's state.
    await releaseTurnClaim(sessionId, turnToken, terminationReason);

    unregisterTurn(sessionId);
  }
}
