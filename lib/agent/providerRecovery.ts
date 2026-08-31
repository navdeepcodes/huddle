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
 *
 * Phase 40B: this is the ONE retry owner in the system - every SDK
 * client sits at maxRetries: 0 (nemotron.ts, geminiVision.ts) specifically
 * so retries are never multiplied across two independent ladders. With
 * Nemotron as the sole registered provider, MAX_RETRIES_PER_PROVIDER=3
 * means exactly 4 total attempts for one logical step (1 initial + 3
 * retries), worst case 4 x 180s = 12 min against a 20-minute turn
 * budget. Phase 40 first set this to 2 (3 total attempts) to kill SDK
 * x outer multiplication; the very next live verification then hit a
 * real NVIDIA 500 that would have recovered on a 4th attempt (measured:
 * a trivial 20-token probe took ~37s, well inside "transient and
 * retryable," not "provider down"). 3 was too little headroom for that
 * observed reliability profile; 4 total is the correction - still a
 * single bounded ladder, not a second one.
 */
/**
 * Phase 41C: this default applies to any provider that doesn't declare
 * its own `maxAttempts` (see provider.ts) - the primary keeps exactly
 * this behavior unchanged. A fallback provider CAN ask for fewer total
 * attempts (Lightning: 2, not 4) - still read from this one function,
 * never a second retry mechanism.
 */
const DEFAULT_MAX_ATTEMPTS_PER_PROVIDER = 4;
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
 * a non-retryable failure (malformed request) or cancellation moves
 * straight past retries. Cancellation additionally aborts the whole
 * function immediately, skipping any remaining providers - the turn is
 * being torn down, not degraded to a slower provider. An "auth" failure
 * (Phase 41 §4) similarly aborts immediately without trying a later
 * provider - a broken credential is Huddle's/the user's problem to fix,
 * not something a fallback model should silently paper over.
 *
 * Throws the last error once every provider's attempts are exhausted
 * (or immediately on cancellation/auth), preserving the existing
 * "provider_error" termination behavior in runAgentTurn for the
 * genuinely-nothing-worked case.
 */
export async function generateStepWithRecovery(
  providers: AgentModelProvider[],
  messages: ChatCompletionMessageParam[],
  tools: ChatCompletionTool[],
  signal: AbortSignal | undefined,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  /**
   * Phase 40 §7: absolute timestamp past which no NEW attempt may
   * start. An in-flight attempt is always allowed to finish (aborting
   * it would throw away whatever it already spent); this only stops the
   * retry ladder from beginning another one. Omitted = no deadline,
   * preserving the previous behavior for callers that don't have one.
   */
  deadline?: number
): Promise<ProviderRecoveryResult> {
  let lastError: unknown = new Error("No providers configured.");
  let attempts = 0;

  for (const provider of providers) {
    const maxAttempts = provider.maxAttempts ?? DEFAULT_MAX_ATTEMPTS_PER_PROVIDER;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (signal?.aborted) throw lastError;
      // Checked here rather than only in the caller so a retry storm
      // can't keep burning time after the turn's ceiling has passed.
      if (deadline !== undefined && Date.now() >= deadline && attempts > 0) throw lastError;
      attempts++;

      try {
        const step = await provider.generateStep(messages, tools, signal);
        return { step, providerId: provider.id, attempts };
      } catch (error) {
        lastError = error;

        if (signal?.aborted) throw error;
        if (error instanceof AgentProviderError && error.kind === "cancelled") throw error;
        /**
         * Phase 41 §4: an auth failure means THIS credential is broken,
         * not that the model is having a bad moment - falling through to
         * a different provider would silently mask a misconfigured key
         * behind a working fallback instead of surfacing the real,
         * fixable problem. Every other AgentProviderError kind (timeout,
         * network, malformed_response, rate_limited, unknown) is
         * genuinely provider-side and stays eligible to fall through.
         */
        if (error instanceof AgentProviderError && error.kind === "auth") throw error;

        const retryable = error instanceof AgentProviderError ? error.retryable : false;
        if (retryable && attempt < maxAttempts - 1) {
          await sleep(backoffDelayMs(attempt + 1));
          continue;
        }

        break; // this provider is done (retries exhausted or non-retryable) - fall through to the next provider
      }
    }
  }

  throw lastError;
}
