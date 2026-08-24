import "server-only";

import { adminDb } from "@/lib/firebase/admin";
import { resolveAgentProviders } from "@/lib/agent/providerResolution";
import { generateStepWithRecovery } from "@/lib/agent/providerRecovery";
import { logProviderCall } from "@/lib/agent/providerTelemetry";
import { buildTeammateLabels } from "@/lib/presence/attribution";
import { AGENT_TOOLS } from "@/lib/agent/tools";
import { SYSTEM_PROMPT } from "@/lib/agent/prompt";
import { executeTool } from "@/lib/agent/executeTool";
import { batchWriteSessionFiles } from "@/lib/files/fileStore";
import { registerTurn, unregisterTurn } from "@/lib/agent/turnRegistry";
import { processWriteFileBatch } from "@/lib/agent/processWriteFileBatch";
import { checkImportConventions } from "@/lib/agent/importConventionCheck";
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
} from "@/lib/agent/taskProgress";

import type { IterationAction } from "@/lib/agent/taskProgress";
import type {
  AgentTurn,
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

function emptyTelemetry(): TurnTelemetry {
  return {
    iterations: 0,
    toolCalls: 0,
    successfulActions: 0,
    failedActions: 0,
    iterationDurationsMs: [],
    timeToFirstRunMs: null,
    timeToFirstPreviewMs: null,
    totalDurationMs: null,
    terminationReason: null,
    repeatedIterations: 0,
    stagnationNudgesSent: 0,
    incompleteObjectiveNudgesSent: 0,
    finishModeNudgesSent: 0,
    blockingPreviewNudgesSent: 0,
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

  try {
    for (let i = 0; i < STEP_BUDGET; i++) {
      if (signal.aborted) {
        terminationReason = "cancelled";
        break;
      }

      telemetry.iterations++;
      const iterationStartedAt = Date.now();

      let step;
      const callStartedAt = Date.now();
      try {
        const result = await generateStepWithRecovery(agentProviders, messages, AGENT_TOOLS, signal);
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
      } catch (error) {
        logProviderCall({
          uid,
          sessionId,
          provider: agentProviders[0]?.id ?? "unknown",
          model: agentProviders[0]?.model ?? "unknown",
          turnId: `${sessionId}_${startedAt}`,
          success: false,
          latencyMs: Date.now() - callStartedAt,
          attempts: agentProviders.length * 3,
        });
        terminationReason = signal.aborted ? "cancelled" : "provider_error";
        log.push({
          role: "assistant",
          content: `(step failed: ${error instanceof Error ? error.message : String(error)})`,
          createdAt: Date.now(),
        });
        break;
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

        terminationReason = hasOnlyBlockedRemaining(taskState) ? "blocked" : "done";
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
                .join("; ")}${parsed.taskState.projectContract ? " | project contract recorded." : ""}`
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
            taskState = {
              ...parsed.taskState,
              ...(mergedContract ? { projectContract: mergedContract } : {}),
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

          // Signature uses the file's own content, not the "Wrote X."
          // acknowledgment - two writes to the same path with genuinely
          // different (fixed) content must NOT read as a repeat, or
          // real iterative editing would falsely trigger stagnation.
          let path = "unknown";
          let content = "";
          try {
            const args = JSON.parse(tc.type === "function" ? tc.function.arguments : "{}");
            if (typeof args.path === "string") path = args.path;
            if (typeof args.content === "string") content = args.content;
          } catch {
            // Malformed args already reported via structural.ok below - the signature just won't be meaningful for this call.
          }

          const violation = structural.ok ? contractViolations.get(path) : undefined;
          const result = violation
            ? { ok: false, message: `INVALID_TOOL_ARGUMENTS (content): ${violation}` }
            : structural;

          if (result.ok) telemetry.successfulActions++;
          else telemetry.failedActions++;

          messages.push({ role: "tool", tool_call_id: tc.id, content: result.message });
          log.push({
            role: "tool",
            toolName: "write_file",
            toolCallId: tc.id,
            content: result.message,
            ok: result.ok,
            createdAt: Date.now(),
            // Phase 24: structured path for change-visibility UI - see
            // TurnMessage.path's own doc comment. Only set when the
            // write actually succeeded; a rejected/superseded call has
            // no real change to attribute a path to.
            ...(result.ok ? { path } : {}),
          });

          iterationActions.push({ toolName: "write_file", argsKey: path, ok: result.ok, resultContent: content });
        });
      }

      for (const tc of otherCalls) {
        if (tc.type !== "function") continue;
        telemetry.toolCalls++;

        const result = await executeTool(
          sessionId,
          tc,
          tc.function.name === "view_preview"
            ? { previousPreview: previousPreviewCheck, consecutiveVisionFailures }
            : {}
        );

        if (result.ok) telemetry.successfulActions++;
        else telemetry.failedActions++;

        if (result.isFirstSuccessfulRun && telemetry.timeToFirstRunMs === null) {
          telemetry.timeToFirstRunMs = Date.now() - startedAt;
        }
        if (result.isFirstSuccessfulPreview && telemetry.timeToFirstPreviewMs === null) {
          telemetry.timeToFirstPreviewMs = Date.now() - startedAt;
        }
        if (tc.function.name === "view_preview") {
          lastViewPreviewOk = result.ok;
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
      if (detectStagnation(recentSignatures, STAGNATION_THRESHOLD)) {
        telemetry.repeatedIterations++;
        if (telemetry.stagnationNudgesSent < MAX_STAGNATION_NUDGES) {
          telemetry.stagnationNudgesSent++;
          const nudge = buildStagnationNudge(taskState);
          messages.push({ role: "user", content: nudge });
          log.push({ role: "user", content: nudge, isNudge: true, createdAt: Date.now() });
          recentSignatures.length = 0; // give the model a genuinely fresh window after the nudge
        }
      }

      // Phase 21 finish mode: bounded, evidence-based (iterations
      // remaining), fires only while real work is still tracked as
      // unresolved - a turn that's already done has nothing to nudge
      // toward finishing. A prioritization nudge, not a coding
      // sequence - see buildFinishModeNudge's own doc comment.
      const remainingIterations = STEP_BUDGET - i - 1;
      if (
        remainingIterations > 0 &&
        remainingIterations <= FINISH_MODE_REMAINING_THRESHOLD &&
        hasUnresolvedSubgoals(taskState) &&
        telemetry.finishModeNudgesSent < MAX_FINISH_MODE_NUDGES
      ) {
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
      });
    }

    if (terminationReason === "step_budget_exhausted") {
      // Phase 16 / Phase 8: never let the budget run out silently - the
      // final log entry states OBJECTIVE/COMPLETED/BLOCKED/LAST
      // DIAGNOSIS/NEXT RECOMMENDED ACTION from whatever the model
      // itself tracked, so hitting the budget while stuck still leaves
      // a genuinely useful record instead of just stopping.
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
      cancelledAt: terminationReason === "cancelled" ? Date.now() : null,
    });

    unregisterTurn(sessionId);
  }
}
