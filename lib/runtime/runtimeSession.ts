import {
  collection,
  getDocs,
  onSnapshot,
  query,
  where,
} from "firebase/firestore";

import { db, subscribeWhenSignedIn } from "@/lib/firebase/client";
import { authedFetch } from "@/lib/firebase/authedFetch";
import { WebContainerRuntime } from "@/lib/runtime/webcontainerRuntime";
import { buildPreviewCaptureScript } from "@/lib/preview/captureScript";

import type {
  BackgroundRunReadiness,
  RuntimeCommand,
  RuntimeStartupTelemetry,
  RuntimeState,
  SessionFile,
} from "@/types/session";

const DEV_SCRIPT_PREFERENCE = ["dev", "start", "preview"];
// Measured live, repeatedly: cold Vite dep pre-bundling for a real project
// (React 19, react-router-dom, lucide-react, Tailwind v4/PostCSS) routinely
// lands in the 60-80s range, not just occasionally over 20s - confirmed
// each time by curling the port directly after the client had already
// given up and found a real HTML response waiting. 90s stays a bounded
// cap (matches the existing 60s boot / 180s install caps) with headroom
// over the slowest observed real run instead of chasing the timeout
// upward one flaky run at a time.
const PORT_WAIT_MS = 90_000;
const PORT_POLL_INTERVAL_MS = 400;
// Confirmed live (2026-08-22): WebContainer's own port-open event fires
// the instant a process binds a port - not when it's able to serve a
// real response. A dev server that crashes moments after binding
// (measured case: Next.js 16's Turbopack failing its own native-binding
// check right after printing "Ready") leaves a dead port behind a
// runtimeHost doc that already says "running", so view_preview lands on
// a corpse and returns a blank screenshot with no error. A bound port
// is not the same claim as "the application is ready" - only an actual
// response is. A plain browser `fetch()` against the preview URL can't
// verify this: confirmed live that WebContainer's own proxy answers
// (even in `no-cors` mode, which can't be read for a status anyway)
// for a bogus/dead port exactly the same as a real one, so "did fetch
// resolve" is not a usable signal from outside the container. Curl run
// *inside* the container via the existing run_command primitive is:
// confirmed live it exits 0 against a live port and a real non-zero
// code (2, ECONNREFUSED here) against a dead one.
const READINESS_TIMEOUT_MS = 60_000;
const READINESS_POLL_INTERVAL_MS = 1_000;

/**
 * Phase 17: bounds for the QUICK check run when the agent itself calls
 * run_command(background: true) - e.g. restarting a dev server after a
 * fix. Deliberately much shorter than PORT_WAIT_MS/READINESS_TIMEOUT_MS
 * above (which cover the one-shot automatic first boot, including a
 * cold `npm install`): by the time the agent is restarting, install is
 * already done, so this only has to cover "does node bind a port and
 * answer," not a full cold-start. Keeps the common fast-restart case
 * fast (section 5's "normal fast startups should remain fast") while
 * still bounded, not indefinite. Must stay comfortably under
 * RUN_COMMAND_BACKGROUND_TIMEOUT_MS (executeTool.ts) plus round-trip
 * overhead for the Firestore command-relay hop.
 */
const QUICK_PORT_WAIT_MS = 8_000;
const QUICK_READINESS_WAIT_MS = 15_000;
/** Reusing an already-healthy port from a repeated identical background command only needs one fresh check, not the full budget above. */
const QUICK_REUSE_CHECK_MS = 5_000;

/**
 * Phase 23: minimum gap between two listener reconnects - not a
 * correctness requirement (reconnectListeners is idempotent even back
 * to back, see its own doc comment), just avoids redundant work when
 * several independent detection sources (visibilitychange, an
 * onSnapshot error, the unhandledrejection watchdog) fire for the same
 * underlying event within a short window.
 */
const RECONNECT_DEBOUNCE_MS = 2_000;

/**
 * Phase 41: live-reproduced (2026-08-26) - runtimeCommands docs
 * confirmed stuck in Firestore forever at status "pending" (queried
 * directly, not inferred: the exact same query subscribeToCommands
 * itself runs returned real, un-processed documents on request, so
 * this isn't a missing-index issue - the query works fine on demand,
 * the *realtime* onSnapshot channel is what occasionally doesn't fire
 * for a freshly-created doc). Every observed case was recovered only
 * because the caller (executeTool.ts) timed out at 130s and the agent
 * blindly retried the identical command - expensive, and not
 * guaranteed if a caller ever used a shorter timeout. This poll is a
 * cheap, standard "trust but verify" fallback for exactly this
 * transport gap: periodically re-run the same pending-commands query
 * as a plain one-shot read, not a listener, so it can't share whatever
 * failure mode silently drops a snapshot callback. processingCommandIds
 * already dedupes against the realtime listener picking up the same
 * doc first - whichever path notices it first wins, the other is a
 * no-op.
 */
