import "server-only";

import { adminDb } from "@/lib/firebase/admin";
import { dispatchRuntimeCommand } from "@/lib/runtime/commandRelay";
import { analyzePreviewScreenshot } from "@/lib/preview/visionAnalysis";

import type { RuntimeHost } from "@/types/session";
import type { VisionAnalysisResult } from "@/lib/preview/visionAnalysis";

// Measured live: successful runs completed in ~10s, but this
// environment showed real run-to-run variance (two consecutive 20s
// timeouts with no error reported, i.e. the round trip genuinely
// hadn't finished, not a fast failure) - 45s gives headroom over the
// slowest observed case without guessing at a specific cause.
const CAPTURE_TIMEOUT_MS = 45_000;

/**
 * Phase 17: bounded wait for runtimeHost to leave STARTING before
 * giving up - see this file's ViewPreviewResult doc comment. Polls the
 * SAME state doc the UI already reads (no second, competing readiness
 * signal) rather than reaching into port/curl internals directly - by
 * design, view_preview doesn't need to know anything about how
 * readiness is determined, only that it eventually is.
 *
 * Phase 40: live evidence (2026-08-25, the Marginalia build) - a real
 * cold install+first-compile (15 freshly-written files, Tailwind v4
 * JIT) outlasted the old 25s ceiling on FIVE consecutive view_preview
 * calls in a row (each one restarting its own 25s window from zero),
 * before a run_command curl proved the server had actually been
 * answering for a while. That's five wasted full model round-trips -
 * real wall-clock and real token cost - for the same wait a single
 * more-patient call would have absorbed for free (this is server-side
 * polling, not the model blocked mid-turn). Raised to 50s - still well
 * under CAPTURE_TIMEOUT_MS's own 45s-plus-backoff precedent for "this
 * environment has real run-to-run variance, budget for the slow case."
 * This is the sanctioned "agent can waste steps waiting on
 * runtime/preview readiness during cold-start" item, not new scope.
 */
const STATE_READY_WAIT_MS = 50_000;
const STATE_POLL_INTERVAL_MS = 2_000;

/**
 * Phase 17: the SERVER-ready vs PAGE-painted gap (section 7) - state
 * can be "running" before the preview iframe has loaded and the
 * injected capture script has posted its own "ready" handshake
 * (capturePreview() throws "No live preview page to capture yet" until
 * then). Bounded backoff, not a fixed sleep, since the iframe's own
 * load time genuinely varies with bundle size/first compile.
 */
const PAINT_RETRY_DELAYS_MS = [1_500, 3_000, 6_000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Phase 26: cheap, deterministic, non-cryptographic - same shape as
 * taskProgress.ts's own simpleHash (not exported from that frozen file,
 * so a local equivalent - this is a five-line algorithm, not shared
 * state, duplicating it costs nothing real). Used only to detect "is
 * this the same screenshot as last time," not for anything
 * security-sensitive.
 */
function simpleHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (Math.imul(hash, 31) + input.charCodeAt(i)) | 0;
  }
  return hash.toString(36);
}

/**
 * The view_preview tool's contract: `status` is CAPTURE's outcome,
 * `analysis` is vision's outcome - two independent facets, per the
 * required invariant (capture success != analysis success). The agent
 * never gets an ambiguous "something went wrong" - every branch below
 * names a concrete, distinguishable reason.
 */
export type ViewPreviewResult =
  | {
      status: "success";
      message: string;
      viewport: { width: number; height: number };
      screenshot: string;
      screenshotHash: string;
      previewUrl: string | null;
      analysis: VisionAnalysisResult;
      paintReadyMs: number;
    }
  | { status: "not_ready"; message: string }
  /** Phase 17: state never left STARTING within the bounded wait - distinct from "unavailable" (never even attempted / genuinely crashed), since this one is still worth a later retry. */
  | { status: "starting"; message: string }
  | { status: "unavailable"; message: string }
  | { status: "failed"; errorCategory: string; message: string };

async function readHost(sessionId: string): Promise<RuntimeHost | undefined> {
  const hostSnap = await adminDb.collection("runtimeHost").doc(sessionId).get();
  return hostSnap.data() as RuntimeHost | undefined;
}

/**
 * Phase 26 section 7: what the caller (executeTool.ts, threaded from
 * loop.ts's own per-turn state - same pattern as the existing
 * lastViewPreviewOk closure variable) remembers about the LAST
 * successful capture this turn. Passing this in lets a repeated,
 * genuinely-unchanged screenshot skip a whole vision call (local or
 * external) instead of re-analyzing pixels nothing changed - a simple,
 * bounded, in-memory-per-turn mechanism, not a new persisted state
 * system (nothing here survives past the turn, same as
 * lastViewPreviewOk already doesn't).
 */
