import "server-only";

import { AgentProviderError } from "@/lib/agent/provider";
import { qwenVisionProvider } from "@/lib/preview/providers/qwenVision";
import { geminiVisionProvider } from "@/lib/preview/providers/geminiVision";
import { analyzeWithRecovery } from "@/lib/preview/visionRecovery";
import { buildVisionCritiquePrompt } from "@/lib/preview/visionPrompt";
import { resizeScreenshotForVision } from "@/lib/preview/screenshotResize";
import { normalizeCritique } from "@/lib/preview/normalizeCritique";

import type { VisionProvider } from "@/lib/preview/visionProvider";

/**
 * Phase 26: local-first routing. Local Qwen is tried first (real,
 * available, verified live in this environment); Gemini is the
 * fallback for when it's unavailable/unsupported/fails - never the
 * other way around. `status: "unchanged"` is never produced by this
 * function itself (it has no memory of a previous screenshot) - it's
 * constructed by the caller (lib/preview/viewPreview.ts) when a hash
 * comparison shows nothing changed, reusing the prior critique instead
 * of calling this function again at all. `retryable` on the failure
 * branches reflects whether the LAST underlying error was itself
 * classified retryable (a transient-shaped failure worth trying again
 * later) vs. structurally broken (e.g. no API key) - not a promise that
 * retrying immediately would help, since every provider+retry already
 * available was already exhausted before this returns a failure.
 */
export type VisionAnalysisResult =
  | { status: "success"; critique: string; provider: string }
  | { status: "unchanged"; critique: string; provider: string }
  | { status: "unavailable"; reason: string; retryable: boolean }
  | { status: "failed"; reason: string; retryable: boolean };

/**
 * VISION_PROVIDER lets an operator force a single provider (e.g.
 * "gemini" to test the fallback path in isolation, "local-qwen" to
 * force local-only) - previously declared in .env.local but never
 * actually read anywhere (dead config); this is what makes it real.
 * Unset or any other value = the real local-first-with-fallback chain.
 */
function selectProviders(): VisionProvider[] {
  const forced = process.env.VISION_PROVIDER?.trim().toLowerCase();
  if (forced === "gemini") return [geminiVisionProvider];
  if (forced === "local-qwen" || forced === "qwen") return [qwenVisionProvider];
  return [qwenVisionProvider, geminiVisionProvider];
}

export async function analyzePreviewScreenshot(
  dataUrl: string
): Promise<Exclude<VisionAnalysisResult, { status: "unchanged" }>> {
  const resized = await resizeScreenshotForVision(dataUrl);
  const prompt = buildVisionCritiquePrompt(resized.width, resized.height);
  const providers = selectProviders();

  try {
    const { critique, providerId } = await analyzeWithRecovery(providers, resized.dataUrl, prompt);
    console.log("[Huddle] vision analysis succeeded", {
      provider: providerId,
      originalBytes: resized.originalBytes,
      resizedBytes: resized.resizedBytes,
    });
    // Phase 27 Part I.1: collapses a smaller model's repeated
    // ISSUES/RECOMMENDATIONS headers into one clean block - see
    // normalizeCritique's own doc comment. Safe to apply to any
    // provider's output (idempotent on already-clean text, a no-op on
    // Gemini's header-less prose).
    return { status: "success", critique: normalizeCritique(critique), provider: providerId };
  } catch (error) {
    const retryable = error instanceof AgentProviderError ? error.retryable : false;
    const reason = error instanceof Error ? error.message : String(error);
    console.log("[Huddle] vision analysis unavailable", { reason, retryable });
    return { status: retryable ? "unavailable" : "failed", reason, retryable };
  }
}
