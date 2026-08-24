import { describe, expect, it } from "vitest";
import { buildActivityFeed } from "@/lib/agent/activityFeed";
import type { TurnMessage } from "@/types/session";

function msg(partial: Partial<TurnMessage>): TurnMessage {
  return { role: "tool", content: null, createdAt: Date.now(), ...partial };
}

describe("buildActivityFeed", () => {
  it("ignores user and assistant prose entries - activity is tool-only", () => {
    const log: TurnMessage[] = [
      { role: "user", content: "build me a site", createdAt: 1 },
      { role: "assistant", content: "Sure, let me start.", createdAt: 2 },
    ];
    expect(buildActivityFeed(log)).toEqual([]);
  });

  it("merges consecutive write_file entries into one 'files' entry", () => {
    const log = [
      msg({ toolName: "write_file", ok: true, path: "a.js", createdAt: 1 }),
      msg({ toolName: "write_file", ok: true, path: "b.js", createdAt: 2 }),
      msg({ toolName: "write_file", ok: true, path: "c.js", createdAt: 3 }),
    ];
    const feed = buildActivityFeed(log);
    expect(feed).toHaveLength(1);
    expect(feed[0].kind).toBe("files");
    expect(feed[0].summary).toBe("Wrote 3 files");
    expect(feed[0].detail).toEqual(["a.js", "b.js", "c.js"]);
  });

  it("does not merge across a different kind in between", () => {
    const log = [
      msg({ toolName: "write_file", ok: true, path: "a.js" }),
      msg({ toolName: "run_command", ok: true, argsSummary: "npm run dev" }),
      msg({ toolName: "write_file", ok: true, path: "b.js" }),
    ];
    const feed = buildActivityFeed(log);
    expect(feed.map((e) => e.kind)).toEqual(["files", "running_command", "files"]);
  });

  it("routes a failed tool call to fixing_error regardless of tool name", () => {
    const log = [msg({ toolName: "run_command", ok: false, content: "exit code 1", argsSummary: "npm run build" })];
    const feed = buildActivityFeed(log);
    expect(feed[0].kind).toBe("fixing_error");
  });

  it("maps update_progress to planning", () => {
    const log = [msg({ toolName: "update_progress", ok: true, content: "Tracked. 2 subgoal(s): ..." })];
    expect(buildActivityFeed(log)[0].kind).toBe("planning");
  });

  it("appends a completed entry once the turn is inactive", () => {
    const log = [msg({ toolName: "write_file", ok: true, path: "a.js" })];
    const feed = buildActivityFeed(log, { active: false, terminationReason: "done" });
    expect(feed[feed.length - 1]).toMatchObject({ kind: "completed", summary: "Completed", ok: true });
  });

  it("does not append a completed entry for an active turn", () => {
    const log = [msg({ toolName: "write_file", ok: true, path: "a.js" })];
    const feed = buildActivityFeed(log, { active: true, terminationReason: null });
    expect(feed[feed.length - 1].kind).not.toBe("completed");
  });

  it("marks a crashed completion as not ok", () => {
    const log = [msg({ toolName: "write_file", ok: true, path: "a.js" })];
    const feed = buildActivityFeed(log, { active: false, terminationReason: "internal_error" });
    expect(feed[feed.length - 1].ok).toBe(false);
  });
});
