import { describe, expect, it, vi } from "vitest";

import { analyzeWithRecovery } from "@/lib/preview/visionRecovery";
import { AgentProviderError } from "@/lib/agent/provider";

import type { VisionProvider } from "@/lib/preview/visionProvider";

/**
 * Phase 26: the vision-side sibling of tests/providerRecovery.test.ts -
 * same discipline (fake providers, fake sleep, no real network/model
 * calls). Covers section 10 items 2-5: local succeeds -> external not
 * called; local unavailable -> external attempted; external also
 * unavailable -> structured failure; no infinite retry loop.
 */
function fakeProvider(id: string, analyze: VisionProvider["analyze"]): VisionProvider {
  return { id, displayName: id, analyze };
}

function fakeSleep() {
  const delays: number[] = [];
  const sleep = async (ms: number) => {
    delays.push(ms);
  };
  return { sleep, delays };
}

describe("analyzeWithRecovery", () => {
  it("2. local provider succeeds -> external provider is never called", async () => {
    const local = fakeProvider("local-qwen", vi.fn().mockResolvedValue("Local critique."));
    const external = fakeProvider("gemini", vi.fn().mockResolvedValue("External critique."));
    const { sleep } = fakeSleep();

    const result = await analyzeWithRecovery([local, external], "data:image/jpeg;base64,x", "prompt", sleep);

    expect(result.providerId).toBe("local-qwen");
    expect(result.critique).toBe("Local critique.");
    expect(local.analyze).toHaveBeenCalledTimes(1);
    expect(external.analyze).not.toHaveBeenCalled();
  });

  it("3. local provider unavailable -> external provider is attempted and succeeds", async () => {
    const local = fakeProvider(
      "local-qwen",
      vi.fn().mockRejectedValue(new AgentProviderError("local-qwen", "network", "connect ECONNREFUSED", true))
    );
    const external = fakeProvider("gemini", vi.fn().mockResolvedValue("External critique."));
    const { sleep } = fakeSleep();

    const result = await analyzeWithRecovery([local, external], "data:image/jpeg;base64,x", "prompt", sleep);

    expect(result.providerId).toBe("gemini");
    expect(result.critique).toBe("External critique.");
    expect(external.analyze).toHaveBeenCalledTimes(1);
  });

  it("4. both local and external unavailable -> throws, giving the caller a structured failure to build from", async () => {
    const localError = new AgentProviderError("local-qwen", "network", "connect ECONNREFUSED", true);
    const externalError = new AgentProviderError("gemini", "rate_limited", "429 rate limited", true);
    const local = fakeProvider("local-qwen", vi.fn().mockRejectedValue(localError));
    const external = fakeProvider("gemini", vi.fn().mockRejectedValue(externalError));
    const { sleep } = fakeSleep();

    await expect(
      analyzeWithRecovery([local, external], "data:image/jpeg;base64,x", "prompt", sleep)
    ).rejects.toBe(externalError); // the LAST error, per generateStepWithRecovery's own established convention
  });

  it("5. bounded retry per provider (1 retry, not unbounded) - never loops forever on a persistent failure", async () => {
    const persistentError = new AgentProviderError("local-qwen", "timeout", "Request timed out.", true);
    const local = fakeProvider("local-qwen", vi.fn().mockRejectedValue(persistentError));
    const external = fakeProvider("gemini", vi.fn().mockResolvedValue("ok"));
    const { sleep, delays } = fakeSleep();

    await analyzeWithRecovery([local, external], "data:image/jpeg;base64,x", "prompt", sleep);

    // 1 initial attempt + 1 retry = 2 total calls for the failing provider, never more.
    expect(local.analyze).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([300]);
  });

  it("a non-retryable failure (e.g. no API key) skips straight to the next provider without retrying", async () => {
    const authError = new AgentProviderError("gemini", "auth", "No GEMINI_API_KEY configured.", false);
    const local = fakeProvider("local-qwen", vi.fn().mockRejectedValue(authError));
    const external = fakeProvider("gemini", vi.fn().mockResolvedValue("ok"));
    const { sleep, delays } = fakeSleep();

    const result = await analyzeWithRecovery([local, external], "data:image/jpeg;base64,x", "prompt", sleep);

    expect(result.providerId).toBe("gemini");
    expect(local.analyze).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it("passes the exact dataUrl and prompt through to the provider unchanged", async () => {
    const analyze = vi.fn().mockResolvedValue("critique");
    const local = fakeProvider("local-qwen", analyze);
    const { sleep } = fakeSleep();

    await analyzeWithRecovery([local], "data:image/jpeg;base64,abc123", "evaluate this screenshot", sleep);

    expect(analyze).toHaveBeenCalledWith("data:image/jpeg;base64,abc123", "evaluate this screenshot");
  });
});
