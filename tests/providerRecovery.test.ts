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

  it("3. repeated failure -> bounded termination (max 3 retries per provider, then throws)", async () => {
    const persistentError = new AgentProviderError("p1", "network", "502 Bad Gateway", true);
    const generateStep = vi.fn().mockRejectedValue(persistentError);
    const provider = fakeProvider("p1", generateStep);
    const { sleep, delays } = fakeSleep();

    await expect(
      generateStepWithRecovery([provider], MESSAGES, TOOLS, undefined, sleep)
    ).rejects.toBe(persistentError);

    // Phase 40B: 1 initial attempt + 3 retries = 4 total calls, never more.
    expect(generateStep).toHaveBeenCalledTimes(4);
    expect(delays).toEqual([500, 1000, 2000]); // bounded exponential backoff, exactly 3 waits
  });

  it("4. provider failure (retries exhausted) -> fallback provider succeeds", async () => {
    const primaryError = new AgentProviderError("p1", "network", "503 Service Unavailable", true);
    const primary = fakeProvider("p1", vi.fn().mockRejectedValue(primaryError));
    const fallback = fakeProvider("p2", vi.fn().mockResolvedValue(okStep("from fallback")));
    const { sleep } = fakeSleep();

    const result = await generateStepWithRecovery([primary, fallback], MESSAGES, TOOLS, undefined, sleep);

    expect(result.providerId).toBe("p2");
    expect(result.step.message.content).toBe("from fallback");
    expect(primary.generateStep).toHaveBeenCalledTimes(4); // exhausted its own retries first
    expect(fallback.generateStep).toHaveBeenCalledTimes(1); // succeeded on first try, no retries needed
  });

  it("a non-retryable, non-auth failure (e.g. malformed response) skips straight to the next provider without retrying", async () => {
    const malformedError = new AgentProviderError("p1", "malformed_response", "unparseable body", false);
    const primary = fakeProvider("p1", vi.fn().mockRejectedValue(malformedError));
    const fallback = fakeProvider("p2", vi.fn().mockResolvedValue(okStep()));
    const { sleep, delays } = fakeSleep();

    const result = await generateStepWithRecovery([primary, fallback], MESSAGES, TOOLS, undefined, sleep);

    expect(result.providerId).toBe("p2");
    expect(primary.generateStep).toHaveBeenCalledTimes(1); // no retries for a non-retryable error
    expect(delays).toEqual([]); // never slept - nothing was retried
  });

  /**
   * Phase 41 §4: an auth failure means THIS credential is broken, not
   * that the model had a bad moment. Falling through to a fallback
   * provider would silently mask a misconfigured key behind a working
   * fallback instead of surfacing the real, fixable problem - so unlike
   * every other failure kind, auth aborts the whole call immediately.
   */
  it("an auth failure aborts immediately WITHOUT trying a fallback provider - a broken credential must surface, not be masked", async () => {
    const authError = new AgentProviderError("p1", "auth", "401 Unauthorized", false);
    const primary = fakeProvider("p1", vi.fn().mockRejectedValue(authError));
    const fallback = fakeProvider("p2", vi.fn().mockResolvedValue(okStep()));
    const { sleep, delays } = fakeSleep();

    await expect(
      generateStepWithRecovery([primary, fallback], MESSAGES, TOOLS, undefined, sleep)
    ).rejects.toBe(authError);

    expect(primary.generateStep).toHaveBeenCalledTimes(1); // no retries
    expect(fallback.generateStep).not.toHaveBeenCalled(); // never masked behind a fallback
    expect(delays).toEqual([]);
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
    expect(primary.generateStep).toHaveBeenCalledTimes(4);
    expect(secondary.generateStep).toHaveBeenCalledTimes(4);
    expect(tertiary.generateStep).toHaveBeenCalledTimes(1);
  });
});

/**
 * Phase 40B: after Phase 40's first live verification hit a real NVIDIA
 * 500 that would have recovered on a 4th attempt (a trivial 20-token
 * probe measured ~37s - slow, but reachable, not down), the outer
 * ladder's headroom was raised from 3 total attempts to 4
 * (MAX_RETRIES_PER_PROVIDER: 2 -> 3) - the ONLY change this phase makes.
 * These pin the exact attempt count and its interaction with the
 * turn's wall-clock deadline, so a future change can't silently drift
 * either back toward retry-multiplication or into unbounded retries.
 */
