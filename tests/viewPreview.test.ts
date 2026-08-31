import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeHost } from "@/types/session";

/**
 * Phase 17: view_preview's bounded-wait behavior (state readiness +
 * paint readiness), tested against a fake runtimeHost doc and a
 * controllable dispatchRuntimeCommand, with fake timers standing in for
 * the real polling/backoff delays - same discipline as
 * runtimeSession.test.ts's fake-timer coverage of startDevServer.
 */
const fake = {
  hostQueue: [] as Array<Partial<RuntimeHost> | undefined>,
};

function nextHost(): Partial<RuntimeHost> | undefined {
  return fake.hostQueue.length > 1 ? fake.hostQueue.shift() : fake.hostQueue[0];
}

function setHostQueue(queue: Array<Partial<RuntimeHost> | undefined>) {
  fake.hostQueue = queue;
}

vi.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return {
      collection: () => ({
        doc: () => ({
          get: async () => ({ data: () => nextHost() }),
        }),
      }),
    };
  },
}));

const dispatchRuntimeCommand = vi.fn();
vi.mock("@/lib/runtime/commandRelay", () => ({
  dispatchRuntimeCommand: (...args: unknown[]) => dispatchRuntimeCommand(...args),
}));

const analyzePreviewScreenshot = vi
  .fn()
  .mockResolvedValue({ status: "success", critique: "Looks fine.", provider: "local-qwen" });
vi.mock("@/lib/preview/visionAnalysis", () => ({
  analyzePreviewScreenshot: (...args: unknown[]) => analyzePreviewScreenshot(...args),
}));

const { viewPreview } = await import("@/lib/preview/viewPreview");

const CAPTURE_SUCCESS = {
  status: "done",
  result: { dataUrl: "data:image/png;base64,xyz", width: 1280, height: 800 },
};

function captureError(message: string) {
  return { status: "error", errorMessage: message };
}

beforeEach(() => {
  fake.hostQueue = [];
  dispatchRuntimeCommand.mockReset();
  analyzePreviewScreenshot.mockClear();
});

