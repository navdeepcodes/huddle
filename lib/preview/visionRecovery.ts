import "server-only";

import { AgentProviderError } from "@/lib/agent/provider";

import type { VisionProvider } from "@/lib/preview/visionProvider";

/**
 * Phase 26: the vision-side sibling of lib/agent/providerRecovery.ts's
 * generateStepWithRecovery - same shape (ordered providers, bounded
 * retry per provider on a retryable failure, fall through to the next
 * provider, throw the last error once everything's exhausted), not a
 * generic-ified reuse of that function (its return shape is an
 * AgentStepResult with tool_calls, genuinely wrong for a one-shot
 * critique string - forcing vision through it would need a fake
 * tools/messages/step shape for no real benefit). MAX_RETRIES is 1
 * here, not providerRecovery's 2 - section 4's own instruction is to
 * fail fast into the next tier, not spend the agent's turn waiting on
 * a local model that's already shown itself unavailable.
 */
const MAX_RETRIES_PER_PROVIDER = 1;
const BASE_BACKOFF_MS = 300;

export interface VisionRecoveryResult {
  critique: string;
  providerId: string;
}

function backoffDelayMs(retryAttempt: number): number {
  return BASE_BACKOFF_MS * 2 ** (retryAttempt - 1);
}

export async function analyzeWithRecovery(
  providers: VisionProvider[],
  dataUrl: string,
  prompt: string,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
): Promise<VisionRecoveryResult> {
  let lastError: unknown = new Error("No vision providers configured.");

  for (const provider of providers) {
    for (let attempt = 0; attempt <= MAX_RETRIES_PER_PROVIDER; attempt++) {
      try {
        const critique = await provider.analyze(dataUrl, prompt);
        return { critique, providerId: provider.id };
      } catch (error) {
        lastError = error;

        const retryable = error instanceof AgentProviderError ? error.retryable : false;
        if (retryable && attempt < MAX_RETRIES_PER_PROVIDER) {
          await sleep(backoffDelayMs(attempt + 1));
          continue;
        }

        break; // this provider is done - fall through to the next one
      }
    }
  }

  throw lastError;
}
