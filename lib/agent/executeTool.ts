import "server-only";

import {
  batchWriteSessionFiles,
  deleteSessionFile,
  listSessionDirectory,
  readSessionFile,
} from "@/lib/files/fileStore";
import { dispatchRuntimeCommand } from "@/lib/runtime/commandRelay";
import { viewPreview } from "@/lib/preview/viewPreview";
import { normalizeShellCommand } from "@/lib/agent/normalizeShellCommand";
import { stripAnsi } from "@/lib/agent/stripAnsi";
import { validatePresentationPlan } from "@/lib/presentations/schema";
import { fitPresentationPlan } from "@/lib/presentations/fitSlideContent";
import { generatePptx } from "@/lib/presentations/generatePptx";
import { buildArtifactPath, buildPublicArtifactPath, buildPublicArtifactLocation } from "@/lib/artifacts/artifactPath";
import { createArtifact, getArtifact, markArtifactFailed, markArtifactReady } from "@/lib/artifacts/artifactStore";
import { buildNextjsScaffoldFiles } from "@/lib/scaffold/nextjsScaffold";
import { validateGenerateImageInput, validateEditImageInput } from "@/lib/images/schema";
import { activeImageProvider } from "@/lib/images/activeProvider";
import { mimeTypeExtension, extensionMimeType } from "@/lib/images/mimeExtension";
import { AgentProviderError } from "@/lib/agent/provider";

import type { ChatCompletionMessageToolCall } from "openai/resources/chat/completions";
import type { BackgroundRunReadiness } from "@/types/session";
import type { PreviousPreviewCheck } from "@/lib/preview/viewPreview";

/**
 * Phase 26 section 4: once vision has failed this many times in a row
 * this turn, view_preview's own result starts telling the model
 * outright to stop calling it and verify a different way - the exact,
 * live-observed Phase 25 failure mode (5 consecutive view_preview calls
 * against a rate-limited provider, no useful signal, iterations
 * burned) doesn't get a chance to repeat that far again.
 */
const VISION_FAILURE_STOP_THRESHOLD = 2;

export interface ExecuteToolContext {
  /** Phase 26 section 7: last successful capture's hash+critique this turn, if any - lets view_preview skip a whole vision call when nothing changed. */
  previousPreview?: PreviousPreviewCheck;
  /** Phase 26 section 4: how many consecutive view_preview calls this turn had a capture succeed but vision fail/be-unavailable. */
  consecutiveVisionFailures?: number;
}

const RUN_COMMAND_FOREGROUND_TIMEOUT_MS = 130_000;
// Phase 17: background commands now wait, bounded, for a real
// readiness signal (see runtimeSession.ts's quickReadinessCheck -
// QUICK_PORT_WAIT_MS + QUICK_READINESS_WAIT_MS worst case ~23s)
// instead of returning the instant the process spawns. Raised from
// 30s for headroom over that plus command-relay round-trip overhead;
// still small relative to the foreground ceiling above and the full
// cold-boot pipeline's own 90s+60s budgets.
const RUN_COMMAND_BACKGROUND_TIMEOUT_MS = 40_000;