const COMMAND_RECONCILE_POLL_MS = 5_000;

/**
 * Phase 23: the exact, real error text this session directly observed
 * live (see reconnectListeners's own doc comment) when a backgrounded
 * tab's IndexedDB connection closed out from under Firestore's SDK.
 * Matched, not guessed - this is the literal string the SDK threw.
 * Deliberately narrow (a real signal, not an invented one) - this
 * catches the one failure class this session has direct evidence of,
 * not a general-purpose error classifier.
 */
const INDEXEDDB_CLOSED_ERROR_PATTERN = /database is closing\/hidden/i;

export function pickDevScript(scripts: string[]): string | null {
  for (const candidate of DEV_SCRIPT_PREFERENCE) {
    if (scripts.includes(candidate)) return candidate;
  }
  return null;
}

export interface RuntimeSessionCallbacks {
  onStateChange: (
    state: RuntimeState,
    extra?: {
      port?: number | null;
      errorMessage?: string | null;
      startupTelemetry?: RuntimeStartupTelemetry;
    }
  ) => void;
  onPreviewUrl: (url: string, port: number) => void;
}

/**
 * The subset of WebContainerRuntime's surface the install/dev-server/
 * port pipeline actually calls - lets tests substitute a fake runtime
 * without a real WebContainer (which needs a cross-origin-isolated
 * browser document and can't run in a unit test), matching how
 * apostle's own SandboxProvider abstraction was tested.
 */
export interface RuntimeLike {
  writeFile(path: string, content: string, encoding?: "utf8" | "base64"): Promise<void>;
  deleteFile(path: string): Promise<void>;
  runForeground(command: string, opts?: { cwd?: string; timeoutSeconds?: number }): Promise<{ exitCode: number; output: string }>;
  runBackground(command: string, opts?: { cwd?: string }): Promise<string>;
  getKnownPreviewPorts(): number[];
  waitForPort(port: number): Promise<string>;
  setPreviewScript(scriptSrc: string): Promise<void>;
}

async function waitForAnyPort(
  runtime: RuntimeLike,
  isStopped: () => boolean,
  timeoutMs: number = PORT_WAIT_MS
): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isStopped()) return null;
    const ports = runtime.getKnownPreviewPorts();
    if (ports.length > 0) return ports[0];
    await new Promise((resolve) => setTimeout(resolve, PORT_POLL_INTERVAL_MS));
  }
  return null;
}

/**
 * Same shape as waitForAnyPort, but only reports a port not already in
 * `before` - used by the agent-initiated quick check (quickReadinessCheck)
 * so a restart doesn't mistake an already-known (possibly stale) port
 * for evidence the new attempt itself came up.
 */
async function waitForNewPort(
  runtime: RuntimeLike,
  before: number[],
  isStopped: () => boolean,
  timeoutMs: number
): Promise<number | null> {
  const beforeSet = new Set(before);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isStopped()) return null;
    const fresh = runtime.getKnownPreviewPorts().find((p) => !beforeSet.has(p));
    if (fresh !== undefined) return fresh;
    await new Promise((resolve) => setTimeout(resolve, PORT_POLL_INTERVAL_MS));
  }
  return null;
}

/**
 * "The port opened" and "the app is actually answering requests" are
 * different claims - see the READINESS_TIMEOUT_MS doc comment above
 * for the live-reproduced case this exists to catch. Polls with curl
 * run inside the container rather than a fixed sleep, since a) this
 * shell has no `sleep` and b) a dev server that's merely slow on its
 * first compile should still succeed instead of racing an arbitrary
 * delay.
 */
