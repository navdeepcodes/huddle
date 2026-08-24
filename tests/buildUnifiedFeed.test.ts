import { describe, expect, it } from "vitest";
import { buildUnifiedFeed } from "@/lib/agent/activityFeed";
import type { TurnMessage } from "@/types/session";

function msg(partial: Partial<TurnMessage>): TurnMessage {
  return { role: "tool", content: null, createdAt: Date.now(), ...partial };
}

describe("buildUnifiedFeed", () => {
  it("interleaves messages and activity in their real chronological log order", () => {
    const log: TurnMessage[] = [
      { role: "user", content: "build me a blog", createdAt: 1 },
      msg({ toolName: "update_progress", ok: true, content: "Tracked. 2 subgoal(s)", createdAt: 2 }),
      msg({ toolName: "write_file", ok: true, path: "a.js", createdAt: 3 }),
      { role: "assistant", content: "Wrote the homepage.", createdAt: 4 },
    ];
    const items = buildUnifiedFeed(log);
    expect(items.map((i) => (i.type === "message" ? `message:${i.role}` : `activity:${i.entry.kind}`))).toEqual([
      "message:user",
      "activity:planning",
      "activity:files",
      "message:assistant",
    ]);
  });

  it("a chat message in between breaks the consecutive-same-kind merge, unlike buildActivityFeed's tool-only pass", () => {
    const log: TurnMessage[] = [
      msg({ toolName: "write_file", ok: true, path: "a.js", createdAt: 1 }),
      { role: "user", content: "actually also add a footer", createdAt: 2 },
      msg({ toolName: "write_file", ok: true, path: "b.js", createdAt: 3 }),
    ];
    const items = buildUnifiedFeed(log);
    const activityKinds = items.filter((i) => i.type === "activity");
    expect(activityKinds).toHaveLength(2);
    expect(activityKinds[0].type === "activity" && activityKinds[0].entry.detail).toEqual(["a.js"]);
    expect(activityKinds[1].type === "activity" && activityKinds[1].entry.detail).toEqual(["b.js"]);
  });

  it("still merges genuinely consecutive same-kind tool entries with nothing in between", () => {
    const log = [
      msg({ toolName: "write_file", ok: true, path: "a.js", createdAt: 1 }),
      msg({ toolName: "write_file", ok: true, path: "b.js", createdAt: 2 }),
    ];
    const items = buildUnifiedFeed(log);
    expect(items).toHaveLength(1);
    expect(items[0].type === "activity" && items[0].entry.summary).toBe("Wrote 2 files");
  });

  it("drops nudge messages, same as the chat surface always did", () => {
    const log: TurnMessage[] = [{ role: "user", content: "system nudge text", isNudge: true, createdAt: 1 }];
    expect(buildUnifiedFeed(log)).toEqual([]);
  });

  it("drops content-less assistant entries (tool-call-only turns produce no empty bubble)", () => {
    const log: TurnMessage[] = [{ role: "assistant", content: null, createdAt: 1 }];
    expect(buildUnifiedFeed(log)).toEqual([]);
  });

  it("appends a completed activity entry once the turn ends, same termination-label rules as buildActivityFeed", () => {
    const log: TurnMessage[] = [msg({ toolName: "write_file", ok: true, path: "a.js", createdAt: 1 })];
    const items = buildUnifiedFeed(log, { active: false, terminationReason: "done" });
    const last = items[items.length - 1];
    expect(last.type === "activity" && last.entry).toMatchObject({ kind: "completed", summary: "Completed", ok: true });
  });

  it("never appends a completed entry for a turn with only chat messages and no tool activity", () => {
    const log: TurnMessage[] = [{ role: "user", content: "hi", createdAt: 1 }];
    const items = buildUnifiedFeed(log, { active: false, terminationReason: "done" });
    expect(items.some((i) => i.type === "activity" && i.entry.kind === "completed")).toBe(false);
  });

  it("keeps only what comes AFTER the </think> tag - live-verified shape: reasoning before, real answer after, not the other way around", () => {
    const log: TurnMessage[] = [
      { role: "assistant", content: "The app is complete and functional.</think>Here's what was built: a blog.", createdAt: 1 },
    ];
    const items = buildUnifiedFeed(log);
    expect(items[0]).toMatchObject({ type: "message", role: "assistant", content: "Here's what was built: a blog." });
  });

  it("splits on the LAST </think> occurrence, not the first, in case the reasoning text itself contains the substring", () => {
    const log: TurnMessage[] = [
      { role: "assistant", content: "Let me think about this.</think>more reasoning</think>The real answer.", createdAt: 1 },
    ];
    const items = buildUnifiedFeed(log);
    expect(items[0]).toMatchObject({ content: "The real answer." });
  });

  it("drops an assistant entry that is only reasoning with nothing after the tag - no real answer to show", () => {
    const log: TurnMessage[] = [{ role: "assistant", content: "Just reasoning, turn ended early.</think>", createdAt: 1 }];
    expect(buildUnifiedFeed(log)).toEqual([]);
  });

  it("leaves ordinary content with no think tag at all untouched", () => {
    const log: TurnMessage[] = [{ role: "assistant", content: "Plain answer, no reasoning tag.", createdAt: 1 }];
    const items = buildUnifiedFeed(log);
    expect(items[0]).toMatchObject({ content: "Plain answer, no reasoning tag." });
  });
});