export interface ToolExecutionResult {
  ok: boolean;
  content: string;
  /** Set true the first time a run_command call succeeds this turn - lets the loop record timeToFirstRunMs. */
  isFirstSuccessfulRun?: boolean;
  /** Set true the first time a view_preview call returns status "success" this turn - lets the loop record timeToFirstPreviewMs. */
  isFirstSuccessfulPreview?: boolean;
  /** Phase 26: set whenever a view_preview call's CAPTURE succeeded (regardless of vision outcome) - the loop threads this back in as the next call's ExecuteToolContext. */
  previewCheck?: {
    screenshotHash: string;
    visionOk: boolean;
    critique?: string;
    provider?: string;
  };
  /**
   * Phase 39 (Batch 1): set only when a foreground run_command's
   * command was recognized as a build command (isBuildCommand) - the
   * real orchestrator-checked fact behind AgentTurn.buildState, so
   * "did the build pass" is never re-derived from chat text.
   */
  buildEvidence?: {
    command: string;
    ok: boolean;
    /** Only set when ok is false - the same truncated tail already returned in `content`, not a fresh capture. */
    errorSummary?: string;
  };
  /**
   * Phase 39 (Batch 1): set on every view_preview call (success or
   * not) - the real orchestrator-checked fact behind
   * AgentTurn.previewState. Deliberately mirrors exactly what
   * viewPreview() itself already establishes (runtime responding +
   * preview URL set + a real captured response) rather than inventing
   * new verification logic.
   */
  previewEvidence?: {
    verified: boolean;
    previewUrl: string | null;
    /** Only set when verified is false. */
    reason?: string;
  };
}

/**
 * Phase 39 (Batch 1): the missing piece behind "BUILD PASSED" as a
 * real, orchestrator-checked fact - deliberately conservative (a false
 * negative just means one legitimate build isn't recorded, same as
 * pre-Batch-1 behavior; a false positive would wrongly treat an
 * unrelated command as build evidence, which is the more dangerous
 * direction). Only classifies foreground commands - `run_command`'s
 * background branch is never a build per the system prompt's own
 * sequencing guidance (builds are always foreground, "not the dev
 * server").
 */
const BUILD_COMMAND_RE = /\b(?:npm|yarn|pnpm)\s+run\s+build\b|\b(?:npm|yarn|pnpm)\s+build\b|\bnext\s+build\b/;
export function isBuildCommand(command: string): boolean {
  return BUILD_COMMAND_RE.test(command);
}

/**
 * Phase 40 §6B/§6D: recognizes a dev-server launch, whatever package
 * manager or script alias is used. Used for two distinct purposes -
 * counting restarts against MAX_RUNTIME_RESTARTS, and rejecting a
 * FOREGROUND launch outright (see the run_command case).
 */
const DEV_SERVER_COMMAND_RE = /\b(?:npm|yarn|pnpm)\s+(?:run\s+)?dev\b|\bnext\s+dev\b|\bvite\b(?!\s+build)/;
export function isDevServerCommand(command: string): boolean {
  return DEV_SERVER_COMMAND_RE.test(command);
}

/** Phase 40 §6B: a background dev-server launch is what "restart the runtime" concretely means at the tool boundary. */
export function isRuntimeRestartCall(call: ChatCompletionMessageToolCall): boolean {
  if (call.type !== "function" || call.function.name !== "run_command") return false;
  try {
    const args = JSON.parse(call.function.arguments || "{}") as { command?: string; background?: boolean };
    return args.background === true && isDevServerCommand(String(args.command ?? ""));
  } catch {
    return false;
  }
}

export interface BudgetState {
  buildAttempts: number;
  maxBuildAttempts: number;
  runtimeRestarts: number;
  maxRuntimeRestarts: number;
  deadlinePassed: boolean;
}

/**
 * Phase 40 §6A/§6B/§7: the single place that decides an expensive tool
 * call must not run. Returns the refusal message, or null to proceed.
 * Pure and unit-testable - the loop owns the counters, this owns the
 * policy, and no new watcher/timer/retry mechanism is involved.
 *
 * Deliberately narrow about WHICH tools it gates: only the ones that
 * cost real time or money (builds, runtime restarts, vision, image
 * generation). File reads/writes and progress updates are never
 * refused, so a turn that has run out of budget can still record
 * honestly what it did and finish cleanly rather than being cut off
 * mid-thought.
 */
