import { describe, expect, it } from "vitest";
import { derivePreviewState, RECOVERY_GRACE_MS } from "@/lib/preview/previewState";

import type { RuntimeHost } from "@/types/session";

function host(overrides: Partial<RuntimeHost>): RuntimeHost {
  return {
    sessionId: "s1",
    state: "idle",
    port: null,
    previewUrl: null,
    ownerTabId: "tab-1",
    heartbeatAt: 0,
    errorMessage: null,
    updatedAt: 0,
    ...overrides,
  };
}

describe("derivePreviewState (Phase 30)", () => {
  it("no host at all -> idle", () => {
    expect(derivePreviewState(null, false, 0).state).toBe("idle");
  });

  it("installing -> building", () => {
    expect(derivePreviewState(host({ state: "installing" }), false, 0).state).toBe("building");
  });

  it("starting -> starting_server", () => {
    expect(derivePreviewState(host({ state: "starting" }), false, 0).state).toBe("starting_server");
  });

  it("running with a previewUrl but the iframe hasn't fired 'load' yet -> rendering", () => {
    const info = derivePreviewState(host({ state: "running", previewUrl: "https://x" }), false, 0);
    expect(info.state).toBe("rendering");
  });

  it("running with a previewUrl and the iframe HAS loaded -> ready", () => {
    const info = derivePreviewState(host({ state: "running", previewUrl: "https://x" }), true, 0);
    expect(info.state).toBe("ready");
  });

  it("running but somehow no previewUrl yet -> starting_server, not a crash", () => {
    expect(derivePreviewState(host({ state: "running", previewUrl: null }), false, 0).state).toBe("starting_server");
  });

  it("crashed, recently -> recovering (the existing watchForRecovery loop is actually running)", () => {
    const info = derivePreviewState(host({ state: "crashed", updatedAt: 1000 }), false, 1000 + 5_000);
    expect(info.state).toBe("recovering");
  });

  it("crashed, past the UI grace period -> error, with a manual retry surfaced", () => {
    const info = derivePreviewState(host({ state: "crashed", updatedAt: 1000, errorMessage: "port never opened" }), false, 1000 + RECOVERY_GRACE_MS + 1);
    expect(info.state).toBe("error");
    expect(info.detail).toContain("port never opened");
  });

  it("timeout -> error immediately, never 'recovering' - there is no automatic recovery loop for timeout (only crashed)", () => {
    const info = derivePreviewState(host({ state: "timeout", updatedAt: 1000 }), false, 1000 + 1);
    expect(info.state).toBe("error");
  });

  it("never claims 'ready' without the iframe having actually fired load, no matter the elapsed time", () => {
    const info = derivePreviewState(host({ state: "running", previewUrl: "https://x", updatedAt: 0 }), false, 999_999_999);
    expect(info.state).not.toBe("ready");
    expect(info.state).toBe("rendering");
  });

  it("Phase 30 Part 15 #6/#8 (runtime reconnect / recovery succeeds): the SAME host doc transitioning crashed -> running is exactly what flips recovering -> ready once the iframe also loads - no separate 'recovered' flag needed, the real state is the evidence", () => {
    const crashedHost = host({ state: "crashed", updatedAt: 1000 });
    const recovering = derivePreviewState(crashedHost, false, 1000 + 5_000);
    expect(recovering.state).toBe("recovering");

    // The backend's watchForRecovery actually succeeded - runtimeHost now reports running with a fresh previewUrl.
    const recoveredHost = host({ state: "running", previewUrl: "https://recovered", updatedAt: 1000 + 8_000 });
    const rendering = derivePreviewState(recoveredHost, false, 1000 + 8_000);
    expect(rendering.state).toBe("rendering"); // iframe hasn't fired load for the NEW url yet
    const ready = derivePreviewState(recoveredHost, true, 1000 + 8_500);
    expect(ready.state).toBe("ready");
  });

  it("Phase 30 Part 15 #12 (reload during recovery): derivePreviewState is a pure function of its current inputs - a fresh call with the same host doc after a reload produces the identical result, proving there is no hidden internal state a reload could lose or desynchronize", () => {
    const crashedHost = host({ state: "crashed", updatedAt: 1000, errorMessage: "boom" });
    const before = derivePreviewState(crashedHost, false, 1000 + 3_000);
    // Simulates a fresh mount (iframeLoaded reset to its initial false, a new `now`) reading the exact same Firestore doc - the realistic shape of "user reloaded the page."
    const afterReload = derivePreviewState(crashedHost, false, 1000 + 3_050);
    expect(afterReload.state).toBe(before.state);
    expect(afterReload.label).toBe(before.label);
  });
});