describe("viewPreview - server readiness (Phase 17)", () => {
  it("7. captures immediately when the runtime is already running - no waiting at all", async () => {
    setHostQueue([{ state: "running", previewUrl: "https://preview.example/" }]);
    dispatchRuntimeCommand.mockResolvedValue(CAPTURE_SUCCESS);

    const result = await viewPreview("s1");

    expect(result.status).toBe("success");
    expect(dispatchRuntimeCommand).toHaveBeenCalledTimes(1);
  });

  it("8a. returns unavailable immediately when the runtime is crashed, with the real reason, never dispatching a capture", async () => {
    setHostQueue([{ state: "crashed", errorMessage: "npm install failed (exit 1): something broke" }]);

    const result = await viewPreview("s1");

    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.message).toContain("something broke");
    }
    expect(dispatchRuntimeCommand).not.toHaveBeenCalled();
  });

  it("8b. returns unavailable immediately when the runtime timed out starting, with the real reason", async () => {
    setHostQueue([{ state: "timeout", errorMessage: "didn't open a port within 90s." }]);

    const result = await viewPreview("s1");

    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.message).toContain("didn't open a port within 90s");
    }
    expect(dispatchRuntimeCommand).not.toHaveBeenCalled();
  });

  it("returns unavailable immediately when no runtimeHost doc exists at all - nothing to wait for", async () => {
    setHostQueue([undefined]);

    const result = await viewPreview("s1");

    expect(result.status).toBe("unavailable");
    expect(dispatchRuntimeCommand).not.toHaveBeenCalled();
  });

  it("6. waits, bounded, while STARTING, and captures once state reaches running", async () => {
    vi.useFakeTimers();
    try {
      setHostQueue([
        { state: "installing" },
        { state: "starting" },
        { state: "starting" },
        { state: "running", previewUrl: "https://preview.example/" },
      ]);
      dispatchRuntimeCommand.mockResolvedValue(CAPTURE_SUCCESS);

      const done = viewPreview("s1");
      await vi.advanceTimersByTimeAsync(8_000); // a few 2s polls
      const result = await done;

      expect(result.status).toBe("success");
    } finally {
      vi.useRealTimers();
    }
  });

  it("crashes mid-wait: a STARTING state that turns crashed before the deadline returns unavailable with the real reason, not a generic timeout", async () => {
    vi.useFakeTimers();
    try {
      setHostQueue([
        { state: "installing" },
        { state: "crashed", errorMessage: "npm install failed (exit 1): disk full" },
      ]);

      const done = viewPreview("s1");
      await vi.advanceTimersByTimeAsync(4_000);
      const result = await done;

      expect(result.status).toBe("unavailable");
      if (result.status === "unavailable") {
        expect(result.message).toContain("disk full");
      }
      expect(dispatchRuntimeCommand).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns 'starting' (not 'unavailable') once the bounded state-wait deadline is exceeded while still starting - still worth a later retry", async () => {
    vi.useFakeTimers();
    try {
      setHostQueue([{ state: "installing" }]); // never progresses

      const done = viewPreview("s1");
      await vi.advanceTimersByTimeAsync(51_000); // past STATE_READY_WAIT_MS (Phase 40: 25s -> 50s)
      const result = await done;

      expect(result.status).toBe("starting");
      expect(dispatchRuntimeCommand).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("viewPreview - paint readiness (Phase 17, section 7: SERVER ready vs PAGE painted)", () => {
  it("9. retries with bounded backoff when the server is ready but the preview page hasn't painted/handshaked yet, then succeeds", async () => {
    vi.useFakeTimers();
    try {
      setHostQueue([{ state: "running", previewUrl: "https://preview.example/" }]);
      dispatchRuntimeCommand
        .mockResolvedValueOnce(captureError("No live preview page to capture yet - make sure the dev server is running."))
        .mockResolvedValueOnce(captureError("No live preview page to capture yet - make sure the dev server is running."))
        .mockResolvedValueOnce(CAPTURE_SUCCESS);

      const done = viewPreview("s1");
      await vi.advanceTimersByTimeAsync(15_000); // covers the backoff delays
      const result = await done;

      expect(result.status).toBe("success");
      expect(dispatchRuntimeCommand).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up as not_ready once the paint-retry budget is exhausted, rather than retrying forever", async () => {
    vi.useFakeTimers();
    try {
      setHostQueue([{ state: "running", previewUrl: "https://preview.example/" }]);
      dispatchRuntimeCommand.mockResolvedValue(
        captureError("No live preview page to capture yet - make sure the dev server is running.")
      );

      const done = viewPreview("s1");
      await vi.advanceTimersByTimeAsync(15_000);
      const result = await done;

      expect(result.status).toBe("not_ready");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a genuine (non-'not ready') capture failure is not retried and is reported as failed", async () => {
    setHostQueue([{ state: "running", previewUrl: "https://preview.example/" }]);
    dispatchRuntimeCommand.mockResolvedValue(captureError("html2canvas failed to load in the previewed page."));

    const result = await viewPreview("s1");

    expect(result.status).toBe("failed");
    expect(dispatchRuntimeCommand).toHaveBeenCalledTimes(1);
  });
});

describe("viewPreview - repeated-capture change detection (Phase 26 section 7, items 6-7)", () => {
  it("6. an unchanged screenshot (identical dataUrl) reuses the previous critique instead of calling vision analysis again", async () => {
    setHostQueue([{ state: "running", previewUrl: "https://preview.example/" }]);
    dispatchRuntimeCommand.mockResolvedValue(CAPTURE_SUCCESS); // same dataUrl as before

    const first = await viewPreview("s1");
    if (first.status !== "success") throw new Error("expected success");
    expect(first.analysis.status).toBe("success");
    expect(analyzePreviewScreenshot).toHaveBeenCalledTimes(1);

    const second = await viewPreview("s1", undefined, {
      screenshotHash: first.screenshotHash,
      critique: first.analysis.status === "success" ? first.analysis.critique : "",
      provider: first.analysis.status === "success" ? first.analysis.provider : "",
    });

    expect(second.status).toBe("success");
    if (second.status === "success") {
      expect(second.analysis).toEqual({ status: "unchanged", critique: "Looks fine.", provider: "local-qwen" });
    }
    // Vision was NOT called again for the second, identical capture.
    expect(analyzePreviewScreenshot).toHaveBeenCalledTimes(1);
  });

  it("7. a meaningfully different screenshot (different dataUrl) triggers a fresh vision analysis", async () => {
    setHostQueue([{ state: "running", previewUrl: "https://preview.example/" }]);
    dispatchRuntimeCommand.mockResolvedValue(CAPTURE_SUCCESS);

    const first = await viewPreview("s1");
    if (first.status !== "success") throw new Error("expected success");

    dispatchRuntimeCommand.mockResolvedValue({
      status: "done",
      result: { dataUrl: "data:image/png;base64,DIFFERENT", width: 1280, height: 800 },
    });

    const second = await viewPreview("s1", undefined, {
      screenshotHash: first.screenshotHash,
      critique: "stale critique",
      provider: "local-qwen",
    });

    expect(second.status).toBe("success");
    if (second.status === "success") {
      expect(second.analysis.status).toBe("success"); // not "unchanged" - the hash differs
    }
    expect(analyzePreviewScreenshot).toHaveBeenCalledTimes(2); // once for `first`, once for `second`
  });

  it("with no previous check passed at all (first call this turn), vision analysis always runs", async () => {
    setHostQueue([{ state: "running", previewUrl: "https://preview.example/" }]);
    dispatchRuntimeCommand.mockResolvedValue(CAPTURE_SUCCESS);

    await viewPreview("s1");

    expect(analyzePreviewScreenshot).toHaveBeenCalledTimes(1);
  });
});
