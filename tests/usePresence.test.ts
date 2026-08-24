import { describe, expect, it, vi, beforeEach } from "vitest";
import { startPresenceHeartbeat } from "@/hooks/usePresence";

/**
 * Phase 28 Part 2: usePresence's setInterval -> self-rescheduling
 * setTimeout fix (Phase 27) had no dedicated regression test - only
 * live instrumentation proved it worked. This tests the actual
 * scheduling loop directly (startPresenceHeartbeat, extracted from
 * the hook for exactly this reason - same pattern as useCheckpoints'
 * module-scope fetchCheckpoints), with fake fetch/scheduler
 * dependencies, rather than standing up a React rendering harness
 * this codebase doesn't otherwise use for hooks.
 */
function okResponse(list: unknown[] = []) {
  return { ok: true, json: async () => ({ presence: list }) } as Response;
}

describe("startPresenceHeartbeat (Phase 28 Part 2)", () => {
  let scheduled: Array<{ cb: () => void; ms: number }>;
  let cleared: unknown[];
  let nextHandle: number;

  function scheduleFn(cb: () => void, ms: number) {
    const handle = nextHandle++;
    scheduled.push({ cb, ms });
    return handle as unknown as ReturnType<typeof setTimeout>;
  }
  function clearFn(handle: unknown) {
    cleared.push(handle);
  }

  beforeEach(() => {
    scheduled = [];
    cleared = [];
    nextHandle = 1;
  });

  it("schedules the next heartbeat after a successful tick", async () => {
    const fetchFn = vi.fn().mockResolvedValue(okResponse([{ uid: "u1" }]));
    const onPresence = vi.fn();

    startPresenceHeartbeat({ sessionId: "s1", tabId: "t1", fetchFn, onPresence, scheduleFn, clearFn, getIntervalMs: () => 8000 });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(onPresence).toHaveBeenCalledWith([{ uid: "u1" }]);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].ms).toBe(8000);
  });

  it("still schedules the next heartbeat after a failed tick - a single bad tick can't silently end all future ones", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("network down"));
    const onPresence = vi.fn();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    startPresenceHeartbeat({ sessionId: "s1", tabId: "t1", fetchFn, onPresence, scheduleFn, clearFn, getIntervalMs: () => 8000 });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(onPresence).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(1);

    consoleSpy.mockRestore();
  });

  it("also schedules the next heartbeat when the response itself is not ok (no throw, but no presence data either)", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false } as Response);
    const onPresence = vi.fn();

    startPresenceHeartbeat({ sessionId: "s1", tabId: "t1", fetchFn, onPresence, scheduleFn, clearFn, getIntervalMs: () => 8000 });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(onPresence).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(1);
  });

  it("stopping before the first tick's timer is scheduled prevents any future tick, and calling the pending timer's callback afterward is a safe no-op", async () => {
    const fetchFn = vi.fn().mockResolvedValue(okResponse());
    const onPresence = vi.fn();

    const stop = startPresenceHeartbeat({ sessionId: "s1", tabId: "t1", fetchFn, onPresence, scheduleFn, clearFn, getIntervalMs: () => 8000 });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(scheduled).toHaveLength(1);
    stop();
    expect(cleared).toEqual([1]); // the one pending timer handle was cleared

    // Simulate the (now-cleared, in a real timer) callback firing anyway -
    // this must not update presence or schedule a further tick.
    fetchFn.mockClear();
    onPresence.mockClear();
    scheduled[0].cb();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(onPresence).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(1); // no second entry was ever pushed
  });

  it("Phase 30B Part 1: reads getIntervalMs() fresh on every reschedule, not once at start - so a tab that becomes hidden mid-run slows down on its very next tick", async () => {
    const fetchFn = vi.fn().mockResolvedValue(okResponse());
    const onPresence = vi.fn();
    let hidden = false;
    const getIntervalMs = () => (hidden ? 15_000 : 8_000);

    startPresenceHeartbeat({ sessionId: "s1", tabId: "t1", fetchFn, onPresence, scheduleFn, clearFn, getIntervalMs });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(scheduled[0].ms).toBe(8_000);

    // Tab goes to background between ticks - simulate the first tick firing now.
    hidden = true;
    scheduled[0].cb();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(scheduled[1].ms).toBe(15_000);
  });
});