describe("generateStepWithRecovery - provider attempt headroom (Phase 40B)", () => {
  it("A. three failed attempts still allow a fourth attempt to start", async () => {
    const generateStep = vi
      .fn()
      .mockRejectedValueOnce(new AgentProviderError("p1", "network", "500", true))
      .mockRejectedValueOnce(new AgentProviderError("p1", "network", "500", true))
      .mockRejectedValueOnce(new AgentProviderError("p1", "network", "500", true))
      .mockResolvedValueOnce(okStep("fourth try"));
    const provider = fakeProvider("p1", generateStep);
    const { sleep } = fakeSleep();

    const result = await generateStepWithRecovery([provider], MESSAGES, TOOLS, undefined, sleep);

    expect(generateStep).toHaveBeenCalledTimes(4);
    expect(result.step.message.content).toBe("fourth try");
  });

  it("B. the fourth attempt succeeding lets the turn continue normally - attempts is reported accurately", async () => {
    const generateStep = vi
      .fn()
      .mockRejectedValueOnce(new AgentProviderError("p1", "network", "500", true))
      .mockRejectedValueOnce(new AgentProviderError("p1", "network", "500", true))
      .mockRejectedValueOnce(new AgentProviderError("p1", "network", "500", true))
      .mockResolvedValueOnce(okStep("recovered on attempt 4"));
    const provider = fakeProvider("p1", generateStep);
    const { sleep } = fakeSleep();

    const result = await generateStepWithRecovery([provider], MESSAGES, TOOLS, undefined, sleep);

    expect(result.providerId).toBe("p1");
    expect(result.attempts).toBe(4);
    expect(result.step.message.content).toBe("recovered on attempt 4");
  });

  it("C. four failed attempts (not five) -> the provider failure is thrown back to the caller", async () => {
    const persistentError = new AgentProviderError("p1", "network", "500", true);
    const generateStep = vi.fn().mockRejectedValue(persistentError);
    const provider = fakeProvider("p1", generateStep);
    const { sleep } = fakeSleep();

    await expect(
      generateStepWithRecovery([provider], MESSAGES, TOOLS, undefined, sleep)
    ).rejects.toBe(persistentError);

    expect(generateStep).toHaveBeenCalledTimes(4);
  });

  it("D. the wall-clock deadline expiring after 3 failures stops the 4th attempt from starting", async () => {
    let now = 1_000_000;
    // Backoff after attempts 1/2/3 is 500/1000/2000ms (cumulative
    // 500/1500/3500). A deadline of +2000ms falls strictly between the
    // 2nd and 3rd cumulative sleep, so exactly 3 calls happen before the
    // pre-4th-attempt check sees the deadline has passed.
    const deadline = now + 2_000;
    const generateStep = vi.fn().mockImplementation(async () => {
      throw new AgentProviderError("p1", "network", "500", true);
    });
    const provider = fakeProvider("p1", generateStep);
    // Each retry's backoff pushes the clock past the deadline before the 4th attempt would start.
    const sleep = async (ms: number) => {
      now += ms;
    };
    const originalNow = Date.now;
    Date.now = () => now;
    try {
      await expect(
        generateStepWithRecovery([provider], MESSAGES, TOOLS, undefined, sleep, deadline)
      ).rejects.toBeInstanceOf(AgentProviderError);
    } finally {
      Date.now = originalNow;
    }

    // 3 attempts were made (the deadline is only checked BEFORE a new
    // attempt, never cancelling one already in flight); the 4th never starts.
    expect(generateStep).toHaveBeenCalledTimes(3);
  });

  it("the initial attempt is never skipped even if the deadline has already passed - only RETRIES are gated", async () => {
    const provider = fakeProvider("p1", vi.fn().mockResolvedValue(okStep("first try")));
    const { sleep } = fakeSleep();

    const result = await generateStepWithRecovery([provider], MESSAGES, TOOLS, undefined, sleep, Date.now() - 1);

    expect(result.step.message.content).toBe("first try");
  });

  it("E+F. exactly ONE retry owner - this ladder is the only place attempts multiply; there is no SDK-level stacking to double them", async () => {
    // This function has no concept of an underlying SDK client, so it
    // cannot itself double-retry - the guarantee that SDK maxRetries is
    // 0 lives in each provider file (nemotron.ts, geminiVision.ts) and
    // is pinned by providerIsolation.test.ts. What this test proves is
    // the OUTER half of that contract: for N providers, calls are
    // bounded by exactly N x 4, never N x 4 x anything.
    const providers = [
      fakeProvider("p1", vi.fn().mockRejectedValue(new AgentProviderError("p1", "network", "500", true))),
      fakeProvider("p2", vi.fn().mockRejectedValue(new AgentProviderError("p2", "network", "500", true))),
    ];
    const { sleep } = fakeSleep();

    await expect(
      generateStepWithRecovery(providers, MESSAGES, TOOLS, undefined, sleep)
    ).rejects.toBeInstanceOf(AgentProviderError);

    for (const p of providers) {
      expect(p.generateStep).toHaveBeenCalledTimes(4); // never 6, 8, or any multiplied count
    }
  });
});
