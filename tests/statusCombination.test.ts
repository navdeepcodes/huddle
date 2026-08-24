import { describe, expect, it } from "vitest";
import { deriveAgentStatus } from "@/lib/agent/agentStatus";
import { derivePreviewState } from "@/lib/preview/previewState";

import type { AgentTurn, RuntimeHost, TurnMessage } from "@/types/session";

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
    },
    providerMessages: [],
  };
}

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

/** Phase 30 Part 15 #10/#11: the two status signals are independently derived pure functions - neither can block, wait on, or corrupt the other, so these combinations always resolve to something coherent rather than a stuck/undefined UI state. */
describe("agent status and preview state combine independently (Phase 30 Part 15 #10/#11)", () => {
  it("#10: the agent turn completes while the preview never came up (still building) - both signals resolve independently, no stuck UI", () => {
    const log: TurnMessage[] = [{ role: "tool", toolName: "write_file", path: "a.ts", ok: true, content: "Wrote a.ts.", createdAt: 1 }];
    const agent = deriveAgentStatus(turn(log, false, "done"));
    const preview = derivePreviewState(host({ state: "installing" }), false, 0);

    expect(agent.status).toBe("completed");
    expect(agent.active).toBe(false);
    expect(preview.state).toBe("building"); // the preview is honestly still building - the agent finishing doesn't fabricate readiness
  });

  it("#11: the agent keeps working (e.g. writing more files) while the preview is independently in recovery - both stay accurate simultaneously", () => {
    const log: TurnMessage[] = [{ role: "tool", toolName: "write_file", path: "b.ts", ok: true, content: "Wrote b.ts.", createdAt: 1 }];
    const agent = deriveAgentStatus(turn(log, true));
    const preview = derivePreviewState(host({ state: "crashed", updatedAt: 0 }), false, 5_000);

    expect(agent.status).toBe("writing");
    expect(agent.active).toBe(true);
    expect(preview.state).toBe("recovering");
  });

  it("a turn ending 'blocked' and a healthy preview don't cross-contaminate each other's status", () => {
    const log: TurnMessage[] = [{ role: "tool", toolName: "run_command", argsSummary: "npm test", ok: true, content: "ok", createdAt: 1 }];
    const agent = deriveAgentStatus(turn(log, false, "blocked"));
    const preview = derivePreviewState(host({ state: "running", previewUrl: "https://x" }), true, 0);

    expect(agent.status).toBe("blocked");
    expect(preview.state).toBe("ready");
  });
});
