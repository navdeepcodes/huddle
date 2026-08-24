import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Phase 22 regression guard for the visibility-triggered listener
 * reconnection fix.
 *
 * Root cause, confirmed live this session (see the dev server's own
 * console log at the time: "Uncaught Error: Database is
 * closing/hidden"): Chrome can close a backgrounded tab's IndexedDB
 * connection, silently killing Firestore's onSnapshot listeners with no
 * error the app itself ever sees. heartbeat (a plain authedFetch, not
 * listener-based) keeps succeeding the whole time, so the server has no
 * signal that the browser side stopped actually receiving file writes /
 * runtimeCommands - every subsequent run_command call from that point
 * on just times out, and the only fix that actually worked live was a
 * full page reload.
 *
 * Same discipline as runtimeCommandAuth.test.ts: RuntimeSession
 * subscribes to live Firestore client-SDK snapshots (onSnapshot), and
 * useRuntimeHost is a React hook wired to document.visibilitychange -
 * neither is mockable with this suite's existing (Admin-SDK-only)
 * fakes without building new Firestore-client-SDK and React-hook
 * testing infrastructure, which is disproportionate to this fix. A
 * static source guard is the narrowest-appropriate-level test here.
 */
describe("RuntimeSession.reconnectListeners (Phase 22)", () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "..", "lib", "runtime", "runtimeSession.ts"),
    "utf8"
  );

  it("exists as a public method taking a reason (Phase 23 signature)", () => {
    expect(source).toMatch(
      /reconnectListeners\(sessionId: string, callbacks: RuntimeSessionCallbacks, reason: string\): void/
    );
  });

  it("unsubscribes both existing listeners before resubscribing, not just adding new ones on top", () => {
    const match = source.match(
      /reconnectListeners\(sessionId: string, callbacks: RuntimeSessionCallbacks, reason: string\): void \{[\s\S]*?\n {2}\}/
    );
    expect(match, "reconnectListeners method not found").not.toBeNull();
    const body = match![0];

    expect(body).toMatch(/this\.unsubscribeFiles\?\.\(\)/);
    expect(body).toMatch(/this\.unsubscribeCommands\?\.\(\)/);
    expect(body).toMatch(/this\.subscribeToFiles\(sessionId, callbacks\)/);
    expect(body).toMatch(/this\.subscribeToCommands\(sessionId\)/);

    // Unsubscribe must come before resubscribe in source order - a
    // reversed order would drop the fresh subscription's own unsubscribe
    // reference right after creating it.
    const unsubIndex = body.indexOf("this.unsubscribeFiles?.()");
    const resubIndex = body.indexOf("this.subscribeToFiles(sessionId, callbacks)");
    expect(unsubIndex).toBeGreaterThanOrEqual(0);
    expect(resubIndex).toBeGreaterThan(unsubIndex);
  });

  it("is a no-op once the session has already been stopped, not a silent reconnect-after-teardown", () => {
    const match = source.match(
      /reconnectListeners\(sessionId: string, callbacks: RuntimeSessionCallbacks, reason: string\): void \{[\s\S]*?\n {2}\}/
    );
    const body = match![0];
    expect(body).toMatch(/if \(this\.stopped\) return;/);
  });
});

describe("useRuntimeHost - visibility-triggered recovery (Phase 22)", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "..", "hooks", "useRuntimeHost.ts"), "utf8");

  it("registers a visibilitychange listener", () => {
    expect(source).toMatch(/document\.addEventListener\("visibilitychange", handleVisibilityChange\)/);
  });

  it("cleans up the listener on unmount, so repeated session mounts don't accumulate handlers", () => {
    expect(source).toMatch(/document\.removeEventListener\("visibilitychange", handleVisibilityChange\)/);
  });

  it("only reacts when the tab is actually visible again, not on every visibility event (e.g. becoming hidden)", () => {
    const match = source.match(/function handleVisibilityChange\(\)[\s\S]*?\n {4}\}/);
    expect(match, "handleVisibilityChange not found").not.toBeNull();
    expect(match![0]).toMatch(/document\.visibilityState !== "visible"/);
  });

  it("calls reconnectListeners and re-heartbeats immediately, rather than waiting for the next interval tick", () => {
    const match = source.match(/function handleVisibilityChange\(\)[\s\S]*?\n {4}\}/);
    const body = match![0];
    expect(body).toMatch(/session\?\.reconnectListeners\(sessionId, callbacks, "visibilitychange"\)/);
    expect(body).toMatch(/authedFetch\(`\/api\/sessions\/\$\{sessionId\}\/runtime-host\/heartbeat`/);
  });
});