async function waitForRealResponse(
  runtime: RuntimeLike,
  port: number,
  isStopped: () => boolean,
  timeoutMs: number = READINESS_TIMEOUT_MS
): Promise<{ ok: true } | { ok: false; lastError: string }> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no response within the timeout";
  while (Date.now() < deadline) {
    if (isStopped()) return { ok: false, lastError: "stopped" };
    try {
      const result = await runtime.runForeground(`curl -s -o /dev/null http://localhost:${port}/`, {
        timeoutSeconds: 10,
      });
      if (result.exitCode === 0) return { ok: true };
      lastError = `curl exited ${result.exitCode}: ${result.output.slice(-200)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, READINESS_POLL_INTERVAL_MS));
  }
  return { ok: false, lastError };
}

/** What RuntimeSession remembers about the last background command it confirmed ready - see canReuseBackgroundCommand. */
export interface BackgroundCommandMemo {
  command: string;
  port: number;
}

/**
 * Phase 17: pure reuse decision, pulled out of RuntimeSession (which
 * isn't unit-testable directly - see this file's own RuntimeLike doc
 * comment) so the "don't spawn a duplicate dev server" logic itself is
 * testable without Firestore/WebContainer scaffolding. Live-reproduced
 * failure this targets: the Phase 16 benchmark's agent restarting "npm
 * run dev" while a healthy instance was already running, landing on
 * "Port 3000 is in use... using 3001 instead." Only reuses when the
 * EXACT same command string repeats and its remembered port is still
 * one WebContainer knows about - never guesses across different
 * commands, and never kills anything (the caller still has to confirm
 * the port is actually still healthy before trusting this).
 */
export function canReuseBackgroundCommand(
  memo: BackgroundCommandMemo | null,
  command: string,
  knownPorts: number[]
): number | null {
  if (!memo) return null;
  if (memo.command !== command.trim()) return null;
  return knownPorts.includes(memo.port) ? memo.port : null;
}

/**
 * Phase 17: what the agent's own run_command(background: true) call
 * gets back, instead of the old unconditional "Started in the
 * background." with zero readiness signal. Reuses the exact same
 * primitives startDevServer already relies on (waitForNewPort/
 * waitForRealResponse) with a much shorter bound (see QUICK_*_MS's own
 * doc comment) - not a second, competing readiness implementation.
 *
 * Deliberately never returns "crashed" itself: within this short a
 * window, "no port yet" and "port not answering yet" both lack the
 * positive evidence (a real ECONNREFUSED, or the full budget genuinely
 * exhausted) that startDevServer's own crash detection requires -
 * jumping to "crashed" here would produce false negatives on a merely
 * slow install/compile. "starting" + retryable is the honest answer;
 * genuine crash detection stays owned by startDevServer/watchForRecovery.
 */
export async function quickReadinessCheck(
  runtime: RuntimeLike,
  portsBefore: number[],
  isStopped: () => boolean
): Promise<BackgroundRunReadiness> {
  const port = await waitForNewPort(runtime, portsBefore, isStopped, QUICK_PORT_WAIT_MS);
  if (port === null) {
    return { status: "starting", port: null, url: null, retryable: true };
  }

  const readiness = await waitForRealResponse(runtime, port, isStopped, QUICK_READINESS_WAIT_MS);
  if (!readiness.ok) {
    return { status: "starting", port, url: null, retryable: true };
  }

  const url = await runtime.waitForPort(port);
  return { status: "ready", port, url, retryable: false };
}

/**
 * The install -> dev-server-start -> port-detection pipeline, pulled
 * out of RuntimeSession so it's testable against a fake RuntimeLike
 * with no Firestore/WebContainer involved. Every phase here already
 * had a bounded timeout before this extraction (boot: 60s in
 * WebContainerRuntime.boot; install: 180s; port-wait: 90s) - the
 * extraction doesn't change any of that, it only makes the existing
 * bounded behavior verifiable in a test.
 */
export async function startDevServer(
  runtime: RuntimeLike,
  pkgRaw: string,
  callbacks: RuntimeSessionCallbacks,
  isStopped: () => boolean = () => false
): Promise<void> {
  const pipelineStartedAt = Date.now();
  const telemetry: RuntimeStartupTelemetry = {
    devServerStartMs: null,
    portDetectedMs: null,
    realResponseMs: null,
    previewReadyMs: null,
    totalStartupMs: null,
    startupOutcome: null,
  };

  let scripts: string[];
  try {
    scripts = Object.keys(JSON.parse(pkgRaw).scripts ?? {});
  } catch {
    callbacks.onStateChange("crashed", { errorMessage: "package.json isn't valid JSON." });
    return;
  }

  const devScript = pickDevScript(scripts);
  if (!devScript) {
    callbacks.onStateChange("crashed", {
      errorMessage: `No dev/start/preview script found in package.json (has: ${scripts.join(", ") || "none"}).`,
    });
    return;
  }

  callbacks.onStateChange("installing");
  const install = await runtime.runForeground("npm install", { timeoutSeconds: 180 });
  if (isStopped()) return;
  if (install.exitCode !== 0) {
    telemetry.startupOutcome = install.exitCode === -1 ? "timeout" : "crashed";
    telemetry.totalStartupMs = Date.now() - pipelineStartedAt;
    callbacks.onStateChange("crashed", {
      errorMessage: `npm install failed (exit ${install.exitCode}): ${install.output.slice(-500)}`,
      startupTelemetry: telemetry,
    });
    return;
  }
  telemetry.devServerStartMs = Date.now() - pipelineStartedAt;

  callbacks.onStateChange("starting");
  await runtime.runBackground(`npm run ${devScript}`);

  const port = await waitForAnyPort(runtime, isStopped);
  if (isStopped()) return;
  if (port === null) {
    telemetry.startupOutcome = "timeout";
    telemetry.totalStartupMs = Date.now() - pipelineStartedAt;
    callbacks.onStateChange("crashed", {
      errorMessage: `"npm run ${devScript}" didn't open a port within ${PORT_WAIT_MS / 1000}s.`,
      startupTelemetry: telemetry,
    });
    return;
  }
  telemetry.portDetectedMs = Date.now() - pipelineStartedAt;

  try {
    await runtime.setPreviewScript(buildPreviewCaptureScript());
  } catch (error) {
    console.error("Huddle runtime: setPreviewScript failed, view_preview will be unavailable:", error);
  }

  const readiness = await waitForRealResponse(runtime, port, isStopped);
  if (isStopped()) return;
  if (!readiness.ok) {
    // A curl that actually connected and got refused/reset is positive
    // crash evidence (something bound the port then died); silence
    // with no such evidence at all is closer to "gave up waiting."
    // Either way RuntimeState stays "crashed" (unchanged, existing
    // tests depend on this exact string) - only the telemetry's own
    // startupOutcome distinguishes the two for reporting purposes.
    telemetry.startupOutcome = /ECONNREFUSED|ECONNRESET/.test(readiness.lastError) ? "crashed" : "timeout";
    telemetry.totalStartupMs = Date.now() - pipelineStartedAt;
    callbacks.onStateChange("crashed", {
      errorMessage: `"npm run ${devScript}" opened port ${port} but never returned a successful response within ${READINESS_TIMEOUT_MS / 1000}s (${readiness.lastError}). It likely started and then crashed.`,
      startupTelemetry: telemetry,
    });
    return;
  }
  telemetry.realResponseMs = Date.now() - pipelineStartedAt;

  const url = await runtime.waitForPort(port);
  telemetry.previewReadyMs = Date.now() - pipelineStartedAt;
  telemetry.totalStartupMs = telemetry.previewReadyMs;
  telemetry.startupOutcome = "ready";
  callbacks.onPreviewUrl(url, port);
  callbacks.onStateChange("running", { port, startupTelemetry: telemetry });
}

