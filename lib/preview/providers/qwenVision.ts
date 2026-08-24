import "server-only";

import OpenAI from "openai";

import { AgentProviderError, classifyAgentProviderFailure } from "@/lib/agent/provider";

import type { VisionProvider } from "@/lib/preview/visionProvider";

/**
 * Phase 26: local-first vision. Confirmed live against this exact
 * environment before writing this file - Ollama is installed and
 * running (`ollama list`), with two vision-capable models already
 * pulled: "qwen2.5vl-16k:latest" (a custom Modelfile variant, parent
 * "qwen2.5vl:3b", built with an extended 16k context) and the plain
 * "qwen2.5vl:3b" base. The 16k variant is the deliberately-provisioned
 * one, so it's the default - but never hardcoded past that: both
 * OLLAMA_BASE_URL and OLLAMA_VISION_MODEL are read from the
 * environment (no such config existed before this phase; this is the
 * config, not a consumer of pre-existing config).
 *
 * Ollama's OpenAI-compatible endpoint (confirmed live via curl against
 * a real, non-degenerate JPEG - a 1x1 test pixel genuinely failed to
 * decode, a real screenshot-sized image did not) accepts the exact
 * same `{type: "image_url", image_url: {url: dataUrl}}` content-block
 * shape the existing Gemini call already used - so this reuses the
 * OpenAI SDK the same way every other provider in this codebase does,
 * not a bespoke native-API client.
 */
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434/v1";
const OLLAMA_VISION_MODEL = process.env.OLLAMA_VISION_MODEL || "qwen2.5vl-16k:latest";
// Measured live: a small (400x300) test image took ~6.5s dominated by
// prompt_eval (visual token encoding) on this machine's local
// inference. A real 1440x900 screenshot has far more visual tokens to
// encode - generous headroom over the small-image baseline, still
// bounded (not unbounded local inference) so a genuinely stuck local
// call still falls through to the external fallback in reasonable time.
const QWEN_TIMEOUT_MS = 60_000;
const QWEN_MAX_TOKENS = 600;

const client = new OpenAI({
  // Ollama's OpenAI-compat layer doesn't validate this - the SDK just
  // requires some non-empty string to construct.
  apiKey: "ollama",
  baseURL: OLLAMA_BASE_URL,
  maxRetries: 0, // bounded retry/fallback is owned by visionRecovery.ts, not duplicated here
});

export const qwenVisionProvider: VisionProvider = {
  id: "local-qwen",
  displayName: `Local Qwen (${OLLAMA_VISION_MODEL})`,

  async analyze(dataUrl: string, prompt: string): Promise<string> {
    try {
      const completion = await client.chat.completions.create(
        {
          model: OLLAMA_VISION_MODEL,
          max_tokens: QWEN_MAX_TOKENS,
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
        { timeout: QWEN_TIMEOUT_MS }
      );

      const text = completion.choices[0]?.message?.content?.trim();
      if (!text) {
        throw new AgentProviderError("local-qwen", "malformed_response", "Local Qwen vision returned no text.", true);
      }
      return text;
    } catch (error) {
      if (error instanceof AgentProviderError) throw error;

      const { kind, retryable } = classifyAgentProviderFailure(error);
      throw new AgentProviderError(
        "local-qwen",
        kind,
        `Local Qwen vision failed: ${error instanceof Error ? error.message : String(error)}`,
        retryable,
        error
      );
    }
  },
};
