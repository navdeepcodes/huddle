import { describe, expect, it, vi } from "vitest";

import { generateStepWithRecovery } from "@/lib/agent/providerRecovery";
import { AgentProviderError } from "@/lib/agent/provider";

import type { AgentModelProvider, AgentStepResult } from "@/lib/agent/provider";

const TOOLS: never[] = [];
const MESSAGES = [{ role: "user" as const, content: "build something" }];

function okStep(text = "done"): AgentStepResult {
  return {
    message: { role: "assistant", content: text },
    truncated: false,
    usage: null,
  };
}

function fakeProvider(id: string, generateStep: AgentModelProvider["generateStep"]): AgentModelProvider {
  return { id, displayName: id, model: "test-model", generateStep };
}

/** No real waiting in tests - just records the delays it was asked for. */
function fakeSleep() {
  const delays: number[] = [];
  const sleep = async (ms: number) => {
    delays.push(ms);
  };
  return { sleep, delays };
}

describe("generateStepWithRecovery", () => {
  it("returns the first successful step with no retry when nothing fails", async () => {
    const provider = fakeProvider("p1", vi.fn().mockResolvedValue(okStep()));
    const { sleep } = fakeSleep();

    const result = await generateStepWithRecovery([provider], MESSAGES, TOOLS, undefined, sleep);

    expect(result.providerId).toBe("p1");
    expect(provider.generateStep).toHaveBeenCalledTimes(1);
  });

  it("1. transient 500 -> retry -> success", async () => {
    const generateStep = vi
      .fn()
      .mockRejectedValueOnce(new AgentProviderError("p1", "network", "500 Internal Server Error", true))
      .mockResolvedValueOnce(okStep("recovered"));
    const provider = fakeProvider("p1", generateStep);
    const { sleep, delays } = fakeSleep();

    const result = await generateStepWithRecovery([provider], MESSAGES, TOOLS, undefined, sleep);

    expect(result.providerId).toBe("p1");
    expect(result.step.message.content).toBe("recovered");
    expect(generateStep).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([500]); // one retry, first backoff step
  });

  it("2. timeout -> retry -> success", async () => {
    const generateStep = vi
      .fn()
      .mockRejectedValueOnce(new AgentProviderError("p1", "timeout", "Request timed out.", true))
      .mockResolvedValueOnce(okStep("recovered"));
    const provider = fakeProvider("p1", generateStep);
    const { sleep } = fakeSleep();

    const result = await generateStepWithRecovery([provider], MESSAGES, TOOLS, undefined, sleep);

    expect(result.step.message.content).toBe("recovered");
    expect(generateStep).toHaveBeenCalledTimes(2);
  });

  it("3. repeated failure -> bounded termination (max 2 retries per provider, then throws)", async () => {
    const persistentError = new AgentProviderError("p1", "network", "502 Bad Gateway", true);
    const generateStep = vi.fn().mockRejectedValue(persistentError);
    const provider = fakeProvider("p1", generateStep);
    const { sleep, delays } = fakeSleep();

    await expect(
      generateStepWithRecovery([provider], MESSAGES, TOOLS, undefined, sleep)
    ).rejects.toBe(persistentError);

    // 1 initial attempt + 2 retries = 3 total calls, never more.
    expect(generateStep).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([500, 1000]); // bounded exponential backoff, exactly 2 waits
  });

  it("4. provider failure (retries exhausted) -> fallback provider succeeds", async () => {
    const primaryError = new AgentProviderError("p1", "network", "503 Service Unavailable", true);
    const primary = fakeProvider("p1", vi.fn().mockRejectedValue(primaryError));
    const fallback = fakeProvider("p2", vi.fn().mockResolvedValue(okStep("from fallback")));
    const { sleep } = fakeSleep();

    const result = await generateStepWithRecovery([primary, fallback], MESSAGES, TOOLS, undefined, sleep);

    expect(result.providerId).toBe("p2");
    expect(result.step.message.content).toBe("from fallback");
    expect(primary.generateStep).toHaveBeenCalledTimes(3); // exhausted its own retries first
    expect(fallback.generateStep).toHaveBeenCalledTimes(1); // succeeded on first try, no retries needed
  });

  it("a non-retryable failure (e.g. auth) skips straight to the next provider without retrying", async () => {
    const authError = new AgentProviderError("p1", "auth", "401 Unauthorized", false);
    const primary = fakeProvider("p1", vi.fn().mockRejectedValue(authError));
    const fallback = fakeProvider("p2", vi.fn().mockResolvedValue(okStep()));
    const { sleep, delays } = fakeSleep();

    const result = await generateStepWithRecovery([primary, fallback], MESSAGES, TOOLS, undefined, sleep);

    expect(result.providerId).toBe("p2");
    expect(primary.generateStep).toHaveBeenCalledTimes(1); // no retries for a non-retryable error
    expect(delays).toEqual([]); // never slept - nothing was retried
  });

  it("cancellation aborts immediately without trying any further provider or retry", async () => {
    const controller = new AbortController();
    const cancelledError = new AgentProviderError("p1", "cancelled", "Aborted", false);
    const primary = fakeProvider(
      "p1",
      vi.fn().mockImplementation(async () => {
        controller.abort();
        throw cancelledError;
      })
    );
    const fallback = fakeProvider("p2", vi.fn().mockResolvedValue(okStep()));
    const { sleep } = fakeSleep();

    await expect(
      generateStepWithRecovery([primary, fallback], MESSAGES, TOOLS, controller.signal, sleep)
    ).rejects.toBe(cancelledError);

    expect(fallback.generateStep).not.toHaveBeenCalled();
  });

  it("5. never calls generateStep more than the bounded retry count, even across a fallback chain - proof no step (and therefore no tool call resulting from a step) can be produced twice by this function", async () => {
    const primary = fakeProvider(
      "p1",
      vi.fn().mockRejectedValue(new AgentProviderError("p1", "network", "500", true))
    );
    const secondary = fakeProvider(
      "p2",
      vi.fn().mockRejectedValue(new AgentProviderError("p2", "network", "500", true))
    );
    const tertiary = fakeProvider("p3", vi.fn().mockResolvedValue(okStep("ok")));
    const { sleep } = fakeSleep();

    const result = await generateStepWithRecovery(
      [primary, secondary, tertiary],
      MESSAGES,
      TOOLS,
      undefined,
      sleep
    );

    // Exactly one successful step is ever returned - the caller (runAgentTurn)
    // only processes tool_calls from the single AgentStepResult this
    // function hands back, so there is exactly one set of tool_calls to
    // execute per loop iteration regardless of how many providers/retries
    // it took to get there.
    expect(result.providerId).toBe("p3");
    expect(primary.generateStep).toHaveBeenCalledTimes(3);
    expect(secondary.generateStep).toHaveBeenCalledTimes(3);
    expect(tertiary.generateStep).toHaveBeenCalledTimes(1);
  });
});