/**
 * Live-reproduced gap (2026-08-22, Task 13 benchmark): startDevServer
 * above only ever runs once per session (installStarted latches it in
 * RuntimeSession). If that one attempt lands on "crashed" - measured
 * case: package.json arrived before the rest of the project, so the
 * automatic first "npm run dev" had nothing to serve and timed out -
 * the agent can still fix the real problem and restart the dev server
 * itself via its own run_command tool call. That call goes through the
 * runtimeCommands bridge, not through this file, so nothing was ever
 * watching for it to succeed: runtimeHost.state stayed "crashed"
 * forever, and view_preview (gated on state === "running") refused to
 * even attempt a capture - confirmed live, the agent read back correct
 * HTML via its own curl-equivalent run_command call and then hit
 * exactly this wall trying to view_preview. WebContainerRuntime's
 * "server-ready"/"port" listeners are already persistent for the life
 * of the container (see webcontainerRuntime.ts), so a later port the
 * agent opens is already visible via getKnownPreviewPorts() - this
 * just needs to notice it and apply the same real-response check
 * startDevServer already does, rather than trusting the raw port event
 * (see READINESS_TIMEOUT_MS's doc comment for why that check exists).
 */
export async function watchForRecovery(
  runtime: RuntimeLike,
  callbacks: RuntimeSessionCallbacks,
  isStopped: () => boolean
): Promise<void> {
  const seenPorts = new Set(runtime.getKnownPreviewPorts());

  while (!isStopped()) {
    await new Promise((resolve) => setTimeout(resolve, PORT_POLL_INTERVAL_MS));
    if (isStopped()) return;

    const newPorts = runtime.getKnownPreviewPorts().filter((p) => !seenPorts.has(p));
    for (const port of newPorts) {
      seenPorts.add(port);

      const readiness = await waitForRealResponse(runtime, port, isStopped);
      if (isStopped()) return;
      if (!readiness.ok) continue;

      try {
        await runtime.setPreviewScript(buildPreviewCaptureScript());
      } catch (error) {
        console.error(
          "Huddle runtime: setPreviewScript failed during recovery, view_preview will be unavailable:",
          error
        );
      }

      const url = await runtime.waitForPort(port);
      callbacks.onPreviewUrl(url, port);
      callbacks.onStateChange("running", { port });
      return;
    }
  }
}

