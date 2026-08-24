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

const MODEL = process.env.NVIDIA_MODEL || "nvidia/nemotron-3-ultra-550b-a55b";

/**
 * Second AgentModelProvider, swapped in for DeepSeek (credits nearly
 * exhausted) without touching AgentModelProvider itself, the agent
 * loop, cancellation, turn registry, or persistence - only this file
 * and the one import/call site in loop.ts change.
 *
 * Config ported as-is from apostle's proven
 * services/providers/nvidia.agentProvider.ts, which live-verified this
 * exact model against this exact request shape (~19,600-char system
 * prompt, all tools): `chat_template_kwargs: {enable_thinking: true,
 * force_nonempty_content: true}` is NVIDIA's documented required
 * combination for tool calling with reasoning enabled on this model -
 * without it, apostle measured ~1-in-10-15 calls returning a genuinely
 * empty response (no content, no tool_calls); with it, 3/3 controlled
 * calls returned a real tool call. Also confirmed there:
 * `reasoning_content` comes back null on this endpoint - the model's
 * reasoning surfaces inline in `content` instead, terminated by a bare
 * `</think>` tag with no matching opening tag - reproduced exactly by
 * this session's own live tiny tool-call smoke test (2026-08-20), not
 * just inherited from apostle. Not stripped here deliberately: it's
 * cosmetic (doesn't affect tool-call parsing, confirmed by that same
 * smoke test - arguments parsed cleanly), and this file makes no
 * unverified assumption about how to fix a display-layer concern that
 * hasn't been scoped.
 * max_tokens set to 8000 (apostle's proven value for this model, far
 * below DeepSeek's 32000) - not a guess, this model's completions were
 * never observed needing more even with reasoning enabled.
 *
 * Phase 29: this used to be a single module-level provider object
 * backed by one shared OpenAI client built from process.env at import
 * time - every user's traffic hit the same NVIDIA_API_KEY, with no
 * way to attribute or bill it per user. Now a factory: each call site
 * (runAgentTurn, resolving whichever credential belongs to the
 * requesting uid) builds its own provider instance bound to a
 * specific key, so the client itself - not just a request parameter -
 * is scoped to the one credential it was created with. There is no
 * code path anywhere in this file that could send request A's
 * messages through a client built for a different key; the key is
 * captured once in the closure at creation and never overwritten.
 */
export function createNemotronProvider(apiKey: string): AgentModelProvider {
  const client = new OpenAI({
    apiKey,
    baseURL: "https://integrate.api.nvidia.com/v1",
    maxRetries: 1,
  });

  return {
    id: "nvidia",
    displayName: "NVIDIA Nemotron 3 Ultra",
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
            messages,
            chat_template_kwargs: {
              enable_thinking: true,
              force_nonempty_content: true,
            },
          } as ChatCompletionCreateParamsNonStreaming & {
            chat_template_kwargs: { enable_thinking: boolean; force_nonempty_content: boolean };
          },
          { timeout: 180_000, signal }
        );

        const choice = completion.choices[0];

        if (!choice) {
          throw new AgentProviderError(
            "nvidia",
            "malformed_response",
            "NVIDIA Nemotron 3 Ultra returned no choices.",
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
          "nvidia",
          kind,
          `NVIDIA Nemotron 3 Ultra agent step failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          retryable,
          error
        );
      }
    },
  };
}