export function refuseForBudget(
  call: ChatCompletionMessageToolCall,
  budget: BudgetState
): string | null {
  if (call.type !== "function") return null;
  const name = call.function.name;

  let args: { command?: string; background?: boolean } = {};
  try {
    args = JSON.parse(call.function.arguments || "{}");
  } catch {
    return null; // malformed args are the existing handlers' problem, not a budget matter
  }
  const command = String(args.command ?? "");

  if (name === "run_command" && isBuildCommand(command) && !args.background) {
    if (budget.buildAttempts >= budget.maxBuildAttempts) {
      return `BUDGET_EXHAUSTED (build): this turn has already used all ${budget.maxBuildAttempts} build attempts. Do not run another build. Either fix the specific error the last build reported, or record the remaining problem honestly via update_progress (mark the affected subgoal blocked with the exact error) and finish the turn.`;
    }
  }

  if (isRuntimeRestartCall(call) && budget.runtimeRestarts >= budget.maxRuntimeRestarts) {
    return `BUDGET_EXHAUSTED (runtime restart): this turn has already restarted the dev server ${budget.maxRuntimeRestarts} times. Restarting again will not help. Use the running server as-is, or record the problem via update_progress and finish the turn.`;
  }

  if (budget.deadlinePassed && (name === "view_preview" || name === "create_image" || name === "edit_image")) {
    return `BUDGET_EXHAUSTED (time): this turn has reached its time limit, so expensive operations (${name}) are no longer available. Record what you completed via update_progress and finish now.`;
  }

  return null;
}

/**
 * Executes every tool EXCEPT write_file, which the loop batches
 * separately (see lib/agent/loop.ts) - one Firestore write per step
 * regardless of how many files changed, per the required batching
 * adjustment.
 */
