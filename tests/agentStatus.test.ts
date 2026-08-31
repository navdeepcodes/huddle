import { describe, expect, it } from "vitest";
import { deriveAgentStatus } from "@/lib/agent/agentStatus";

import type { AgentTurn, TurnMessage } from "@/types/session";

function turn(log: TurnMessage[], active: boolean, terminationReason: AgentTurn["telemetry"]["terminationReason"] = null): AgentTurn {
  return {
    sessionId: "s1",
    active,
    startedAt: 0,
    cancelledAt: null,
    log,
    telemetry: {
      iterations: 0,
      toolCalls: 0,
      successfulActions: 0,
      failedActions: 0,
      iterationDurationsMs: [],
      timeToFirstRunMs: null,
      timeToFirstPreviewMs: null,
      totalDurationMs: 0,
      terminationReason,
      repeatedIterations: 0,
      stagnationNudgesSent: 0,
      incompleteObjectiveNudgesSent: 0,
      finishModeNudgesSent: 0,
      blockingPreviewNudgesSent: 0,
      evidenceNudgesSent: 0,
      truncatedNoActionRetries: 0,
      providerFallback: { activated: false, fromProviderId: null, toProviderId: null, reason: null },
      timeToFirstBuildMs: null,
      fileBudgetWarningSent: false,
      buildEarlyNudgeSent: false,
    },
    providerMessages: [],
  };
}

describe("deriveAgentStatus (Phase 30)", () => {
  it("returns idle when there is no turn at all", () => {
    expect(deriveAgentStatus(null)).toEqual({ status: "idle", label: "Ready", detail: null, active: false });
  });

  it("returns planning with no detail when a turn just started with no tool activity yet", () => {
    const info = deriveAgentStatus(turn([], true));
    expect(info.status).toBe("planning");
    expect(info.active).toBe(true);
  });

  it("maps the latest write_file activity to 'writing' while active", () => {
    const log: TurnMessage[] = [
      { role: "tool", toolName: "write_file", path: "a.ts", ok: true, content: "Wrote a.ts.", createdAt: 1 },
    ];
    const info = deriveAgentStatus(turn(log, true));
    expect(info.status).toBe("writing");
    expect(info.detail).toContain("Wrote");
  });

  it("maps run_command to 'running', view_preview to 'inspecting', a failed call to 'fixing'", () => {
    const runLog: TurnMessage[] = [
      { role: "tool", toolName: "run_command", argsSummary: "npm run dev", ok: true, content: "ok", createdAt: 1 },
    ];
    expect(deriveAgentStatus(turn(runLog, true)).status).toBe("running");

    const previewLog: TurnMessage[] = [
      { role: "tool", toolName: "view_preview", ok: true, content: "ok", createdAt: 1 },
    ];
    expect(deriveAgentStatus(turn(previewLog, true)).status).toBe("inspecting");

    const failLog: TurnMessage[] = [
      { role: "tool", toolName: "run_command", argsSummary: "npm run build", ok: false, content: "failed", createdAt: 1 },
    ];
    expect(deriveAgentStatus(turn(failLog, true)).status).toBe("fixing");
  });

  it("returns 'completed' once the turn ends normally, and 'blocked' when it ends blocked", () => {
    const log: TurnMessage[] = [
      { role: "tool", toolName: "write_file", path: "a.ts", ok: true, content: "Wrote a.ts.", createdAt: 1 },
    ];
    expect(deriveAgentStatus(turn(log, false, "done")).status).toBe("completed");
    expect(deriveAgentStatus(turn(log, false, "blocked")).status).toBe("blocked");
  });

  it("never includes raw assistant reasoning text - only activityFeed-derived summaries", () => {
    const log: TurnMessage[] = [
      { role: "assistant", content: "I am thinking deeply about the architecture and considering three approaches...", createdAt: 1 },
      { role: "tool", toolName: "write_file", path: "a.ts", ok: true, content: "Wrote a.ts.", createdAt: 2 },
    ];
    const info = deriveAgentStatus(turn(log, true));
    expect(info.detail).not.toContain("thinking deeply");
    expect(info.label).not.toContain("thinking deeply");
  });
});
