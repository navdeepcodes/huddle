import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Phase 26: proves the section 4 "stop looping on vision failure"
 * mechanism actually reaches the model - the exact live-observed Phase
 * 25 failure (5 consecutive view_preview calls, all rate-limited, no
 * stop signal) - and that a successful capture's hash/critique is
 * carried in previewCheck for loop.ts to thread into the next call.
 */
const viewPreview = vi.fn();
vi.mock("@/lib/preview/viewPreview", () => ({
  viewPreview: (...args: unknown[]) => viewPreview(...args),
}));

vi.mock("@/lib/files/fileStore", () => ({
  deleteSessionFile: vi.fn(),
  listSessionDirectory: vi.fn(),
  readSessionFile: vi.fn(),
}));

vi.mock("@/lib/runtime/commandRelay", () => ({
  dispatchRuntimeCommand: vi.fn(),
}));

const { executeTool } = await import("@/lib/agent/executeTool");

function toolCall(name: string, args: Record<string, unknown> = {}) {
  return {
    id: "call-1",
    type: "function" as const,
    function: { name, arguments: JSON.stringify(args) },
  };
}

beforeEach(() => {
  viewPreview.mockReset();
});

describe("executeTool - view_preview vision-failure signal (Phase 26 section 4)", () => {
  it("does not add a stop-note on the first vision failure", async () => {
    viewPreview.mockResolvedValue({
      status: "success",
      message: "Screenshot captured.",
      viewport: { width: 1440, height: 900 },
      screenshot: "data:image/jpeg;base64,x",
      screenshotHash: "h1",
      previewUrl: null,
      analysis: { status: "unavailable", reason: "Vision provider rate-limited.", retryable: true },
      paintReadyMs: 100,
    });

    const result = await executeTool("s1", toolCall("view_preview"), { consecutiveVisionFailures: 0 });

    expect(result.content).not.toContain("stop calling view_preview");
  });

  it("adds an explicit stop directive once consecutive vision failures reach the threshold", async () => {
    viewPreview.mockResolvedValue({
      status: "success",
      message: "Screenshot captured.",
      viewport: { width: 1440, height: 900 },
      screenshot: "data:image/jpeg;base64,x",
      screenshotHash: "h1",
      previewUrl: null,
      analysis: { status: "unavailable", reason: "Vision provider rate-limited.", retryable: true },
      paintReadyMs: 100,
    });

    const result = await executeTool("s1", toolCall("view_preview"), { consecutiveVisionFailures: 1 });

    expect(result.content).toContain("stop calling view_preview");
    expect(result.content).toContain("verify using run_command");
  });

  it("reports previewCheck.visionOk = false and does not include a critique when vision failed", async () => {
    viewPreview.mockResolvedValue({
      status: "success",
      message: "Screenshot captured.",
      viewport: { width: 1440, height: 900 },
      screenshot: "data:image/jpeg;base64,x",
      screenshotHash: "h1",
      previewUrl: null,
      analysis: { status: "failed", reason: "Vision call returned no text.", retryable: false },
      paintReadyMs: 100,
    });

    const result = await executeTool("s1", toolCall("view_preview"));

    expect(result.previewCheck).toEqual({ screenshotHash: "h1", visionOk: false });
  });

  it("reports previewCheck.visionOk = true with the critique/provider when vision succeeds", async () => {
    viewPreview.mockResolvedValue({
      status: "success",
      message: "Screenshot captured.",
      viewport: { width: 1440, height: 900 },
      screenshot: "data:image/jpeg;base64,x",
      screenshotHash: "h2",
      previewUrl: null,
      analysis: { status: "success", critique: "ISSUES:\n- none", provider: "local-qwen" },
      paintReadyMs: 100,
    });

    const result = await executeTool("s1", toolCall("view_preview"));

    expect(result.previewCheck).toEqual({
      screenshotHash: "h2",
      visionOk: true,
      critique: "ISSUES:\n- none",
      provider: "local-qwen",
    });
  });

  it("passes context.previousPreview straight through to viewPreview", async () => {
    viewPreview.mockResolvedValue({
      status: "success",
      message: "Screenshot captured.",
      viewport: { width: 1440, height: 900 },
      screenshot: "data:image/jpeg;base64,x",
      screenshotHash: "h1",
      previewUrl: null,
      analysis: { status: "unchanged", critique: "cached", provider: "local-qwen" },
      paintReadyMs: 100,
    });

    const previous = { screenshotHash: "h1", critique: "cached", provider: "local-qwen" };
    await executeTool("s1", toolCall("view_preview"), { previousPreview: previous });

    expect(viewPreview).toHaveBeenCalledWith("s1", undefined, previous);
  });

  it("does not set previewCheck when the capture itself failed (non-success status)", async () => {
    viewPreview.mockResolvedValue({ status: "not_ready", message: "No live preview page yet." });

    const result = await executeTool("s1", toolCall("view_preview"));

    expect(result.previewCheck).toBeUndefined();
    expect(result.ok).toBe(false);
  });
});

