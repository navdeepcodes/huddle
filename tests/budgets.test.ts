import { describe, expect, it } from "vitest";

import {
  refuseForBudget,
  isRuntimeRestartCall,
  isDevServerCommand,
  isBuildCommand,
} from "@/lib/agent/executeTool";

import type { ChatCompletionMessageToolCall } from "openai/resources/chat/completions";

/**
 * Phase 40 §6: these policies all existed as prompt text with no code
 * backstop - the diagnosis confirmed buildState.attempt was incremented
 * but never read, restarts were never counted, image retries had no
 * counter at all, and a foreground dev server would hang for the full
 * 130s timeout exactly as prompt.ts documents happening live. These
 * tests pin the enforcement.
 */
function call(name: string, args: Record<string, unknown> = {}): ChatCompletionMessageToolCall {
  return {
    id: "call-1",
    type: "function" as const,
    function: { name, arguments: JSON.stringify(args) },
  };
}

const OK: Parameters<typeof refuseForBudget>[1] = {
  buildAttempts: 0,
  maxBuildAttempts: 3,
  runtimeRestarts: 0,
  maxRuntimeRestarts: 2,
  deadlinePassed: false,
};

describe("isDevServerCommand", () => {
  it("recognizes dev-server launches across package managers and aliases", () => {
    expect(isDevServerCommand("npm run dev")).toBe(true);
    expect(isDevServerCommand("yarn dev")).toBe(true);
    expect(isDevServerCommand("pnpm run dev")).toBe(true);
    expect(isDevServerCommand("next dev")).toBe(true);
    expect(isDevServerCommand("npm run dev -- -p 3001")).toBe(true);
  });

  it("does not confuse a build for a dev server", () => {
    expect(isDevServerCommand("npm run build")).toBe(false);
    expect(isDevServerCommand("vite build")).toBe(false);
    expect(isDevServerCommand("npm install")).toBe(false);
  });

  it("stays disjoint from isBuildCommand - no command is both", () => {
    for (const c of ["npm run dev", "npm run build", "next dev", "next build", "npm install"]) {
      expect(isDevServerCommand(c) && isBuildCommand(c)).toBe(false);
    }
  });
});

describe("isRuntimeRestartCall", () => {
  it("counts a BACKGROUND dev-server launch as a restart", () => {
    expect(isRuntimeRestartCall(call("run_command", { command: "npm run dev", background: true }))).toBe(true);
  });

  it("does not count a foreground dev-server attempt (that path is rejected outright instead)", () => {
    expect(isRuntimeRestartCall(call("run_command", { command: "npm run dev" }))).toBe(false);
  });

  it("does not count builds, installs, or non-run_command tools", () => {
    expect(isRuntimeRestartCall(call("run_command", { command: "npm run build", background: true }))).toBe(false);
    expect(isRuntimeRestartCall(call("run_command", { command: "npm install", background: true }))).toBe(false);
    expect(isRuntimeRestartCall(call("view_preview"))).toBe(false);
  });

  it("never throws on malformed arguments", () => {
    const malformed = { id: "x", type: "function" as const, function: { name: "run_command", arguments: "{not json" } };
    expect(() => isRuntimeRestartCall(malformed)).not.toThrow();
    expect(isRuntimeRestartCall(malformed)).toBe(false);
  });
});

describe("refuseForBudget - build attempts (§6A)", () => {
  it("allows builds while the budget remains", () => {
    expect(refuseForBudget(call("run_command", { command: "npm run build" }), { ...OK, buildAttempts: 2 })).toBeNull();
  });

  it("refuses a build once the cap is reached, naming the cap", () => {
    const refusal = refuseForBudget(call("run_command", { command: "npm run build" }), { ...OK, buildAttempts: 3 });
    expect(refusal).toContain("BUDGET_EXHAUSTED (build)");
    expect(refusal).toContain("3 build attempts");
  });

  it("does not refuse unrelated commands when the build budget is spent", () => {
    const spent = { ...OK, buildAttempts: 3 };
    expect(refuseForBudget(call("run_command", { command: "npm install" }), spent)).toBeNull();
    expect(refuseForBudget(call("run_command", { command: "curl -s localhost:3000" }), spent)).toBeNull();
    expect(refuseForBudget(call("write_file", { path: "a.js", content: "x" }), spent)).toBeNull();
  });

  it("never refuses the tools a stopped turn still needs to report honestly", () => {
    const allSpent = { ...OK, buildAttempts: 9, runtimeRestarts: 9, deadlinePassed: true };
    expect(refuseForBudget(call("update_progress", {}), allSpent)).toBeNull();
    expect(refuseForBudget(call("write_file", { path: "a.js", content: "x" }), allSpent)).toBeNull();
    expect(refuseForBudget(call("read_file", { path: "a.js" }), allSpent)).toBeNull();
  });
});

describe("refuseForBudget - runtime restarts (§6B)", () => {
  it("allows restarts while the budget remains", () => {
    expect(
      refuseForBudget(call("run_command", { command: "npm run dev", background: true }), { ...OK, runtimeRestarts: 1 })
    ).toBeNull();
  });

  it("refuses a restart once the cap is reached", () => {
    const refusal = refuseForBudget(call("run_command", { command: "npm run dev", background: true }), {
      ...OK,
      runtimeRestarts: 2,
    });
    expect(refusal).toContain("BUDGET_EXHAUSTED (runtime restart)");
  });

  it("counts a varied restart command too - not just an exact string repeat", () => {
    const refusal = refuseForBudget(
      call("run_command", { command: "npm run dev -- -p 3001", background: true }),
      { ...OK, runtimeRestarts: 2 }
    );
    expect(refusal).toContain("BUDGET_EXHAUSTED (runtime restart)");
  });
});

describe("refuseForBudget - wall clock (§7)", () => {
  it("refuses expensive operations once the deadline has passed", () => {
    const late = { ...OK, deadlinePassed: true };
    expect(refuseForBudget(call("view_preview"), late)).toContain("BUDGET_EXHAUSTED (time)");
    expect(refuseForBudget(call("create_image", { prompt: "x" }), late)).toContain("BUDGET_EXHAUSTED (time)");
    expect(refuseForBudget(call("edit_image", { sourceArtifactId: "a", instruction: "b" }), late)).toContain(
      "BUDGET_EXHAUSTED (time)"
    );
  });

  it("allows those same operations before the deadline", () => {
    expect(refuseForBudget(call("view_preview"), OK)).toBeNull();
    expect(refuseForBudget(call("create_image", { prompt: "x" }), OK)).toBeNull();
  });
});
