import { describe, expect, it } from "vitest";

import {
  buildBlockingPreviewNudge,
  buildBudgetExhaustedSummary,
  buildFinishModeNudge,
  buildIncompleteObjectiveNudge,
  buildIterationSignature,
  buildStagnationNudge,
  detectStagnation,
  hasOnlyBlockedRemaining,
  hasUnresolvedSubgoals,
  parseTaskStateUpdate,
} from "@/lib/agent/taskProgress";
import type { IterationAction } from "@/lib/agent/taskProgress";
import type { TaskState } from "@/types/session";

/**
 * All pure functions - no Firestore/provider/WebContainer dependency,
 * so these run against real inputs/outputs directly, no mocking. See
 * taskProgress.ts's own doc comment for the root cause this closes.
 */

describe("parseTaskStateUpdate", () => {
  it("parses a valid update_progress call", () => {
    const result = parseTaskStateUpdate(
      JSON.stringify({
        objective: "Build a coffee site and add a pricing section",
        subgoals: [
          { description: "Build the homepage", status: "done" },
          { description: "Add the pricing section", status: "pending" },
        ],
      }),
      1000
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.taskState.objective).toBe("Build a coffee site and add a pricing section");
    expect(result.taskState.subgoals).toHaveLength(2);
    expect(result.taskState.subgoals[1].status).toBe("pending");
    expect(result.taskState.updatedAt).toBe(1000);
  });

  it("rejects invalid JSON", () => {
    const result = parseTaskStateUpdate("not json", 1000);
    expect(result.ok).toBe(false);
  });

  it("rejects a missing/empty objective", () => {
    const result = parseTaskStateUpdate(JSON.stringify({ objective: "  ", subgoals: [] }), 1000);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("objective");
  });

  it("rejects a non-array subgoals field", () => {
    const result = parseTaskStateUpdate(JSON.stringify({ objective: "x", subgoals: "nope" }), 1000);
    expect(result.ok).toBe(false);
  });

  it("rejects a subgoal with an invalid status", () => {
    const result = parseTaskStateUpdate(
      JSON.stringify({ objective: "x", subgoals: [{ description: "y", status: "kinda done" }] }),
      1000
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("status");
  });

  it("rejects a subgoal with an empty description", () => {
    const result = parseTaskStateUpdate(
      JSON.stringify({ objective: "x", subgoals: [{ description: "", status: "pending" }] }),
      1000
    );
    expect(result.ok).toBe(false);
  });

  it("never throws on malformed input", () => {
    expect(() => parseTaskStateUpdate("{{{", 1000)).not.toThrow();
    expect(() => parseTaskStateUpdate("null", 1000)).not.toThrow();
    expect(() => parseTaskStateUpdate("[]", 1000)).not.toThrow();
  });
});

const VALID_CONTRACT = {
  framework: "Next.js 15",
  router: "Pages Router",
  language: "JavaScript",
  styling: "Tailwind CSS v4",
  pathAliases: "NONE",
  importConvention: "Relative imports",
  packageManager: "npm",
};

describe("parseTaskStateUpdate - projectContract (Phase 18)", () => {
  it("parses a call that includes a valid projectContract", () => {
    const result = parseTaskStateUpdate(
      JSON.stringify({ objective: "Build a site", subgoals: [], projectContract: VALID_CONTRACT }),
      1000
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.taskState.projectContract).toEqual(VALID_CONTRACT);
  });

  it("is fine with no projectContract at all - optional, not required like objective/subgoals", () => {
    const result = parseTaskStateUpdate(JSON.stringify({ objective: "Build a site", subgoals: [] }), 1000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.taskState.projectContract).toBeUndefined();
  });

  it("rejects a projectContract missing a required field", () => {
    const incomplete = Object.fromEntries(Object.entries(VALID_CONTRACT).filter(([key]) => key !== "pathAliases"));
    const result = parseTaskStateUpdate(
      JSON.stringify({ objective: "x", subgoals: [], projectContract: incomplete }),
      1000
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("pathAliases");
  });

  it("rejects a projectContract with an empty-string field", () => {
    const result = parseTaskStateUpdate(
      JSON.stringify({ objective: "x", subgoals: [], projectContract: { ...VALID_CONTRACT, language: "  " } }),
      1000
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a non-object projectContract", () => {
    const result = parseTaskStateUpdate(
      JSON.stringify({ objective: "x", subgoals: [], projectContract: "javascript, no aliases" }),
      1000
    );
    expect(result.ok).toBe(false);
  });

  it("trims whitespace on every contract field", () => {
    const padded = Object.fromEntries(Object.entries(VALID_CONTRACT).map(([k, v]) => [k, `  ${v}  `]));
    const result = parseTaskStateUpdate(
      JSON.stringify({ objective: "x", subgoals: [], projectContract: padded }),
      1000
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.taskState.projectContract).toEqual(VALID_CONTRACT);
  });
});

/**
 * Phase 42 §3: unlike projectContract, every field is individually
 * optional - the point is a cheap, few-words plan ("this is a small
 * website"), not a second required contract.
 */
describe("parseTaskStateUpdate - manifest (Phase 42)", () => {
  it("is fine with no manifest at all - fully optional", () => {
    const result = parseTaskStateUpdate(JSON.stringify({ objective: "x", subgoals: [] }), 1000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.taskState.manifest).toBeUndefined();
  });

  it("parses a manifest with only SOME fields present - every field is independently optional", () => {
    const result = parseTaskStateUpdate(
      JSON.stringify({ objective: "x", subgoals: [], manifest: { projectType: "marketing_site" } }),
      1000
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.taskState.manifest).toEqual({ projectType: "marketing_site" });
  });

  it("parses a manifest with every field present", () => {
    const manifest = {
      projectType: "marketing_site",
      routes: ["/"],
      targetFiles: ["src/App.jsx", "src/styles.css", "src/main.jsx"],
      fileBudget: 6,
    };
    const result = parseTaskStateUpdate(JSON.stringify({ objective: "x", subgoals: [], manifest }), 1000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.taskState.manifest).toEqual(manifest);
  });

  it("rejects a manifest field with the wrong type, without silently ignoring it", () => {
    const result = parseTaskStateUpdate(
      JSON.stringify({ objective: "x", subgoals: [], manifest: { routes: "just /, not an array" } }),
      1000
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a non-object manifest", () => {
    const result = parseTaskStateUpdate(
      JSON.stringify({ objective: "x", subgoals: [], manifest: "a small site" }),
      1000
    );
    expect(result.ok).toBe(false);
  });

  it("an empty manifest object is treated the same as no manifest at all", () => {
    const result = parseTaskStateUpdate(JSON.stringify({ objective: "x", subgoals: [], manifest: {} }), 1000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.taskState.manifest).toBeUndefined();
  });
});

describe("buildIterationSignature", () => {
  it("returns an empty string for no actions", () => {
    expect(buildIterationSignature([])).toBe("");
  });

  it("matches for two iterations with the same actions and results", () => {
    const actions: IterationAction[] = [
      { toolName: "run_command", argsKey: "curl localhost:3000", ok: true, resultContent: "Error: connection refused" },
    ];
    const a = buildIterationSignature(actions);
    const b = buildIterationSignature([{ ...actions[0] }]);
    expect(a).toBe(b);
    expect(a).not.toBe("");
  });

  it("differs when the result content changes, even for the same action", () => {
    const a = buildIterationSignature([
      { toolName: "run_command", argsKey: "curl localhost:3000", ok: true, resultContent: "Error: connection refused" },
    ]);
    const b = buildIterationSignature([
      { toolName: "run_command", argsKey: "curl localhost:3000", ok: true, resultContent: "200 OK" },
    ]);
    expect(a).not.toBe(b);
  });

  it("differs when the action target changes", () => {
    const a = buildIterationSignature([
      { toolName: "write_file", argsKey: "app/globals.css", ok: true, resultContent: "body{}" },
    ]);
    const b = buildIterationSignature([
      { toolName: "write_file", argsKey: "app/page.tsx", ok: true, resultContent: "body{}" },
    ]);
    expect(a).not.toBe(b);
  });

  it("is not affected by action order within the same iteration", () => {
    const one: IterationAction = { toolName: "read_file", argsKey: "a.ts", ok: true, resultContent: "A" };
    const two: IterationAction = { toolName: "read_file", argsKey: "b.ts", ok: true, resultContent: "B" };
    expect(buildIterationSignature([one, two])).toBe(buildIterationSignature([two, one]));
  });
});

describe("detectStagnation", () => {
  it("is false below the threshold", () => {
    expect(detectStagnation(["x", "x"], 3)).toBe(false);
  });

  it("is true when the last N signatures are identical", () => {
    expect(detectStagnation(["a", "x", "x", "x"], 3)).toBe(true);
  });

  it("is false when the last N signatures differ", () => {
    expect(detectStagnation(["x", "x", "y"], 3)).toBe(false);
  });

  it("does not treat repeated empty signatures as stagnation", () => {
    // An empty signature means "no tool calls that step" - not a
    // repeatable action worth escalating on.
    expect(detectStagnation(["", "", ""], 3)).toBe(false);
  });

  it("does not fire on legitimate repeated commands whose results differ each time", () => {
    // "Do NOT treat every repeated command as failure" - a poll loop
    // that observes real state change each time should not stagnate.
    const sigs = [
      buildIterationSignature([{ toolName: "run_command", argsKey: "npm run build", ok: true, resultContent: "step 1/5" }]),
      buildIterationSignature([{ toolName: "run_command", argsKey: "npm run build", ok: true, resultContent: "step 3/5" }]),
      buildIterationSignature([{ toolName: "run_command", argsKey: "npm run build", ok: true, resultContent: "step 5/5 done" }]),
    ];
    expect(detectStagnation(sigs, 3)).toBe(false);
  });
});

describe("hasUnresolvedSubgoals", () => {
  it("is false for an undefined taskState", () => {
    expect(hasUnresolvedSubgoals(undefined)).toBe(false);
  });

  it("is true when a subgoal is pending or in_progress", () => {
    const taskState: TaskState = {
      objective: "x",
      subgoals: [
        { description: "a", status: "done" },
        { description: "b", status: "pending" },
      ],
      updatedAt: 0,
    };
    expect(hasUnresolvedSubgoals(taskState)).toBe(true);
  });

  it("is false when every subgoal is done or blocked", () => {
    const taskState: TaskState = {
      objective: "x",
      subgoals: [
        { description: "a", status: "done" },
        { description: "b", status: "blocked" },
      ],
      updatedAt: 0,
    };
    expect(hasUnresolvedSubgoals(taskState)).toBe(false);
  });
});

describe("hasOnlyBlockedRemaining", () => {
  it("is false for an undefined taskState", () => {
    expect(hasOnlyBlockedRemaining(undefined)).toBe(false);
  });

  it("is false when everything is done (nothing remaining at all)", () => {
    const taskState: TaskState = {
      objective: "x",
      subgoals: [{ description: "a", status: "done" }],
      updatedAt: 0,
    };
    expect(hasOnlyBlockedRemaining(taskState)).toBe(false);
  });

  it("is true when every non-done subgoal is blocked", () => {
    const taskState: TaskState = {
      objective: "x",
      subgoals: [
        { description: "a", status: "done" },
        { description: "b", status: "blocked" },
      ],
      updatedAt: 0,
    };
    expect(hasOnlyBlockedRemaining(taskState)).toBe(true);
  });

  it("is false when a pending/in_progress subgoal remains alongside a blocked one", () => {
    const taskState: TaskState = {
      objective: "x",
      subgoals: [
        { description: "a", status: "blocked" },
        { description: "b", status: "pending" },
      ],
      updatedAt: 0,
    };
    expect(hasOnlyBlockedRemaining(taskState)).toBe(false);
  });
});

describe("buildStagnationNudge", () => {
  it("references the objective when known", () => {
    const taskState: TaskState = { objective: "Add a pricing section", subgoals: [], updatedAt: 0 };
    expect(buildStagnationNudge(taskState)).toContain("Add a pricing section");
  });

  it("does not crash and still produces guidance when taskState is undefined", () => {
    const nudge = buildStagnationNudge(undefined);
    expect(nudge.length).toBeGreaterThan(0);
    expect(nudge).toContain("update_progress");
  });

  it("instructs marking blocked and moving on, not just retrying", () => {
    const nudge = buildStagnationNudge(undefined);
    expect(nudge.toLowerCase()).toContain("blocked");
  });
});

describe("buildIncompleteObjectiveNudge", () => {
  it("lists only the remaining pending/in_progress subgoals", () => {
    const taskState: TaskState = {
      objective: "Build a coffee site and add a pricing section",
      subgoals: [
        { description: "Build the homepage", status: "done" },
        { description: "Add the pricing section", status: "pending" },
      ],
      updatedAt: 0,
    };
    const nudge = buildIncompleteObjectiveNudge(taskState);
    expect(nudge).toContain("Add the pricing section");
    expect(nudge).not.toContain("Build the homepage");
    expect(nudge).toContain("Build a coffee site and add a pricing section");
  });
});

describe("buildBudgetExhaustedSummary", () => {
  it("handles an undefined taskState gracefully", () => {
    const summary = buildBudgetExhaustedSummary(undefined, "some final thought");
    expect(summary).toContain("no task plan was recorded");
  });

  it("produces the required OBJECTIVE/COMPLETED/BLOCKED/REMAINING/LAST DIAGNOSIS/NEXT RECOMMENDED ACTION structure", () => {
    const taskState: TaskState = {
      objective: "Build a coffee site and add a pricing section",
      subgoals: [
        { description: "Build the homepage", status: "done" },
        { description: "Fix Tailwind loading", status: "blocked" },
        { description: "Add the pricing section", status: "pending" },
      ],
      updatedAt: 0,
    };
    const summary = buildBudgetExhaustedSummary(taskState, "Tailwind still isn't loading, tried three configs.");
    expect(summary).toContain("OBJECTIVE: Build a coffee site and add a pricing section");
    expect(summary).toContain("COMPLETED: Build the homepage");
    expect(summary).toContain("BLOCKED: Fix Tailwind loading");
    expect(summary).toContain("REMAINING: Add the pricing section");
    expect(summary).toContain("LAST DIAGNOSIS: Tailwind still isn't loading");
    // Remaining work outranks a blocker as the next recommended action -
    // the core invariant (never get stuck only on the blocked subgoal).
    expect(summary).toContain('NEXT RECOMMENDED ACTION: continue with "Add the pricing section"');
  });

  it("recommends investigating the blocker when nothing else remains", () => {
    const taskState: TaskState = {
      objective: "x",
      subgoals: [
        { description: "a", status: "done" },
        { description: "b", status: "blocked" },
      ],
      updatedAt: 0,
    };
    const summary = buildBudgetExhaustedSummary(taskState, null);
    expect(summary).toContain('NEXT RECOMMENDED ACTION: investigate the blocker on "b"');
  });
});

describe("buildFinishModeNudge (Phase 21)", () => {
  it("lists only the currently unresolved subgoals, not done ones", () => {
    const taskState: TaskState = {
      objective: "Build a furniture site",
      subgoals: [
        { description: "Set up project", status: "done" },
        { description: "Build product pages", status: "in_progress" },
        { description: "Verify runtime", status: "pending" },
      ],
      updatedAt: 0,
    };
    const nudge = buildFinishModeNudge(taskState, 6);
    expect(nudge).toContain("Build product pages");
    expect(nudge).toContain("Verify runtime");
    expect(nudge).not.toContain("Set up project");
  });

  it("reports the actual remaining iteration count", () => {
    const nudge = buildFinishModeNudge(undefined, 5);
    expect(nudge).toContain("5 iterations left");
  });

  it("instructs deferring optional work, not a specific coding sequence", () => {
    const nudge = buildFinishModeNudge(undefined, 6);
    expect(nudge.toLowerCase()).toContain("stop adding optional features");
  });

  it("handles an undefined taskState gracefully", () => {
    expect(() => buildFinishModeNudge(undefined, 4)).not.toThrow();
  });
});

describe("buildBlockingPreviewNudge (Phase 21)", () => {
  it("references the objective when known", () => {
    const taskState: TaskState = { objective: "Build a furniture site", subgoals: [], updatedAt: 0 };
    expect(buildBlockingPreviewNudge(taskState)).toContain("Build a furniture site");
  });

  it("names view_preview specifically as what needs to be resolved", () => {
    const nudge = buildBlockingPreviewNudge(undefined);
    expect(nudge).toContain("view_preview");
  });

  it("handles an undefined taskState gracefully", () => {
    expect(() => buildBlockingPreviewNudge(undefined)).not.toThrow();
  });
});
