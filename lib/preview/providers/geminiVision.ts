import "server-only";

import OpenAI from "openai";

import { AgentProviderError, classifyAgentProviderFailure } from "@/lib/agent/provider";

import type { VisionProvider } from "@/lib/preview/visionProvider";

/**
 * Phase 26: the external fallback - unchanged behavior from the
 * pre-Phase-26 single-provider visionAnalysis.ts, just reshaped to the
 * VisionProvider interface (throws AgentProviderError instead of
 * returning a result union) so it composes with visionRecovery.ts the
 * same way qwenVision.ts does. The specific 429->"rate-limited" case
 * that visionAnalysis.ts used to special-case is now handled generically
 * by classifyAgentProviderFailure (status===429 -> rate_limited,
 * retryable: true) - no behavior lost, one less bespoke branch.
 */
const VISION_TIMEOUT_MS = 30_000;
// Measured live against a real, fully-rendered capture: gemini-flash-latest's
// visible answer alone ran 187-265 completion_tokens across trials with
// room to spare at 1500, but at 500 it sometimes returned truncated
// (finish_reason: "length") or, once, completely empty content - the
// model's own internal "thinking" tokens share this same budget and can
// consume all of it before any visible text is emitted.
const VISION_MAX_TOKENS = 1500;

export const geminiVisionProvider: VisionProvider = {
  id: "gemini",
  displayName: "Gemini",

  async analyze(dataUrl: string, prompt: string): Promise<string> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new AgentProviderError("gemini", "auth", "No GEMINI_API_KEY configured.", false);
    }

    const client = new OpenAI({
      apiKey,
      baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    });

    try {
      const completion = await client.chat.completions.create(
        {
          model: process.env.GEMINI_MODEL || "gemini-flash-latest",
          max_tokens: VISION_MAX_TOKENS,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: prompt },
                { type: "image_url", image_url: { url: dataUrl } },
              ],
            },
          ],
        },
        { timeout: VISION_TIMEOUT_MS, maxRetries: 2 }
      );

      const text = completion.choices[0]?.message?.content?.trim();
      if (!text) {
        throw new AgentProviderError("gemini", "malformed_response", "Vision call returned no text.", true);
      }
      return text;
    } catch (error) {
      if (error instanceof AgentProviderError) throw error;

      const { kind, retryable } = classifyAgentProviderFailure(error);
      throw new AgentProviderError(
        "gemini",
        kind,
        error instanceof Error ? error.message : String(error),
        retryable,
        error
      );
    }
  },
};