/**
 * Phase 41: closes a gap distinct from watchForRecovery above -
 * quickReadinessCheck's own budget (QUICK_PORT_WAIT_MS +
 * QUICK_READINESS_WAIT_MS, ~23s) is deliberately short, on the
 * assumption an agent-initiated restart is fast because install is
 * already done (see its own doc comment) - but the FIRST "npm run dev"
 * after a build is not that case, and a genuinely cold Tailwind v4/
 * Next.js compile can still take the same 60-90s PORT_WAIT_MS already
 * budgets for the automatic boot path. Without this, nothing ever
 * calls onStateChange again once the quick check gives up:
 * runtimeHost freezes at "starting" forever, even after the server is
 * demonstrably answering - live-reproduced (2026-08-26): curl got real
 * HTML back from the port twice while view_preview kept reading the
 * same stale "starting" state for 50s at a time, until the agent
 * worked around it by restarting onto a new port. Called
 * fire-and-forget from runBackgroundWithReadiness's own "starting"
 * branch - it doesn't block that call's response, which already
 * correctly reported "starting"; this only keeps the state doc honest
 * afterward, the same "fix the state/transition itself" shape as
 * watchForRecovery. Returns whether it actually promoted to running,
 * so the caller can update its own lastReadyBackgroundCommand memo.
 */
export async function continueWatchingForReadiness(
  runtime: RuntimeLike,
  port: number,
  isStopped: () => boolean,
  callbacks: RuntimeSessionCallbacks
): Promise<boolean> {
  const readiness = await waitForRealResponse(runtime, port, isStopped, PORT_WAIT_MS);
  if (isStopped() || !readiness.ok) return false;
  // A newer command may have already superseded this one (another
  // restart, or the session moved on) - only report readiness for the
  // port this watch was started for; a stale watch finishing late
  // should not overwrite fresher state.
  if (!runtime.getKnownPreviewPorts().includes(port)) return false;
  const url = await runtime.waitForPort(port);
  callbacks.onPreviewUrl(url, port);
  callbacks.onStateChange("running", { port });
  return true;
}

/**
 * Client-side orchestrator, one instance per host tab. Implements the
 * approved adjustment: runtime boot and agent BUILD proceed
 * concurrently - boot and the sessionFiles subscription start in the
 * same tick, neither waits on the other. Files that arrive before boot
 * finishes are buffered and flushed the moment it resolves; files that
 * arrive after boot are written straight into the container. Either
 * order converges on the same state: once a package.json is known AND
 * the container is booted, install/start fires exactly once.
 *
 * subscribeToFiles/subscribeToCommands go through subscribeWhenSignedIn
 * rather than a bare onSnapshot - confirmed live on a genuinely fresh
 * browser (no cached auth) that without this, both listeners fire
 * before anonymous sign-in resolves and get permission-denied forever,
 * so package.json never arrives and the session sits in "starting"
 * indefinitely with no error. boot() itself isn't gated - it doesn't
 * touch Firestore - so it still proceeds concurrently as designed.
 */
export class RuntimeSession {
  private runtime: WebContainerRuntime;
  private stopped = false;
  private booted = false;
  private installStarted = false;
  private knownFiles = new Map<string, { content: string; encoding?: "utf8" | "base64" }>();
  private unsubscribeFiles: (() => void) | null = null;
  private unsubscribeCommands: (() => void) | null = null;
  private processingCommandIds = new Set<string>();
  private callbacks: RuntimeSessionCallbacks | null = null;
  /** Phase 41: fallback poll for missed onSnapshot deliveries - see COMMAND_RECONCILE_POLL_MS's own doc comment. Started in subscribeToCommands, cleared in stop(). */
  private commandReconcileTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Phase 17: the last background command this session confirmed ready,
   * and the port it landed on - lets a repeated identical restart (the
   * agent retrying "npm run dev" after a fix, or just re-issuing the
   * same command) recognize an already-healthy server instead of
   * spawning a second competing process (see the live-reproduced "Port
   * 3000 is in use... using 3001 instead" case from the Phase 16
   * benchmark). Session-scoped by construction - one RuntimeSession per
   * host tab per session - so this never reaches across sessions.
   */
  private lastReadyBackgroundCommand: { command: string; port: number } | null = null;
  /** Phase 23: debounce timestamp for reconnectListeners - see RECONNECT_DEBOUNCE_MS's own doc comment. */
  private lastReconnectAt: number | null = null;
  /** Phase 23: registered in start(), removed in stop() - see start()'s own doc comment for what this watches for. */
  private unhandledRejectionHandler: ((event: PromiseRejectionEvent) => void) | null = null;

  constructor(runtime: WebContainerRuntime = new WebContainerRuntime()) {
    this.runtime = runtime;
  }

