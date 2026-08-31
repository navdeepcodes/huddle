import "server-only";

import OpenAI from "openai";

import {
  AgentProviderError,
  classifyAgentProviderFailure,
  sanitizeAgentMessage,
} from "@/lib/agent/provider";

import type {
  AgentModelProvider,
  AgentStepResult,
} from "@/lib/agent/provider";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

const MODEL = process.env.GEMINI_CODING_MODEL || "gemini-flash-latest";

/**
 * Phase 41: the fallback AgentModelProvider, not the primary. Exists so
 * a Nemotron failure mid-turn (HTTP 500, request timeout, or repeated
 * truncation - all three live-reproduced this session) doesn't have to
 * kill an otherwise-healthy generation with real files already on disk.
 *
 * Candidate selection (see the Phase 41 plan): DeepSeek was rejected -
 * its own `thinking: {type: "enabled"}` config is what caused a
 * previously live-reproduced `400 reasoning_content... must be passed
 * back` when continuing a Nemotron-thinking-mode conversation, exactly
 * this file's job. Gemini was chosen instead because GEMINI_API_KEY is
 * already a proven, live production credential (geminiVision.ts,
 * geminiImage.ts both use it daily) and the OpenAI-compat endpoint has
 * no known structural incompatibility with the message history Nemotron
 * leaves behind - sanitizeAgentMessage already strips Nemotron's
 * reasoning down to plain content/tool_calls before it ever reaches
 * here, so there's nothing Gemini-incompatible left in the history to
 * choke on.
 *
 * `gemini-flash-latest` is the same model string geminiVision.ts already
 * runs live - reusing a proven identifier rather than guessing a new
 * one. max_tokens and the request timeout below are deliberately
 * NOT copied from Nemotron: this is the fast/cheap tier, chosen for
 * this exact role, and this is the fallback path Nemotron already
 * failed into - burning another 180s x 4 attempts on a second slow
 * provider would defeat the point of having a fallback at all. Both
 * values are starting points pending the Phase 41 §15 benchmark (one
 * small live request, run before any full generation is risked on it),
 * not asserted as measured.
 */
export function createGeminiCodingProvider(apiKey: string): AgentModelProvider {
  const client = new OpenAI({
    apiKey,
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    // One retry owner, same discipline as every other provider in this
    // codebase (nemotron.ts, geminiVision.ts) - retries are owned by
    // providerRecovery.ts alone, never duplicated at the SDK layer.
    maxRetries: 0,
  });

  return {
    id: "gemini-coding",
    displayName: "Gemini (fallback)",
    model: MODEL,

    async generateStep(
      messages: ChatCompletionMessageParam[],
      tools: ChatCompletionTool[],
      signal?: AbortSignal
    ): Promise<AgentStepResult> {
      try {
        const completion = await client.chat.completions.create(
          {
            model: MODEL,
            temperature: 0.7,
            max_tokens: 8000,
            tools,
            tool_choice: "auto",
            parallel_tool_calls: true,
            messages,
          },
          // Deliberately shorter than Nemotron's 180s - see this file's
          // top doc comment for why a slow fallback would defeat the point.
          { timeout: 60_000, signal }
        );

        const choice = completion.choices[0];

        if (!choice) {
          throw new AgentProviderError(
            "gemini-coding",
            "malformed_response",
            "Gemini returned no choices.",
            true
          );
        }

        return {
          message: sanitizeAgentMessage(choice.message),
          truncated: choice.finish_reason === "length",
          usage: completion.usage
            ? {
                promptTokens: completion.usage.prompt_tokens,
                completionTokens: completion.usage.completion_tokens,
                totalTokens: completion.usage.total_tokens,
              }
            : null,
        };
      } catch (error) {
        if (error instanceof AgentProviderError) {
          throw error;
        }

        const { kind, retryable } = classifyAgentProviderFailure(error, signal);

        throw new AgentProviderError(
          "gemini-coding",
          kind,
          `Gemini agent step failed: ${error instanceof Error ? error.message : String(error)}`,
          retryable,
          error
        );
      }
    },
  };
}