/**
 * Phase 23: detects listener death even when the tab stays visible -
 * two real signals, not invented ones. (1) onSnapshot's own standard
 * error channel, previously unwired at all in this file - a genuine
 * SDK feature for exactly this purpose. (2) a global
 * unhandledrejection listener matched against the literal error text
 * this session directly observed live ("Database is closing/hidden") -
 * the modern Firestore SDK uses IndexedDB for cross-tab coordination
 * even without the app opting into offline persistence, and that
 * failure isn't actually visibility-specific even though this
 * session's own reproduction happened to occur while backgrounded.
 */
describe("RuntimeSession - non-visibility listener death detection (Phase 23)", () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "..", "lib", "runtime", "runtimeSession.ts"),
    "utf8"
  );

  it("wires an onSnapshot error callback for the files listener that triggers reconnection", () => {
    const match = source.match(/private subscribeToFiles\([\s\S]*?\n {2}\}/);
    expect(match, "subscribeToFiles not found").not.toBeNull();
    const body = match![0];
    expect(body).toMatch(/this\.reconnectListeners\(sessionId, callbacks, "files-listener-error"\)/);
  });

  it("wires an onSnapshot error callback for the commands listener that triggers reconnection", () => {
    const match = source.match(/private subscribeToCommands\([\s\S]*?\n {2}\}/);
    expect(match, "subscribeToCommands not found").not.toBeNull();
    const body = match![0];
    expect(body).toMatch(/this\.reconnectListeners\(sessionId, this\.callbacks, "commands-listener-error"\)/);
  });

  it("registers a global unhandledrejection listener in start()", () => {
    const match = source.match(/async start\(sessionId: string, callbacks: RuntimeSessionCallbacks\): Promise<void> \{[\s\S]*?\n {2}\}/);
    expect(match, "start() not found").not.toBeNull();
    const body = match![0];
    expect(body).toMatch(/window\.addEventListener\("unhandledrejection", this\.unhandledRejectionHandler\)/);
  });

  it("matches on the real, literally-observed error text, not a broad/invented pattern", () => {
    expect(source).toMatch(/INDEXEDDB_CLOSED_ERROR_PATTERN = \/database is closing\\\/hidden\/i/);
  });

  it("removes the unhandledrejection listener on stop(), so a torn-down session can't keep triggering reconnects", () => {
    const match = source.match(/stop\(\): void \{[\s\S]*?\n {2}\}/);
    expect(match, "stop() not found").not.toBeNull();
    const body = match![0];
    expect(body).toMatch(/window\.removeEventListener\("unhandledrejection", this\.unhandledRejectionHandler\)/);
  });
});

/**
 * Phase 23: concurrent-recovery collapsing (chaos matrix E/F: recovery
 * requested 2-3 times "simultaneously"). JS's single-threaded execution
 * means reconnectListeners's own synchronous body can never truly
 * interleave, so this verifies the actual mechanism used - a debounce
 * against wasteful repeat work, not a lock needed for correctness (see
 * reconnectListeners's own doc comment for why correctness already
 * holds without one, traced through subscribeWhenSignedIn's
 * cancellation behavior).
 */
describe("RuntimeSession - reconnect debounce (Phase 23)", () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "..", "lib", "runtime", "runtimeSession.ts"),
    "utf8"
  );

  it("tracks a last-reconnect timestamp and skips a repeat call within the debounce window", () => {
    const match = source.match(
      /reconnectListeners\(sessionId: string, callbacks: RuntimeSessionCallbacks, reason: string\): void \{[\s\S]*?\n {2}\}/
    );
    const body = match![0];
    expect(body).toMatch(/if \(this\.lastReconnectAt !== null && now - this\.lastReconnectAt < RECONNECT_DEBOUNCE_MS\) return;/);
    expect(body).toMatch(/this\.lastReconnectAt = now;/);
  });
});
