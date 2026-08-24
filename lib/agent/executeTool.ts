import "server-only";

import {
  deleteSessionFile,
  listSessionDirectory,
  readSessionFile,
} from "@/lib/files/fileStore";
import { dispatchRuntimeCommand } from "@/lib/runtime/commandRelay";
import { viewPreview } from "@/lib/preview/viewPreview";
import { normalizeShellCommand } from "@/lib/agent/normalizeShellCommand";
import { stripAnsi } from "@/lib/agent/stripAnsi";

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
      return {
        ok: result.exitCode === 0,
        content: `exit code: ${result.exitCode}\n${stripAnsi(result.output).slice(-4000)}`,
        isFirstSuccessfulRun: true,
      };
    }

    case "view_preview": {
      const viewport = args.viewport as { width: number; height: number } | undefined;
      const result = await viewPreview(sessionId, viewport, context.previousPreview);

      if (result.status !== "success") {
        return { ok: false, content: `${result.status}: ${result.message}` };
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
      };
    }

    default:
      return { ok: false, content: `Unknown tool: ${call.function.name}` };
  }
}