export async function executeTool(
  sessionId: string,
  call: ChatCompletionMessageToolCall,
  context: ExecuteToolContext = {}
): Promise<ToolExecutionResult> {
  if (call.type !== "function") {
    return { ok: false, content: "Unsupported tool call type." };
  }

  let args: Record<string, unknown>;
  try {
    args = JSON.parse(call.function.arguments || "{}");
  } catch {
    return { ok: false, content: "Couldn't parse this tool call's arguments as JSON." };
  }

  switch (call.function.name) {
    case "delete_file": {
      const path = String(args.path ?? "");
      await deleteSessionFile(sessionId, path);
      return { ok: true, content: `Deleted ${path}.` };
    }

    case "create_directory": {
      // No real directory objects in a flat doc-per-file model - a
      // directory exists implicitly once any file is written under
      // it. Acknowledged so the model doesn't loop retrying it.
      return { ok: true, content: `Noted - write a file under ${String(args.path ?? "")} to make it real.` };
    }

    case "scaffold_nextjs_project": {
      const projectName = typeof args.projectName === "string" ? args.projectName : undefined;
      const files = buildNextjsScaffoldFiles(projectName);
      await batchWriteSessionFiles(
        sessionId,
        files.map((f) => ({ path: f.path, content: f.content, updatedBy: "agent" as const }))
      );
      // Phase 40: globals.css's current content is inlined here (not just
      // its path) so the very next step can be write_file with the real
      // theme directly - live evidence (the Marginalia build) showed the
      // model spending a whole extra turn on read_file("styles/globals.css")
      // first, to see a file whose content is fully deterministic and
      // already known the moment scaffold_nextjs_project returns.
      const globalsCss = files.find((f) => f.path === "styles/globals.css")?.content ?? "";
      return {
        ok: true,
        content: `Scaffolded ${files.map((f) => f.path).join(", ")} - Next.js Pages Router, Tailwind v4, and lucide-react are correctly configured. No need to read_file any of these before editing them - you already have what you need. Next: write_file styles/globals.css with this project's real theme filled into the @theme block (its current content, to edit directly rather than re-read):\n\n${globalsCss}\n\nThen write pages/index.js and any components - do not rewrite the other scaffolded files from scratch.`,
      };
    }

    case "read_file": {
      const path = String(args.path ?? "");
      const file = await readSessionFile(sessionId, path);
      if (!file) return { ok: false, content: `${path} doesn't exist.` };
      return { ok: true, content: file.content };
    }

    case "list_files": {
      const path = String(args.path ?? "");
      const listing = await listSessionDirectory(sessionId, path);
      const entries = [
        ...listing.directories.map((d) => `${d}/`),
        ...listing.files,
      ];
      return {
        ok: true,
        content: entries.length > 0 ? entries.join("\n") : "(empty)",
      };
    }

    case "run_command": {
      const background = args.background === true;
      const normalized = normalizeShellCommand(String(args.command ?? ""));

      if (normalized.shortCircuitMessage) {
        return { ok: true, content: normalized.shortCircuitMessage };
      }

      // Phase 40 §6D: reject a FOREGROUND dev-server launch immediately
      // rather than discovering it 130 seconds later. This exact
      // mistake is documented in prompt.ts as having happened live -
      // the model ran "npm run dev" in the foreground to read its
      // startup log, the process never exits, it hung for the full
      // foreground timeout, got force-killed, and left the runtime
      // worse off. The prompt has said "never" for a long time; this
      // makes it true. Returned as a failed tool result with the exact
      // corrective action, so the model can act on it in the same turn.
      if (!background && isDevServerCommand(normalized.command)) {
        return {
          ok: false,
          content:
            "FOREGROUND_DEV_SERVER_REJECTED: a dev server never exits, so running it in the foreground would hang until the command timeout and leave the runtime in a worse state. Re-issue this exact command with background: true - that path already waits for real readiness and reports the actual port/URL back to you.",
        };
      }

      const command = await dispatchRuntimeCommand(
        sessionId,
        "run_command",
        { command: normalized.command, cwd: args.cwd ? String(args.cwd) : undefined, background },
        background ? RUN_COMMAND_BACKGROUND_TIMEOUT_MS : RUN_COMMAND_FOREGROUND_TIMEOUT_MS
      );

      if (command.status === "error") {
        return { ok: false, content: `run_command failed: ${command.errorMessage ?? "unknown error"}` };
      }

      if (background) {
        // Phase 17: the runtime layer now waits, bounded, for real
        // readiness evidence before answering - see quickReadinessCheck
        // (runtimeSession.ts). The agent gets a structured, honest
        // status instead of an unconditional "started" that told it
        // nothing about whether the server actually came up.
        const readiness = command.result as BackgroundRunReadiness | undefined;
        if (readiness?.status === "ready") {
          return {
            ok: true,
            content: `Ready. Serving on port ${readiness.port} at ${readiness.url}. No need to wait or check again - call view_preview when you want to look at it.`,
            isFirstSuccessfulRun: true,
          };
        }
        if (readiness?.status === "starting") {
          return {
            ok: true,
            content: readiness.port
              ? `Still starting - port ${readiness.port} is open but not answering yet. This is normal for a fresh install/compile. No need to sleep or poll manually: call view_preview when you're ready to check it - it waits for readiness on its own.`
              : "Still starting - no port open yet. This is normal for a fresh install/compile. No need to sleep or poll manually: call view_preview when you're ready to check it - it waits for readiness on its own.",
            isFirstSuccessfulRun: true,
          };
        }
        return { ok: true, content: "Started in the background.", isFirstSuccessfulRun: true };
      }

      const result = command.result as { exitCode: number; output: string };
      // Phase 25: strip ANSI/cursor-control noise BEFORE truncating -
      // see stripAnsi's own doc comment. Same 4000-char budget, more of
      // it now spent on real output instead of spinner escape codes.
      const passed = result.exitCode === 0;
      const strippedOutput = stripAnsi(result.output).slice(-4000);
      return {
        ok: passed,
        content: `exit code: ${result.exitCode}\n${strippedOutput}`,
        isFirstSuccessfulRun: true,
        ...(isBuildCommand(normalized.command)
          ? {
              buildEvidence: {
                command: normalized.command,
                ok: passed,
                ...(passed ? {} : { errorSummary: strippedOutput }),
              },
            }
          : {}),
      };
    }

    case "view_preview": {
      const viewport = args.viewport as { width: number; height: number } | undefined;
      const result = await viewPreview(sessionId, viewport, context.previousPreview);

      if (result.status !== "success") {
        return {
          ok: false,
          content: `${result.status}: ${result.message}`,
          previewEvidence: { verified: false, previewUrl: null, reason: `${result.status}: ${result.message}` },
        };
      }

      const visionOk = result.analysis.status === "success" || result.analysis.status === "unchanged";

      let analysisText: string;
      if (result.analysis.status === "success" || result.analysis.status === "unchanged") {
        analysisText = result.analysis.critique;
      } else {
        const failureCount = (context.consecutiveVisionFailures ?? 0) + 1;
        const stopNote =
          failureCount >= VISION_FAILURE_STOP_THRESHOLD
            ? ` Vision analysis has failed ${failureCount} times in a row this turn - stop calling view_preview hoping for a critique. The capture itself succeeded (a real, current screenshot exists), so verify using run_command (build/lint/curl), code inspection, or other evidence instead.`
            : "";
        analysisText = `(analysis ${result.analysis.status}: ${result.analysis.reason})${stopNote}`;
      }

      return {
        ok: true,
        content: `Screenshot captured (${result.viewport.width}x${result.viewport.height}).\n\n${analysisText}`,
        isFirstSuccessfulPreview: true,
        previewCheck: {
          screenshotHash: result.screenshotHash,
          visionOk,
          ...(visionOk && (result.analysis.status === "success" || result.analysis.status === "unchanged")
            ? { critique: result.analysis.critique, provider: result.analysis.provider }
            : {}),
        },
        // Phase 39 (Batch 1): a real capture succeeding here already
        // means runtime responding + preview URL set + a meaningful
        // response - deliberately independent of vision's critique
        // (visionOk), which is a probabilistic judgment call, not hard
        // evidence (see this file's own evidence-hierarchy guidance in
        // prompt.ts). PREVIEW_VERIFIED means the capture is real, not
        // that vision approved of what it saw.
        previewEvidence: { verified: true, previewUrl: result.previewUrl },
      };
    }

    case "create_presentation": {
      const validated = validatePresentationPlan(args);
      if (!validated.ok) {
        return { ok: false, content: `create_presentation rejected: ${validated.error}` };
      }
      const fitted = fitPresentationPlan(validated.plan);
      const path = buildArtifactPath(fitted.title, crypto.randomUUID(), "pptx");

      const artifact = await createArtifact({
        sessionId,
        type: "presentation",
        title: fitted.title,
        path,
        createdBy: "agent",
      });

      try {
        const generated = await generatePptx(fitted);
        await batchWriteSessionFiles(sessionId, [{ path, content: generated.base64, encoding: "base64", updatedBy: "agent" }]);
        await markArtifactReady(artifact.id, { slideCount: generated.slideCount });
        return {
          ok: true,
          content: `Presentation created: "${fitted.title}" - ${generated.slideCount} slides, saved to ${path}.`,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error during generation.";
        await markArtifactFailed(artifact.id, message);
        return { ok: false, content: `Presentation generation failed: ${message}. The project is otherwise unchanged.` };
      }
    }

    case "create_image": {
      const validated = validateGenerateImageInput(args);
      if (!validated.ok) {
        return { ok: false, content: `create_image rejected: ${validated.error}` };
      }

      const placeholderPath = buildPublicArtifactPath(validated.title, crypto.randomUUID(), "png");
      const artifact = await createArtifact({
        sessionId,
        type: "image",
        title: validated.title,
        path: placeholderPath,
        createdBy: "agent",
      });

      try {
        const generated = await activeImageProvider.generateImage({ prompt: validated.prompt, aspectRatio: validated.aspectRatio });
        const location = buildPublicArtifactLocation(
          validated.title,
          artifact.id,
          mimeTypeExtension(generated.mimeType),
          generated.mimeType
        );
        await batchWriteSessionFiles(sessionId, [
          { path: location.path, content: generated.base64, encoding: "base64", updatedBy: "agent" },
        ]);
        await markArtifactReady(
          artifact.id,
          { width: generated.width, height: generated.height, prompt: validated.prompt },
          location.path
        );
        // Phase 40 §11: report the servable URL first and unambiguously.
        // The model must never be handed the filesystem path as though
        // it were a browser URL - that produced a guaranteed 404.
        return {
          ok: true,
          content: `Image created: "${validated.title}" - ${generated.width}×${generated.height} ${location.contentType}. Use this exact URL in your markup: ${location.url} (stored at ${location.path} - that storage path is NOT a valid src).`,
        };
      } catch (error) {
        const message = describeImageProviderError(error);
        await markArtifactFailed(artifact.id, message);
        return { ok: false, content: `Image generation failed: ${message}. The project is otherwise unchanged.` };
      }
    }

    case "edit_image": {
      const validated = validateEditImageInput(args);
      if (!validated.ok) {
        return { ok: false, content: `edit_image rejected: ${validated.error}` };
      }

      const source = await getArtifact(sessionId, validated.sourceArtifactId);
      if (!source || source.type !== "image") {
        return { ok: false, content: `edit_image rejected: no image artifact "${validated.sourceArtifactId}" exists in this project.` };
      }
      if (source.status !== "ready") {
        return { ok: false, content: `edit_image rejected: that image isn't ready yet (status: ${source.status}).` };
      }
      const sourceFile = await readSessionFile(sessionId, source.path);
      if (!sourceFile) {
        return { ok: false, content: "edit_image rejected: the source image's file is missing." };
      }

      const placeholderPath = buildPublicArtifactPath(validated.title, crypto.randomUUID(), "png");
      const artifact = await createArtifact({
        sessionId,
        type: "image",
        title: validated.title,
        path: placeholderPath,
        createdBy: "agent",
      });

      try {
        const generated = await activeImageProvider.editImage({
          instruction: validated.instruction,
          sourceBase64: sourceFile.content,
          sourceMimeType: extensionMimeType(source.path),
        });
        const location = buildPublicArtifactLocation(
          validated.title,
          artifact.id,
          mimeTypeExtension(generated.mimeType),
          generated.mimeType
        );
        await batchWriteSessionFiles(sessionId, [
          { path: location.path, content: generated.base64, encoding: "base64", updatedBy: "agent" },
        ]);
        await markArtifactReady(
          artifact.id,
          { width: generated.width, height: generated.height, prompt: validated.instruction },
          location.path
        );
        return {
          ok: true,
          content: `Image edited: "${validated.title}" - ${generated.width}×${generated.height} ${location.contentType}. Use this exact URL in your markup: ${location.url} (stored at ${location.path} - that storage path is NOT a valid src). The original image is unchanged.`,
        };
      } catch (error) {
        const message = describeImageProviderError(error);
        await markArtifactFailed(artifact.id, message);
        return { ok: false, content: `Image edit failed: ${message}. The original image is unchanged.` };
      }
    }

    default:
      return { ok: false, content: `Unknown tool: ${call.function.name}` };
  }
}

/** STEP 18: honest, specific messages per failure kind - never a raw stack trace, never "success" language. */
function describeImageProviderError(error: unknown): string {
  if (error instanceof AgentProviderError) {
    switch (error.kind) {
      case "auth":
        return "Image generation is temporarily unavailable (not configured).";
      case "rate_limited":
        return "The image provider is rate-limited or out of quota right now.";
      case "timeout":
        return "The image took too long to generate.";
      case "malformed_response":
        return "The image provider returned an unusable response.";
      default:
        return error.message;
    }
  }
  return error instanceof Error ? error.message : "Unknown error.";
}