  async start(sessionId: string, callbacks: RuntimeSessionCallbacks): Promise<void> {
    this.callbacks = callbacks;
    callbacks.onStateChange("starting");

    // Phase 23: detects listener death even while the tab stays
    // visible (Phase 22's visibilitychange handler alone can't - see
    // reconnectListeners's own doc comment for why the IndexedDB
    // closure this catches isn't actually visibility-specific, even
    // though this session's own reproduction happened to occur while
    // backgrounded). A real, observed error text, not an invented
    // signal - see INDEXEDDB_CLOSED_ERROR_PATTERN's own doc comment.
    this.unhandledRejectionHandler = (event: PromiseRejectionEvent) => {
      const message = event.reason instanceof Error ? event.reason.message : String(event.reason);
      if (INDEXEDDB_CLOSED_ERROR_PATTERN.test(message)) {
        this.reconnectListeners(sessionId, callbacks, "unhandledrejection:indexeddb-closed");
      }
    };
    window.addEventListener("unhandledrejection", this.unhandledRejectionHandler);

    const bootPromise = this.runtime
      .boot((message) => {
        // See WebContainerRuntime.boot's own doc comment for why this
        // is report-only, not recover-and-continue.
        if (this.stopped) return;
        console.error("[Huddle] WebContainer internal error", { sessionId, message });
        callbacks.onStateChange("crashed", {
          errorMessage: `The WebContainer runtime reported an internal error: ${message}. Recovery from a WebContainer-engine-level failure isn't currently supported - reload the page to start a fresh session.`,
        });
      })
      .then(() => {
        this.booted = true;
      });

    this.subscribeToFiles(sessionId, callbacks);
    this.subscribeToCommands(sessionId);

    try {
      await bootPromise;
    } catch (error) {
      if (this.stopped) return;
      callbacks.onStateChange("crashed", {
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    if (this.stopped) return;

    // Flush whatever files arrived while booting was in flight.
    for (const [path, file] of this.knownFiles) {
      await this.runtime.writeFile(path, file.content, file.encoding);
    }

    await this.maybeStartDevServer(sessionId, callbacks);
  }

  private subscribeToFiles(
    sessionId: string,
    callbacks: RuntimeSessionCallbacks
  ): void {
    this.unsubscribeFiles = subscribeWhenSignedIn(() => {
      const q = query(
        collection(db, "sessionFiles"),
        where("sessionId", "==", sessionId)
      );

      return onSnapshot(
        q,
        (snapshot) => {
          for (const change of snapshot.docChanges()) {
            const file = change.doc.data() as SessionFile;

            if (change.type === "removed") {
              this.knownFiles.delete(file.path);
              if (this.booted) void this.runtime.deleteFile(file.path);
              continue;
            }

            this.knownFiles.set(file.path, { content: file.content, encoding: file.encoding });
            if (this.booted) void this.runtime.writeFile(file.path, file.content, file.encoding);
          }

          if (this.booted) void this.maybeStartDevServer(sessionId, callbacks);
        },
        // Phase 23: the SDK's own standard error channel - previously
        // unwired, so a real listener-level error (permission changes,
        // a reported network failure, etc.) was silently swallowed
        // instead of triggering recovery.
        () => this.reconnectListeners(sessionId, callbacks, "files-listener-error")
      );
    });
  }

  private async maybeStartDevServer(
    sessionId: string,
    callbacks: RuntimeSessionCallbacks
  ): Promise<void> {
    if (this.installStarted || this.stopped) return;
    const pkgFile = this.knownFiles.get("package.json");
    if (!pkgFile) return;
    const pkgRaw = pkgFile.content;

    this.installStarted = true;

    let crashed = false;
    const wrapped: RuntimeSessionCallbacks = {
      onPreviewUrl: callbacks.onPreviewUrl,
      onStateChange: (state, extra) => {
        crashed = state === "crashed";
        callbacks.onStateChange(state, extra);
      },
    };
    await startDevServer(this.runtime, pkgRaw, wrapped, () => this.stopped);

    // The one-shot attempt above never retries itself (see
    // watchForRecovery's doc comment) - if it ended crashed, keep
    // watching for a port the agent opens on its own later.
    if (crashed && !this.stopped) {
      void watchForRecovery(this.runtime, callbacks, () => this.stopped);
    }
  }

  /**
   * The browser-side half of the server<->runtime bridge (see
   * lib/runtime/commandRelay.ts's doc comment for the full mechanism).
   * Only the elected host tab runs this - it's the only one with a
   * live WebContainer to execute against.
   */
  private subscribeToCommands(sessionId: string): void {
    // Idempotent - reconnectListeners calls this again on top of an
    // already-running poll (a real, observed path, not hypothetical),
    // which would otherwise stack a second concurrent interval doing
    // duplicate reads forever.
    if (this.commandReconcileTimer) {
      clearInterval(this.commandReconcileTimer);
      this.commandReconcileTimer = null;
    }

    this.unsubscribeCommands = subscribeWhenSignedIn(() => {
      const q = query(
        collection(db, "runtimeCommands"),
        where("sessionId", "==", sessionId),
        where("status", "==", "pending")
      );

      return onSnapshot(
        q,
        (snapshot) => {
          for (const change of snapshot.docChanges()) {
            if (change.type === "removed") continue;
            const command = change.doc.data() as RuntimeCommand;
            if (this.processingCommandIds.has(command.id)) continue;
            this.processingCommandIds.add(command.id);
            void this.executeCommand(command);
          }
        },
        // Phase 23: same standard error channel as subscribeToFiles -
        // this.callbacks is guaranteed set by the time this listener is
        // live (start() sets it synchronously before either subscribe
        // call runs).
        () => {
          if (this.callbacks) this.reconnectListeners(sessionId, this.callbacks, "commands-listener-error");
        }
      );
    });

    // Phase 41: see COMMAND_RECONCILE_POLL_MS's own doc comment - a
    // plain one-shot read run on a timer, independent of the realtime
    // listener above, so it can't share whatever transport issue
    // occasionally drops a snapshot callback for a freshly-created doc.
    this.commandReconcileTimer = setInterval(() => {
      void this.pollForMissedCommands(sessionId);
    }, COMMAND_RECONCILE_POLL_MS);
  }

  private async pollForMissedCommands(sessionId: string): Promise<void> {
    if (this.stopped) return;
    const q = query(
      collection(db, "runtimeCommands"),
      where("sessionId", "==", sessionId),
      where("status", "==", "pending")
    );
    let snapshot;
    try {
      snapshot = await getDocs(q);
    } catch {
      // Same-shaped failure as any other Firestore read going stale -
      // the next tick tries again; no need for its own recovery path.
      return;
    }
    if (this.stopped) return;
    for (const doc of snapshot.docs) {
      const command = doc.data() as RuntimeCommand;
      if (this.processingCommandIds.has(command.id)) continue;
      this.processingCommandIds.add(command.id);
      void this.executeCommand(command);
    }
  }

  /**
   * Phase 17: what used to be a two-line "spawn, report started" in
   * executeCommand's background branch - see quickReadinessCheck's own
   * doc comment for why the wait exists and stays bounded/short. Also
   * where the agent-initiated equivalent of startDevServer's own
   * onStateChange("running") reporting happens, since this path is the
   * OTHER place (besides the one-shot automatic boot) a port can come
   * up - see lastReadyBackgroundCommand's doc comment for the reuse
   * check that runs first.
   */
  private async runBackgroundWithReadiness(
    commandId: string,
    command: string,
    cwd?: string
  ): Promise<void> {
    const normalized = command.trim();
    const reusablePort = canReuseBackgroundCommand(
      this.lastReadyBackgroundCommand,
      normalized,
      this.runtime.getKnownPreviewPorts()
    );

    if (reusablePort !== null) {
      const port = reusablePort;
      const stillHealthy = await waitForRealResponse(this.runtime, port, () => this.stopped, QUICK_REUSE_CHECK_MS);
      if (stillHealthy.ok) {
        const url = await this.runtime.waitForPort(port);
        const readiness: BackgroundRunReadiness = { status: "ready", port, url, retryable: false };
        await this.reportCommandResult(commandId, "done", readiness);
        return;
      }
      // No longer healthy - fall through and start fresh below.
      this.lastReadyBackgroundCommand = null;
    }

    const portsBefore = this.runtime.getKnownPreviewPorts();
    await this.runtime.runBackground(command, { cwd });
    const readiness = await quickReadinessCheck(this.runtime, portsBefore, () => this.stopped);

    if (readiness.status === "ready" && readiness.port !== null && readiness.url !== null) {
      this.lastReadyBackgroundCommand = { command: normalized, port: readiness.port };
      this.callbacks?.onPreviewUrl(readiness.url, readiness.port);
      this.callbacks?.onStateChange("running", { port: readiness.port });
    } else if (readiness.port !== null) {
      // Real, positive progress (a port is open) even though it isn't
      // answering yet - worth surfacing so view_preview's own bounded
      // wait (Phase 17) has an accurate signal to poll instead of
      // whatever stale state preceded this restart.
      this.callbacks?.onStateChange("starting", { port: readiness.port });
      // Phase 41: keep the state doc honest past the quick check's own
      // short budget - see continueWatchingForReadiness's own doc
      // comment for the live-reproduced gap this closes. Fire-and-
      // forget: doesn't block this call's own response.
      if (this.callbacks) {
        void continueWatchingForReadiness(this.runtime, readiness.port, () => this.stopped, this.callbacks).then(
          (result) => {
            if (result) this.lastReadyBackgroundCommand = { command: normalized, port: readiness.port as number };
          }
        );
      }
    }

    await this.reportCommandResult(commandId, "done", readiness);
  }

  private async executeCommand(command: RuntimeCommand): Promise<void> {
    try {
      if (command.kind === "run_command") {
        const payload = command.payload as { command: string; cwd?: string; background?: boolean };
        if (payload.background) {
          await this.runBackgroundWithReadiness(command.id, payload.command, payload.cwd);
          // Reporting happens inside runBackgroundWithReadiness (it
          // needs to report BackgroundRunReadiness either way - reuse
          // short-circuits before spawning at all).
        } else {
          const result = await this.runtime.runForeground(payload.command, { cwd: payload.cwd, timeoutSeconds: 120 });
          await this.reportCommandResult(command.id, "done", result);
        }
      } else {
        const payload = command.payload as { viewport?: { width: number; height: number } };
        const result = await this.runtime.capturePreview(payload.viewport);
        await this.reportCommandResult(command.id, "done", result);
      }
    } catch (error) {
      await this.reportCommandResult(
        command.id,
        "error",
        undefined,
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      this.processingCommandIds.delete(command.id);
    }
  }

  private async reportCommandResult(
    commandId: string,
    status: "started" | "done" | "error",
    result?: unknown,
    errorMessage?: string
  ): Promise<void> {
    // Root cause (2026-08-20): this used plain fetch(), so no Firebase
    // ID token was attached and every call 401'd against
    // getVerifiedUid() in the /complete route - confirmed live, 3/3
    // real run_command completions rejected, leaving their
    // runtimeCommands docs stuck "pending" forever and the whole
    // install/dev-server pipeline stalled behind them. Every other
    // authenticated call in this codebase (e.g. useRuntimeHost.ts's own
    // report()) already goes through authedFetch - this call was simply
    // missed when the bridge was built.
    await authedFetch(`/api/runtime-commands/${commandId}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status, result, errorMessage }),
    });
  }

  /**
   * Phase 22/23: re-establishes the Firestore listeners this session
   * depends on, WITHOUT touching the WebContainer itself. Root cause
   * this recovers from - confirmed live this session (see the dev
   * server's own console log: "Uncaught Error: Database is
   * closing/hidden"): the modern Firestore Web SDK uses IndexedDB
   * internally for cross-tab coordination even when the app never
   * opts into offline persistence, and a browser closing that
   * connection (confirmed live while backgrounded, but nothing about
   * the mechanism is visibility-specific - see the unhandledrejection
   * listener in start() for the non-visibility trigger) silently kills
   * onSnapshot listeners with no error routed to them. heartbeat (a
   * plain authedFetch, not listener-based) keeps succeeding the whole
   * time, so the server has no way to know the browser side stopped
   * actually receiving file writes / runtimeCommands - every
   * subsequent run_command call just times out.
   *
   * Idempotent by construction, including against rapid repeat calls:
   * JS's single-threaded execution means two calls can never truly
   * interleave mid-body, and subscribeWhenSignedIn's own cancellation
   * flag (see lib/firebase/client.ts) means a call superseded before
   * its async subscribe() ever attaches is a clean no-op, not a leaked
   * listener - traced through, not assumed. The debounce below exists
   * for a different reason: avoiding WASTEFUL repeat reconnects when
   * multiple detection sources (visibilitychange, listener error,
   * unhandledrejection) fire within the same short window for the same
   * underlying event, not for correctness.
   */
  reconnectListeners(sessionId: string, callbacks: RuntimeSessionCallbacks, reason: string): void {
    if (this.stopped) return;
    const now = Date.now();
    if (this.lastReconnectAt !== null && now - this.lastReconnectAt < RECONNECT_DEBOUNCE_MS) return;
    this.lastReconnectAt = now;
    console.log("[Huddle] reconnecting runtime listeners", { sessionId, reason });
    this.unsubscribeFiles?.();
    this.unsubscribeCommands?.();
    this.subscribeToFiles(sessionId, callbacks);
    this.subscribeToCommands(sessionId);
  }

  stop(): void {
    this.stopped = true;
    if (this.unhandledRejectionHandler) {
      window.removeEventListener("unhandledrejection", this.unhandledRejectionHandler);
      this.unhandledRejectionHandler = null;
    }
    if (this.commandReconcileTimer) {
      clearInterval(this.commandReconcileTimer);
      this.commandReconcileTimer = null;
    }
    this.unsubscribeFiles?.();
    this.unsubscribeCommands?.();
    this.runtime.teardown();
  }
}