export interface PreviousPreviewCheck {
  screenshotHash: string;
  critique: string;
  provider: string;
}

export async function viewPreview(
  sessionId: string,
  viewport?: { width: number; height: number },
  previous?: PreviousPreviewCheck
): Promise<ViewPreviewResult> {
  let host = await readHost(sessionId);

  if (!host) {
    return {
      status: "unavailable",
      message: "The runtime isn't running yet (state: idle). Start the dev server with run_command first.",
    };
  }

  if (host.state === "crashed" || host.state === "timeout") {
    return {
      status: "unavailable",
      message: `The runtime ${host.state} while starting: ${host.errorMessage ?? "no error recorded"}.`,
    };
  }

  // Phase 17: state isn't "running" yet, but it also isn't a known
  // failure - wait, bounded, for the SAME state transition the UI
  // already reads, instead of failing the agent's call immediately for
  // what's very likely just normal install/compile time.
  if (host.state !== "running") {
    const deadline = Date.now() + STATE_READY_WAIT_MS;
    while (Date.now() < deadline && host && host.state !== "running" && host.state !== "crashed" && host.state !== "timeout") {
      await sleep(STATE_POLL_INTERVAL_MS);
      host = await readHost(sessionId);
    }

    if (!host || host.state === "crashed" || host.state === "timeout") {
      return {
        status: "unavailable",
        message: `The runtime ${host?.state ?? "crashed"} while starting: ${host?.errorMessage ?? "no error recorded"}.`,
      };
    }

    if (host.state !== "running") {
      return {
        status: "starting",
        message: `The workspace is still starting (state: ${host.state}) after ${STATE_READY_WAIT_MS / 1000}s - this can happen on a cold install/compile. Try again shortly; no need to sleep or poll manually, just call view_preview again.`,
      };
    }
  }

  const paintReadyStartedAt = Date.now();
  let lastNotReadyReason = "";

  for (let attempt = 0; attempt <= PAINT_RETRY_DELAYS_MS.length; attempt++) {
    const command = await dispatchRuntimeCommand(
      sessionId,
      "capture_preview",
      { viewport },
      CAPTURE_TIMEOUT_MS
    );

    if (command.status === "error") {
      const reason = command.errorMessage ?? "Unknown capture error.";
      const notReady = /no live preview page/i.test(reason);
      if (notReady && attempt < PAINT_RETRY_DELAYS_MS.length) {
        // The server answered but the preview iframe/capture script
        // hasn't handshaked yet (section 7's SERVER-ready vs
        // PAGE-painted gap) - bounded backoff, not a fixed sleep.
        lastNotReadyReason = reason;
        await sleep(PAINT_RETRY_DELAYS_MS[attempt]);
        continue;
      }
      return notReady
        ? { status: "not_ready", message: reason }
        : { status: "failed", errorCategory: "capture", message: reason };
    }

    const result = command.result as
      | { dataUrl: string; width: number; height: number }
      | undefined;

    if (!result?.dataUrl) {
      return {
        status: "failed",
        errorCategory: "capture",
        message: "Capture completed but returned no image.",
      };
    }

    const screenshotHash = simpleHash(result.dataUrl);

    // Phase 26 section 7: nothing changed since the last capture this
    // turn - reuse the prior critique instead of spending a vision call
    // (local or external) re-analyzing identical pixels.
    if (previous && previous.screenshotHash === screenshotHash) {
      return {
        status: "success",
        message: "Screenshot captured - identical to the last capture this turn, reusing the previous analysis.",
        paintReadyMs: Date.now() - paintReadyStartedAt,
        viewport: { width: result.width, height: result.height },
        screenshot: result.dataUrl,
        screenshotHash,
        previewUrl: host.previewUrl,
        analysis: { status: "unchanged", critique: previous.critique, provider: previous.provider },
      };
    }

    const analysis = await analyzePreviewScreenshot(result.dataUrl);

    return {
      status: "success",
      message: "Screenshot captured.",
      paintReadyMs: Date.now() - paintReadyStartedAt,
      viewport: { width: result.width, height: result.height },
      screenshot: result.dataUrl,
      screenshotHash,
      previewUrl: host.previewUrl,
      analysis,
    };
  }

  // Unreachable in practice (the loop always returns or the "not
  // ready" branch returns once the backoff budget is spent) - kept for
  // exhaustiveness rather than a non-null assertion.
  return { status: "not_ready", message: lastNotReadyReason || "Preview capture never became ready." };
}
