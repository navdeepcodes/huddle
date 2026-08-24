import { describe, expect, it } from "vitest";
import { computeCurrentTurnChanges } from "@/lib/agent/changesSummary";
import type { TurnMessage } from "@/types/session";

describe("computeCurrentTurnChanges", () => {
  it("marks a write as added when the path wasn't in the checkpoint", () => {
    const log: TurnMessage[] = [
      { role: "user", content: "build a site", createdAt: 1 },
      { role: "tool", toolName: "write_file", content: "Wrote a.js.", ok: true, path: "a.js", createdAt: 2 },
    ];
    expect(computeCurrentTurnChanges(log, new Set())).toEqual([{ path: "a.js", status: "added" }]);
  });

  it("marks a write as modified when the path was already in the checkpoint", () => {
    const log: TurnMessage[] = [
      { role: "user", content: "darken the hero", createdAt: 1 },
      { role: "tool", toolName: "write_file", content: "Wrote Hero.jsx.", ok: true, path: "Hero.jsx", createdAt: 2 },
    ];
    expect(computeCurrentTurnChanges(log, new Set(["Hero.jsx"]))).toEqual([{ path: "Hero.jsx", status: "modified" }]);
  });

  it("only counts entries after the last real user message, ignoring prior turns", () => {
    const log: TurnMessage[] = [
      { role: "user", content: "build a site", createdAt: 1 },
      { role: "tool", toolName: "write_file", content: "Wrote old.js.", ok: true, path: "old.js", createdAt: 2 },
      { role: "user", content: "add a footer", createdAt: 3 },
      { role: "tool", toolName: "write_file", content: "Wrote Footer.jsx.", ok: true, path: "Footer.jsx", createdAt: 4 },
    ];
    expect(computeCurrentTurnChanges(log, new Set(["old.js"]))).toEqual([{ path: "Footer.jsx", status: "added" }]);
  });

  it("ignores a synthetic nudge when finding the turn boundary", () => {
    const log: TurnMessage[] = [
      { role: "user", content: "build a site", createdAt: 1 },
      { role: "tool", toolName: "write_file", content: "Wrote a.js.", ok: true, path: "a.js", createdAt: 2 },
      { role: "user", content: "You are running low on iterations...", isNudge: true, createdAt: 3 },
      { role: "tool", toolName: "write_file", content: "Wrote b.js.", ok: true, path: "b.js", createdAt: 4 },
    ];
    expect(computeCurrentTurnChanges(log, new Set())).toEqual([
      { path: "a.js", status: "added" },
      { path: "b.js", status: "added" },
    ]);
  });

  it("ignores a failed write_file call", () => {
    const log: TurnMessage[] = [
      { role: "user", content: "x", createdAt: 1 },
      { role: "tool", toolName: "write_file", content: "INVALID_TOOL_ARGUMENTS: ...", ok: false, createdAt: 2 },
    ];
    expect(computeCurrentTurnChanges(log, new Set())).toEqual([]);
  });

  it("dedups repeated writes to the same path, keeping the last status", () => {
    const log: TurnMessage[] = [
      { role: "user", content: "x", createdAt: 1 },
      { role: "tool", toolName: "write_file", content: "Wrote a.js.", ok: true, path: "a.js", createdAt: 2 },
      { role: "tool", toolName: "write_file", content: "Wrote a.js.", ok: true, path: "a.js", createdAt: 3 },
    ];
    expect(computeCurrentTurnChanges(log, new Set())).toEqual([{ path: "a.js", status: "added" }]);
  });
});
