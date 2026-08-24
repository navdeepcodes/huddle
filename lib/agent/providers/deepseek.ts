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
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: "https://api.deepseek.com/v1",
});

/**
 * v1's one registered AgentModelProvider. Config (model, temperature,
 * thinking mode, timeout) ported as-is from apostle's proven
 * generateDeepSeekAgentStep - see that function's own comments for why
 * `thinking: enabled` and a 180s timeout are the right defaults, not
 * guesses re-derived here.
 */
export const deepSeekAgentProvider: AgentModelProvider = {
  id: "deepseek",
  displayName: "DeepSeek",
  model: "deepseek-v4-flash",

  async generateStep(
    messages: ChatCompletionMessageParam[],
    tools: ChatCompletionTool[],
    signal?: AbortSignal
  ): Promise<AgentStepResult> {
    try {
      const completion = await client.chat.completions.create(
        {
          model: "deepseek-v4-flash",
          temperature: 0.7,
          // Confirmed live (huddle golden-path test, 2026-08-19): a
          // real first-turn response to an open-ended build request
          // spent its entire 16000-token budget on invisible
          // reasoning_content (thinking: enabled) and got cut off
          // (finish_reason "length") before emitting any content or
          // tool call - 155s and 16000 completion tokens for zero
          // visible output. Doubled as a measured first response to a
          // confirmed failure, not a guess.
          max_tokens: 32000,
          thinking: { type: "enabled" },
          tools,
          tool_choice: "auto",
          messages,
        } as ChatCompletionCreateParamsNonStreaming & {
          thinking: { type: "enabled" };
        },
        {
          // Confirmed live: with the 32000-token budget above, a real
          // response hit the previous 180s timeout, and the SDK's
          // default retry behavior (maxRetries unset -> 2 retries) then
          // repeated the SAME 180s wait two more times before finally
          // surfacing "Request timed out." - ~540s of dead time to
          // report one failure. Timeout raised to 300s (proportional to
          // the token-budget increase) and maxRetries pinned to 1 so a
          // genuine failure surfaces in a bounded ~10min worst case
          // instead of compounding silently.
          timeout: 300_000,
          maxRetries: 1,
          signal,
        }
      );

      const choice = completion.choices[0];
      const message = choice?.message ?? {
        role: "assistant" as const,
        content: "",
        refusal: null,
      };

      return {
        message: sanitizeAgentMessage(message),
        truncated: choice?.finish_reason === "length",
        usage: completion.usage
          ? {
              promptTokens: completion.usage.prompt_tokens,
              completionTokens: completion.usage.completion_tokens,
              totalTokens: completion.usage.total_tokens,
            }
          : null,
      };
    } catch (error) {
      const { kind, retryable } = classifyAgentProviderFailure(
        error,
        signal
      );

      throw new AgentProviderError(
        "deepseek",
        kind,
        `DeepSeek agent step failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        retryable,
        error
      );
    }
  },
};
