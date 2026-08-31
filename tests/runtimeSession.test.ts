import { describe, expect, it, vi } from "vitest";

import {
  startDevServer,
  pickDevScript,
  watchForRecovery,
  continueWatchingForReadiness,
  quickReadinessCheck,
  canReuseBackgroundCommand,
} from "@/lib/runtime/runtimeSession";
import type { RuntimeLike } from "@/lib/runtime/runtimeSession";
import type { RuntimeSessionCallbacks } from "@/lib/runtime/runtimeSession";
import type { RuntimeStartupTelemetry } from "@/types/session";

const PKG = JSON.stringify({ name: "app", scripts: { dev: "vite" } });

function fakeCallbacks() {
  const states: Array<{ state: string; extra?: unknown }> = [];
  const previews: Array<{ url: string; port: number }> = [];
  const callbacks: RuntimeSessionCallbacks = {
    onStateChange: (state, extra) => states.push({ state, extra }),
    onPreviewUrl: (url, port) => previews.push({ url, port }),
  };
  return { callbacks, states, previews };
}

function fakeRuntime(overrides: Partial<RuntimeLike> = {}): RuntimeLike {
  return {
    writeFile: vi.fn().mockResolvedValue(undefined),
    deleteFile: vi.fn().mockResolvedValue(undefined),
    runForeground: vi.fn().mockResolvedValue({ exitCode: 0, output: "" }),
    runBackground: vi.fn().mockResolvedValue("cmd-1"),
    getKnownPreviewPorts: vi.fn().mockReturnValue([]),
    waitForPort: vi.fn().mockResolvedValue("https://preview.example/"),
    setPreviewScript: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("pickDevScript", () => {
  it("prefers dev, then start, then preview", () => {
    expect(pickDevScript(["build", "dev", "start"])).toBe("dev");
    expect(pickDevScript(["build", "start"])).toBe("start");
    expect(pickDevScript(["build", "preview"])).toBe("preview");
    expect(pickDevScript(["build", "test"])).toBeNull();
  });
});

describe("startDevServer", () => {
  it("successful boot->install->dev-server->port reaches running with the preview url", async () => {
    const runtime = fakeRuntime({
      getKnownPreviewPorts: vi.fn().mockReturnValue([5173]),
    });
    const { callbacks, states, previews } = fakeCallbacks();

    await startDevServer(runtime, PKG, callbacks);

    expect(states.map((s) => s.state)).toEqual(["installing", "starting", "running"]);
    expect(previews).toEqual([{ url: "https://preview.example/", port: 5173 }]);
    expect(runtime.runForeground).toHaveBeenCalledWith("npm install", { timeoutSeconds: 180 });
    expect(runtime.runBackground).toHaveBeenCalledWith("npm run dev");
    expect(runtime.runForeground).toHaveBeenCalledWith(
      "curl -s -o /dev/null http://localhost:5173/",
      { timeoutSeconds: 10 }
    );
  });

  it("a port that opens but never answers a real request (curl never exits 0) produces a terminal crashed state, not a false \"running\" - this is the exact live-reproduced case: a dev server (Turbopack) that binds a port and crashes moments later", async () => {
    vi.useFakeTimers();
    try {
      const runtime = fakeRuntime({
        getKnownPreviewPorts: vi.fn().mockReturnValue([3000]),
        runForeground: vi.fn().mockImplementation(async (command: string) => {
          if (command === "npm install") return { exitCode: 0, output: "" };
          // Every curl readiness check fails - port opened, then died.
          return { exitCode: 2, output: "curl: connect ECONNREFUSED 127.0.0.1:3000" };
        }),
      });
      const { callbacks, states, previews } = fakeCallbacks();

      const done = startDevServer(runtime, PKG, callbacks);
      await vi.advanceTimersByTimeAsync(61_000); // past the 60s READINESS_TIMEOUT_MS deadline
      await done;

      expect(states.map((s) => s.state)).toEqual(["installing", "starting", "crashed"]);
      const crashed = states[2].extra as { errorMessage: string };
      expect(crashed.errorMessage).toContain("opened port 3000");
      expect(crashed.errorMessage).toContain("never returned a successful response");
      expect(crashed.errorMessage).toContain("ECONNREFUSED");
      expect(previews).toEqual([]); // never exposed to view_preview
      expect(runtime.waitForPort).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a port that answers only after a few failed readiness polls still reaches running (a slow first compile isn't mistaken for a crash)", async () => {
    const runtime = fakeRuntime({
      getKnownPreviewPorts: vi.fn().mockReturnValue([3000]),
      runForeground: vi.fn().mockImplementation(async (command: string) => {
        if (command === "npm install") return { exitCode: 0, output: "" };
        const callsSoFar = (runtime.runForeground as ReturnType<typeof vi.fn>).mock.calls.length;
        // First two curl checks (calls 2 and 3, after the install call) fail; the third succeeds.
        return callsSoFar < 4
          ? { exitCode: 2, output: "curl: connect ECONNREFUSED" }
          : { exitCode: 0, output: "" };
      }),
    });
    const { callbacks, states } = fakeCallbacks();

    await startDevServer(runtime, PKG, callbacks);

    expect(states.map((s) => s.state)).toEqual(["installing", "starting", "running"]);
  });

  it("install failure (nonzero exit) produces a terminal crashed state, not a silent hang", async () => {
    const runtime = fakeRuntime({
      runForeground: vi.fn().mockResolvedValue({ exitCode: 1, output: "npm ERR! something broke" }),
    });
    const { callbacks, states } = fakeCallbacks();

    await startDevServer(runtime, PKG, callbacks);

    expect(states.map((s) => s.state)).toEqual(["installing", "crashed"]);
    const crashed = states[1].extra as { errorMessage: string };
    expect(crashed.errorMessage).toContain("npm install failed (exit 1)");
    expect(crashed.errorMessage).toContain("something broke");
  });

  it("install timeout (runtime reports exitCode -1, matching its own timeout-kill contract) produces a terminal crashed state", async () => {
    const runtime = fakeRuntime({
      runForeground: vi.fn().mockResolvedValue({ exitCode: -1, output: "[killed - exceeded 180s timeout]" }),
    });
    const { callbacks, states } = fakeCallbacks();

    await startDevServer(runtime, PKG, callbacks);

    expect(states.map((s) => s.state)).toEqual(["installing", "crashed"]);
    expect((states[1].extra as { errorMessage: string }).errorMessage).toContain("exit -1");
  });

  it("dev server never opening a port produces a terminal crashed state after the port-wait deadline (not an indefinite hang)", async () => {
    vi.useFakeTimers();
    try {
      const runtime = fakeRuntime({
        getKnownPreviewPorts: vi.fn().mockReturnValue([]), // never opens
      });
      const { callbacks, states } = fakeCallbacks();

      const done = startDevServer(runtime, PKG, callbacks);
      await vi.advanceTimersByTimeAsync(91_000); // past the 90s PORT_WAIT_MS deadline
      await done;

      expect(states.map((s) => s.state)).toEqual(["installing", "starting", "crashed"]);
      expect((states[2].extra as { errorMessage: string }).errorMessage).toContain("didn't open a port within");
    } finally {
      vi.useRealTimers();
    }
  });

  it("missing package.json scripts (no dev/start/preview) fails fast with a clear message, before ever touching install", async () => {
    const runtime = fakeRuntime();
    const { callbacks, states } = fakeCallbacks();

    await startDevServer(runtime, JSON.stringify({ name: "app", scripts: { build: "vite build" } }), callbacks);

    expect(states.map((s) => s.state)).toEqual(["crashed"]);
    expect(runtime.runForeground).not.toHaveBeenCalled();
  });

  it("an externally-set stopped flag halts the pipeline instead of reporting a state for a torn-down session", async () => {
    let stopped = false;
    const runtime = fakeRuntime({
      runForeground: vi.fn().mockImplementation(async () => {
        stopped = true; // simulate RuntimeSession.stop() firing mid-install
        return { exitCode: 0, output: "" };
      }),
    });
    const { callbacks, states } = fakeCallbacks();

    await startDevServer(runtime, PKG, callbacks, () => stopped);

    expect(states.map((s) => s.state)).toEqual(["installing"]); // never reaches "starting"/"running"/"crashed"
    expect(runtime.runBackground).not.toHaveBeenCalled();
  });
});

describe("watchForRecovery", () => {
  it("promotes to running once a new port the caller (e.g. the agent's own run_command) opened starts answering - the live-reproduced case: the one-shot dev-server attempt already crashed, then the agent independently fixed and restarted it outside startDevServer", async () => {
    vi.useFakeTimers();
    try {
      let knownPorts: number[] = []; // nothing open yet when watching begins
      let curlSucceeds = false;
      const runtime = fakeRuntime({
        getKnownPreviewPorts: vi.fn().mockImplementation(() => knownPorts),
        runForeground: vi.fn().mockImplementation(async () => {
          return curlSucceeds
            ? { exitCode: 0, output: "" }
            : { exitCode: 2, output: "curl: connect ECONNREFUSED" };
        }),
        waitForPort: vi.fn().mockResolvedValue("https://recovered.example/"),
      });
      const { callbacks, states, previews } = fakeCallbacks();

      const done = watchForRecovery(runtime, callbacks, () => false);

      // Nothing has opened yet - a few poll ticks should produce no state change.
      await vi.advanceTimersByTimeAsync(2_000);
      expect(states).toEqual([]);

      // The agent's own restarted dev server opens a port and starts answering.
      knownPorts = [4000];
      curlSucceeds = true;
      await vi.advanceTimersByTimeAsync(2_000);
      await done;

      expect(states).toEqual([{ state: "running", extra: { port: 4000 } }]);
      expect(previews).toEqual([{ url: "https://recovered.example/", port: 4000 }]);
      expect(runtime.setPreviewScript).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not promote a port that opened but never answers a real request - a second bad attempt shouldn't produce a false 'running' either", async () => {
    vi.useFakeTimers();
    try {
      const runtime = fakeRuntime({
        getKnownPreviewPorts: vi.fn().mockReturnValue([5000]),
        runForeground: vi.fn().mockResolvedValue({ exitCode: 2, output: "curl: connect ECONNREFUSED" }),
      });
      const { callbacks, states } = fakeCallbacks();
      let stopped = false;

      const done = watchForRecovery(runtime, callbacks, () => stopped);
      await vi.advanceTimersByTimeAsync(400); // one poll tick: sees port 5000, curl fails every time within READINESS_TIMEOUT_MS
      await vi.advanceTimersByTimeAsync(61_000); // exhaust the readiness window for that port
      stopped = true; // stop the otherwise-infinite watch loop for this test
      await vi.advanceTimersByTimeAsync(1_000);
      await done;

      expect(states).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a normal, uncrashed boot never invokes the recovery watch at all - startDevServer's happy path is unaffected", async () => {
    const runtime = fakeRuntime({
      getKnownPreviewPorts: vi.fn().mockReturnValue([5173]),
    });
    const { callbacks, states, previews } = fakeCallbacks();

    await startDevServer(runtime, PKG, callbacks);

    expect(states.map((s) => s.state)).toEqual(["installing", "starting", "running"]);
    expect(previews).toEqual([{ url: "https://preview.example/", port: 5173 }]);
    // startDevServer itself never calls watchForRecovery - that's RuntimeSession's job,
    // gated on the wrapped callback's crashed flag, which the happy path never sets.
  });
});

describe("continueWatchingForReadiness (Phase 41)", () => {
  it("live-reproduced gap: a port that's still 'starting' after quickReadinessCheck gives up eventually promotes to running once curl succeeds - the state doc no longer freezes forever", async () => {
    vi.useFakeTimers();
    try {
      let curlSucceeds = false;
      const runtime = fakeRuntime({
        getKnownPreviewPorts: vi.fn().mockReturnValue([3001]),
        runForeground: vi.fn().mockImplementation(async () => {
          return curlSucceeds
            ? { exitCode: 0, output: "" }
            : { exitCode: 2, output: "curl: connect ECONNREFUSED" };
        }),
        waitForPort: vi.fn().mockResolvedValue("https://preview.example/"),
      });
      const { callbacks, states, previews } = fakeCallbacks();

      const done = continueWatchingForReadiness(runtime, 3001, () => false, callbacks);

      // Same shape as the live case: several polls still see the server not answering yet.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(states).toEqual([]);

      // The cold compile finishes; curl starts succeeding.
      curlSucceeds = true;
      await vi.advanceTimersByTimeAsync(2_000);

      expect(await done).toBe(true);
      expect(states).toEqual([{ state: "running", extra: { port: 3001 } }]);
      expect(previews).toEqual([{ url: "https://preview.example/", port: 3001 }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not promote a stale watch once a newer restart has superseded its port - a late-finishing watch shouldn't overwrite fresher state", async () => {
    vi.useFakeTimers();
    try {
      let knownPorts = [3001];
      const runtime = fakeRuntime({
        getKnownPreviewPorts: vi.fn().mockImplementation(() => knownPorts),
        runForeground: vi.fn().mockResolvedValue({ exitCode: 0, output: "" }),
      });
      const { callbacks, states } = fakeCallbacks();

      const done = continueWatchingForReadiness(runtime, 3001, () => false, callbacks);
      // Before this watch's own curl check resolves, a fresh restart moves the session to a new port.
      knownPorts = [3002];
      await vi.advanceTimersByTimeAsync(1_000);

      expect(await done).toBe(false);
      expect(states).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up after PORT_WAIT_MS if the server never starts answering - bounded, not an indefinite hang", async () => {
    vi.useFakeTimers();
    try {
      const runtime = fakeRuntime({
        getKnownPreviewPorts: vi.fn().mockReturnValue([3001]),
        runForeground: vi.fn().mockResolvedValue({ exitCode: 2, output: "curl: connect ECONNREFUSED" }),
      });
      const { callbacks, states } = fakeCallbacks();

      const done = continueWatchingForReadiness(runtime, 3001, () => false, callbacks);
      await vi.advanceTimersByTimeAsync(91_000); // past PORT_WAIT_MS (90s)

      expect(await done).toBe(false);
      expect(states).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops immediately once isStopped reports true, mid-wait", async () => {
    vi.useFakeTimers();
    try {
      let stopped = false;
      const runtime = fakeRuntime({
        getKnownPreviewPorts: vi.fn().mockReturnValue([3001]),
        runForeground: vi.fn().mockResolvedValue({ exitCode: 2, output: "curl: connect ECONNREFUSED" }),
      });
      const { callbacks, states } = fakeCallbacks();

      const done = continueWatchingForReadiness(runtime, 3001, () => stopped, callbacks);
      await vi.advanceTimersByTimeAsync(2_000);
      stopped = true;
      await vi.advanceTimersByTimeAsync(2_000);

      expect(await done).toBe(false);
      expect(states).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * Phase 17: startupTelemetry is additive to the existing state-machine
 * tests above - same scenarios, checking the NEW timing/outcome data
 * rather than re-asserting the state sequence those tests already cover.
 */
describe("startDevServer - startupTelemetry (Phase 17)", () => {
  it("a successful boot records ready outcome with monotonically increasing phase timestamps", async () => {
    const runtime = fakeRuntime({ getKnownPreviewPorts: vi.fn().mockReturnValue([5173]) });
    const { callbacks, states } = fakeCallbacks();

    await startDevServer(runtime, PKG, callbacks);

    const running = states.find((s) => s.state === "running");
    const telemetry = (running?.extra as { startupTelemetry: RuntimeStartupTelemetry }).startupTelemetry;
    expect(telemetry.startupOutcome).toBe("ready");
    expect(telemetry.devServerStartMs).not.toBeNull();
    expect(telemetry.portDetectedMs).not.toBeNull();
    expect(telemetry.realResponseMs).not.toBeNull();
    expect(telemetry.previewReadyMs).not.toBeNull();
    expect(telemetry.totalStartupMs).toBe(telemetry.previewReadyMs);
    expect(telemetry.devServerStartMs!).toBeLessThanOrEqual(telemetry.portDetectedMs!);
    expect(telemetry.portDetectedMs!).toBeLessThanOrEqual(telemetry.realResponseMs!);
    expect(telemetry.realResponseMs!).toBeLessThanOrEqual(telemetry.previewReadyMs!);
  });

  it("a port that opens then answers ECONNREFUSED records startupOutcome crashed (positive evidence)", async () => {
    vi.useFakeTimers();
    try {
      const runtime = fakeRuntime({
        getKnownPreviewPorts: vi.fn().mockReturnValue([3000]),
        runForeground: vi.fn().mockImplementation(async (command: string) => {
          if (command === "npm install") return { exitCode: 0, output: "" };
          return { exitCode: 2, output: "curl: connect ECONNREFUSED 127.0.0.1:3000" };
        }),
      });
      const { callbacks, states } = fakeCallbacks();

      const done = startDevServer(runtime, PKG, callbacks);
      await vi.advanceTimersByTimeAsync(61_000);
      await done;

      const crashed = states.find((s) => s.state === "crashed");
      const telemetry = (crashed?.extra as { startupTelemetry: RuntimeStartupTelemetry }).startupTelemetry;
      expect(telemetry.startupOutcome).toBe("crashed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a readiness check that never gets a definitive connection error records startupOutcome timeout, while RuntimeState still reports crashed (existing behavior, unchanged)", async () => {
    vi.useFakeTimers();
    try {
      const runtime = fakeRuntime({
        getKnownPreviewPorts: vi.fn().mockReturnValue([3000]),
        runForeground: vi.fn().mockImplementation(async (command: string) => {
          if (command === "npm install") return { exitCode: 0, output: "" };
          // No ECONNREFUSED/ECONNRESET anywhere in this failure - a
          // generic timeout, not positive crash evidence.
          return { exitCode: 28, output: "curl: (28) Operation timed out after 10000 milliseconds" };
        }),
      });
      const { callbacks, states } = fakeCallbacks();

      const done = startDevServer(runtime, PKG, callbacks);
      await vi.advanceTimersByTimeAsync(61_000);
      await done;

      expect(states.map((s) => s.state)).toEqual(["installing", "starting", "crashed"]);
      const crashed = states[2];
      const telemetry = (crashed.extra as { startupTelemetry: RuntimeStartupTelemetry }).startupTelemetry;
      expect(telemetry.startupOutcome).toBe("timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a dev server that never opens a port records startupOutcome timeout", async () => {
    vi.useFakeTimers();
    try {
      const runtime = fakeRuntime({ getKnownPreviewPorts: vi.fn().mockReturnValue([]) });
      const { callbacks, states } = fakeCallbacks();

      const done = startDevServer(runtime, PKG, callbacks);
      await vi.advanceTimersByTimeAsync(91_000);
      await done;

      expect(states.map((s) => s.state)).toEqual(["installing", "starting", "crashed"]);
      const telemetry = (states[2].extra as { startupTelemetry: RuntimeStartupTelemetry }).startupTelemetry;
      expect(telemetry.startupOutcome).toBe("timeout");
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * Phase 17: what the agent's own run_command(background: true) call
 * gets back. Reuses the SAME primitives startDevServer's own tests
 * above exercise (waitForRealResponse via runForeground), just bounded
 * to the much shorter QUICK_*_MS budgets - see quickReadinessCheck's
 * own doc comment for why it never itself reports "crashed".
 */
describe("quickReadinessCheck (Phase 17)", () => {
  it("1. immediate readiness: a new port that answers right away reports ready", async () => {
    const runtime = fakeRuntime({
      getKnownPreviewPorts: vi.fn().mockReturnValue([4000]),
      runForeground: vi.fn().mockResolvedValue({ exitCode: 0, output: "" }),
    });

    const result = await quickReadinessCheck(runtime, [], () => false);

    expect(result).toEqual({ status: "ready", port: 4000, url: "https://preview.example/", retryable: false });
  });

  it("2. slow readiness: a port that opens but doesn't answer within the quick budget reports starting, not crashed", async () => {
    vi.useFakeTimers();
    try {
      const runtime = fakeRuntime({
        getKnownPreviewPorts: vi.fn().mockReturnValue([4000]),
        runForeground: vi.fn().mockResolvedValue({ exitCode: 2, output: "curl: connect ECONNREFUSED" }),
      });

      const done = quickReadinessCheck(runtime, [], () => false);
      await vi.advanceTimersByTimeAsync(16_000); // past QUICK_READINESS_WAIT_MS
      const result = await done;

      expect(result).toEqual({ status: "starting", port: 4000, url: null, retryable: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("3. no port at all within the quick budget reports starting with a null port, not crashed", async () => {
    vi.useFakeTimers();
    try {
      const runtime = fakeRuntime({ getKnownPreviewPorts: vi.fn().mockReturnValue([]) });

      const done = quickReadinessCheck(runtime, [], () => false);
      await vi.advanceTimersByTimeAsync(9_000); // past QUICK_PORT_WAIT_MS
      const result = await done;

      expect(result).toEqual({ status: "starting", port: null, url: null, retryable: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores an already-known (pre-existing) port and only reports a genuinely new one", async () => {
    vi.useFakeTimers();
    try {
      // 3000 was already open BEFORE this restart - never treated as
      // evidence that THIS attempt came up, since it's not new.
      const runtime = fakeRuntime({ getKnownPreviewPorts: vi.fn().mockReturnValue([3000]) });

      const done = quickReadinessCheck(runtime, [3000], () => false);
      await vi.advanceTimersByTimeAsync(9_000);
      const result = await done;

      expect(result).toEqual({ status: "starting", port: null, url: null, retryable: true });
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * Phase 17, scenarios 10-11: reusing an already-healthy background
 * command instead of spawning a duplicate process - the live-reproduced
 * "Port 3000 is in use... using 3001 instead" case from the Phase 16
 * benchmark. Pure decision logic, pulled out of RuntimeSession
 * specifically so it's testable without that class's Firestore/
 * WebContainer scaffolding (see RuntimeSession's own doc comment).
 */
describe("canReuseBackgroundCommand (Phase 17)", () => {
  it("10. reuses the remembered port when the exact same command repeats and the port is still known", () => {
    expect(canReuseBackgroundCommand({ command: "npm run dev", port: 3000 }, "npm run dev", [3000, 9999])).toBe(3000);
  });

  it("11. does not reuse for a genuinely different command - never mistakes an unrelated background command for a duplicate restart", () => {
    expect(canReuseBackgroundCommand({ command: "npm run dev", port: 3000 }, "npm run build", [3000])).toBeNull();
  });

  it("does not reuse once the remembered port is no longer known (it closed/changed) - falls through to a fresh start instead of a stale reuse", () => {
    expect(canReuseBackgroundCommand({ command: "npm run dev", port: 3000 }, "npm run dev", [9999])).toBeNull();
  });

  it("does not reuse when there is no memo yet (first attempt this session)", () => {
    expect(canReuseBackgroundCommand(null, "npm run dev", [3000])).toBeNull();
  });

  it("trims whitespace before comparing, so equivalent commands still match", () => {
    expect(canReuseBackgroundCommand({ command: "npm run dev", port: 3000 }, "  npm run dev  ", [3000])).toBe(3000);
  });
});
