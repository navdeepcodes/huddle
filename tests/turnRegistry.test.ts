import { describe, expect, it } from "vitest";
import { registerTurn, unregisterTurn, cancelTurn, isTurnActive } from "@/lib/agent/turnRegistry";

/**
 * Phase 27 Part G/O: the registry backing the turn route's 409 lock
 * ("Agent is currently working on this project") had no direct test -
 * only the client-side handling of a 409 was covered. isTurnActive is
 * exactly what the route checks before starting a second turn for the
 * same session, so this is the one guarantee multiplayer's
 * concurrent-request protection actually rests on.
 */
describe("turnRegistry (Phase 27 Part G)", () => {
  it("reports inactive for a session that has never registered a turn", () => {
    expect(isTurnActive("never-seen-session")).toBe(false);
  });

  it("reports active once a turn is registered, until it's unregistered", () => {
    const sessionId = "session-a";
    registerTurn(sessionId);
    expect(isTurnActive(sessionId)).toBe(true);
    unregisterTurn(sessionId);
    expect(isTurnActive(sessionId)).toBe(false);
  });

  it("tracks two different sessions independently - one active turn never blocks an unrelated session", () => {
    registerTurn("session-b1");
    expect(isTurnActive("session-b1")).toBe(true);
    expect(isTurnActive("session-b2")).toBe(false);
    unregisterTurn("session-b1");
  });

  it("cancelTurn aborts the registered controller and returns true", () => {
    const sessionId = "session-c";
    const controller = registerTurn(sessionId);
    expect(controller.signal.aborted).toBe(false);
    expect(cancelTurn(sessionId)).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    unregisterTurn(sessionId);
  });

  it("cancelTurn returns false for a session with no active turn - the concurrent second submitter's cancel can't reach into a turn it doesn't own", () => {
    expect(cancelTurn("no-such-session")).toBe(false);
  });
});