/**
 * Phase 27 Part I.2: the isolated single-call tests above prove the
 * logic in each state, but not that a genuine SEQUENCE of calls with
 * the counter threaded exactly the way loop.ts threads it actually
 * reaches the threshold and stays quiet before it - a real,
 * deterministic simulation of "vision unavailable -> view_preview ->
 * failure, repeatedly" (not a real rate limit, per the phase's own
 * instruction). Mirrors loop.ts's own update logic exactly (see
 * loop.ts's otherCalls handling: consecutiveVisionFailures resets to 0
 * on visionOk, increments by 1 otherwise) rather than re-deriving it -
 * if that logic ever changes, this test should change with it, not
 * silently drift out of sync.
 */
describe("executeTool - view_preview vision-failure signal across a real call sequence (Phase 27 Part I.2)", () => {
  function failingViewPreview(hash: string) {
    return {
      status: "success" as const,
      message: "Screenshot captured.",
      viewport: { width: 1440, height: 900 },
      screenshot: "data:image/jpeg;base64,x",
      screenshotHash: hash,
      previewUrl: null,
      analysis: { status: "unavailable" as const, reason: "Vision provider rate-limited.", retryable: true },
      paintReadyMs: 100,
    };
  }

  it("stays quiet on the 1st real failure, then instructs the agent to stop starting on the 2nd - driven by real accumulated state across a genuine call sequence, not a hardcoded count", async () => {
    let consecutiveVisionFailures = 0;
    const seenContents: string[] = [];

    for (let call = 1; call <= 3; call++) {
      viewPreview.mockResolvedValueOnce(failingViewPreview(`hash-${call}`));

      const result = await executeTool("s1", toolCall("view_preview"), { consecutiveVisionFailures });
      seenContents.push(result.content);

      // Exactly loop.ts's own update rule (lib/agent/loop.ts, the
      // view_preview branch of the otherCalls loop).
      consecutiveVisionFailures = result.previewCheck?.visionOk ? 0 : consecutiveVisionFailures + 1;
    }

    // VISION_FAILURE_STOP_THRESHOLD is 2 (executeTool.ts) - the 1st
    // real failure (counter arrives at 0, becomes 1 inside the call)
    // stays quiet; the 2nd and 3rd (counter arrives at 1 and 2) both
    // carry the directive, since the agent may not act on it instantly.
    expect(seenContents[0]).not.toContain("stop calling view_preview");
    expect(seenContents[1]).toContain("stop calling view_preview");
    expect(seenContents[1]).toContain("verify using run_command");
    expect(seenContents[2]).toContain("stop calling view_preview");
  });

  it("a successful vision call in the middle of a failure streak resets the counter, so the stop directive does not fire prematurely afterward", async () => {
    let consecutiveVisionFailures = 0;
    const seenContents: string[] = [];

    // Two failures (builds up to just below threshold)...
    for (let call = 1; call <= 2; call++) {
      viewPreview.mockResolvedValueOnce(failingViewPreview(`fail-${call}`));
      const result = await executeTool("s1", toolCall("view_preview"), { consecutiveVisionFailures });
      seenContents.push(result.content);
      consecutiveVisionFailures = result.previewCheck?.visionOk ? 0 : consecutiveVisionFailures + 1;
    }

    // ...then a real success (e.g. the provider recovered).
    viewPreview.mockResolvedValueOnce({
      status: "success",
      message: "Screenshot captured.",
      viewport: { width: 1440, height: 900 },
      screenshot: "data:image/jpeg;base64,x",
      screenshotHash: "recovered",
      previewUrl: null,
      analysis: { status: "success", critique: "ISSUES:\n- none", provider: "local-qwen" },
      paintReadyMs: 100,
    });
    const recovered = await executeTool("s1", toolCall("view_preview"), { consecutiveVisionFailures });
    consecutiveVisionFailures = recovered.previewCheck?.visionOk ? 0 : consecutiveVisionFailures + 1;
    expect(consecutiveVisionFailures).toBe(0);

    // One more failure right after recovery should NOT immediately re-trigger the stop directive.
    viewPreview.mockResolvedValueOnce(failingViewPreview("fail-again"));
    const afterRecovery = await executeTool("s1", toolCall("view_preview"), { consecutiveVisionFailures });
    expect(afterRecovery.content).not.toContain("stop calling view_preview");
  });
});
