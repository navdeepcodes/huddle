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
 *
 * Phase 41C: also the Lightning fallback's provider. Lightning
 * (nvidia/nemotron-3.5-lightning-30b-a3b) is served by the exact same
 * NVIDIA endpoint, credential, and request shape as Ultra - Phase 41A's
 * benchmark already proved this request shape (including
 * chat_template_kwargs) works against it live, 9/9 calls. Per "reuse
 * the existing NVIDIA-compatible client and request structure, do not
 * duplicate the provider implementation, the only model-specific
 * difference should be the model identifier/configuration" - this
 * factory now takes an options object instead of being Ultra-only.
 * Every existing call site that omits `options` gets IDENTICAL
 * behavior to before this change (same id, same displayName, same
 * MODEL constant, same default retry budget) - only providerResolution.ts's
 * new second call site actually passes anything.
 */
export function createNemotronProvider(
  apiKey: string,
  options?: {
    model?: string;
    id?: string;
    displayName?: string;
    /** Phase 41C: e.g. 2 for Lightning - see provider.ts's own doc comment. */
    maxAttempts?: number;
  }
): AgentModelProvider {
  const model = options?.model ?? MODEL;
  const id = options?.id ?? "nvidia";
  const displayName = options?.displayName ?? "NVIDIA Nemotron 3 Ultra";
  const client = new OpenAI({
    apiKey,
    baseURL: "https://integrate.api.nvidia.com/v1",
    // Phase 40 §9 / 40B: ONE retry owner. This used to be 1, sitting
    // directly underneath generateStepWithRecovery's own bounded ladder
    // (MAX_RETRIES_PER_PROVIDER = 2 -> 3 attempts), so a single logical
    // step could make 3 x 2 = 6 HTTP attempts at up to 180s each ~= 18
    // minutes for ONE iteration - which also silently exceeded
    // TURN_CLAIM_STALE_MS (5 min) and could get a live turn reclaimed
    // mid-flight. Retries are owned by providerRecovery.ts alone, same
    // discipline qwenVision.ts and geminiImage.ts already follow.
    // Worst case per iteration is now MAX_RETRIES_PER_PROVIDER's 4
    // attempts x 180s = 12 min, still bounded further by the turn's
    // wall-clock deadline - see providerRecovery.ts's doc comment for
    // why 3 total attempts (Phase 40's first value) proved too little
    // headroom against NVIDIA's observed intermittent 500s.
    maxRetries: 0,
  });

  return {
    id,
    displayName,
    model,
    maxAttempts: options?.maxAttempts,

    async generateStep(
      messages: ChatCompletionMessageParam[],
      tools: ChatCompletionTool[],
      signal?: AbortSignal
    ): Promise<AgentStepResult> {
      try {
        const completion = await client.chat.completions.create(
          {
            model,
            temperature: 0.7,
            max_tokens: 8000,
            tools,
            tool_choice: "auto",
            // Phase 40: explicit, not relying on whatever this endpoint's
            // unstated default is - live evidence (2026-08-25, the
            // Marginalia build) showed every write_file call arriving as
            // its own separate turn even for components the model had
            // already decided to write back-to-back, despite the prompt
            // and write_file's own tool description both saying multiple
            // files belong in one step. Setting this explicitly removes
            // one possible cause; whether the model actually uses it once
            // allowed is a separate, model-behavior question this alone
            // can't guarantee.
            parallel_tool_calls: true,
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
            id,
            "malformed_response",
            `${displayName} returned no choices.`,
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
          id,
          kind,
          `${displayName} agent step failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          retryable,
          error
        );
      }
    },
  };
}
