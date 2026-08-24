import "server-only";

import { AgentProviderError } from "@/lib/agent/provider";

import type { AgentModelProvider, AgentStepResult } from "@/lib/agent/provider";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

/**
 * Root cause (2026-08-22, Phase 15): runAgentTurn's provider call was a
 * bare try/catch that terminated the entire turn (terminationReason
 * "provider_error") on ANY thrown error - including the transient ones
 * classifyAgentProviderFailure already correctly labels retryable
 * (HTTP 5xx, timeout, network reset). That classification existed and
 * was attached to every AgentProviderError thrown by both providers,
 * but nothing ever read `.retryable` - live-reproduced 6+ times across
 * the Phase 14 benchmark suite as "(step failed: NVIDIA Nemotron 3
 * Ultra agent step failed: 500 Internal server error)" ending turns
 * that had real work left to do. Separately, `provider.ts`'s own doc
 * comment claimed "the multi-provider fallback registry deliberately
 * left out: v1 registers exactly one provider" - stale as of this
 * investigation: lib/agent/providers/deepseek.ts is a complete, live
 * AgentModelProvider (config proven in its own doc comment), simply
 * never imported by loop.ts. It's registered here as the fallback
 * rather than building a new provider.
 *
 * This function owns exactly one thing: given an ordered list of
 * providers, get one successful step, retrying transient failures with
 * bounded backoff before moving to the next provider. It never touches
 * `messages` and never processes tool_calls - retrying a step here is
 * always safe because the caller (runAgentTurn) only appends to
 * `messages` and only executes tool_calls AFTER this function returns
 * successfully. A retry or fallback therefore can never re-execute a
 * tool call that already ran - there's no tool-call state in scope
 * here to duplicate.
 */
const MAX_RETRIES_PER_PROVIDER = 2;
const BASE_BACKOFF_MS = 500;

export interface ProviderRecoveryResult {
  step: AgentStepResult;
  providerId: string;
  /** Phase 29 Part 8: total attempts across every provider tried this call, including the successful one - 1 means it succeeded on the first try with no retries. */
  attempts: number;
}

export function backoffDelayMs(retryAttempt: number): number {
  // retryAttempt is 1-indexed (1st retry, 2nd retry): 500ms, 1000ms.
  return BASE_BACKOFF_MS * 2 ** (retryAttempt - 1);
}

/**
 * Tries each provider in order. For each provider: one initial attempt
 * plus up to MAX_RETRIES_PER_PROVIDER retries, but only while the
 * failure is classified retryable and the turn hasn't been cancelled -
 * a non-retryable failure (auth, malformed request) or cancellation
 * moves straight past retries. Cancellation additionally aborts the
 * whole function immediately, skipping any remaining providers - the
 * turn is being torn down, not degraded to a slower provider.
 *
 * Throws the last error once every provider's attempts are exhausted,
 * preserving the existing "provider_error" termination behavior in
 * runAgentTurn for the genuinely-nothing-worked case.
 */
export async function generateStepWithRecovery(
  providers: AgentModelProvider[],
  messages: ChatCompletionMessageParam[],
  tools: ChatCompletionTool[],
  signal: AbortSignal | undefined,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
): Promise<ProviderRecoveryResult> {
  let lastError: unknown = new Error("No providers configured.");
  let attempts = 0;

  for (const provider of providers) {
    for (let attempt = 0; attempt <= MAX_RETRIES_PER_PROVIDER; attempt++) {
      if (signal?.aborted) throw lastError;
      attempts++;

      try {
        const step = await provider.generateStep(messages, tools, signal);
        return { step, providerId: provider.id, attempts };
      } catch (error) {
        lastError = error;

        if (signal?.aborted) throw error;
        if (error instanceof AgentProviderError && error.kind === "cancelled") throw error;

        const retryable = error instanceof AgentProviderError ? error.retryable : false;
        if (retryable && attempt < MAX_RETRIES_PER_PROVIDER) {
          await sleep(backoffDelayMs(attempt + 1));
          continue;
        }

        break; // this provider is done (retries exhausted or non-retryable) - fall through to the next provider
      }
    }
  }

  throw lastError;
}
