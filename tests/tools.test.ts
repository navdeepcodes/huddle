import { describe, expect, it } from "vitest";

import { AGENT_TOOLS } from "@/lib/agent/tools";

/**
 * Phase 15, Phase 7: a defensive rule against the Benchmark B failure
 * (list_files falsely reported a real, non-empty project as empty; the
 * agent trusted it and rebuilt an entirely unrelated project). The
 * underlying list_files bug is fixed at the code level (see
 * fileStore.test.ts's normalization coverage) - this is the
 * complementary safety net: even if list_files is ever wrong again for
 * a different, future reason, the tool's own contract tells the model
 * to cross-check via the independent, already-existing run_command
 * mechanism before treating an unexpected empty result as license to
 * rebuild. Whether a real model actually follows this can only be
 * proven live (see the Phase 10 sanity test) - this test only proves
 * the guidance itself is present and can't silently regress out of the
 * tool description.
 */
describe("AGENT_TOOLS - list_files fail-safe guidance (Phase 15 regression)", () => {
  const listFilesTool = AGENT_TOOLS.find(
    (t) => t.type === "function" && t.function.name === "list_files"
  );

  it("list_files is registered", () => {
    expect(listFilesTool).toBeDefined();
  });

  it("warns against trusting an unexpected empty result at face value", () => {
    const description = listFilesTool?.type === "function" ? listFilesTool.function.description ?? "" : "";
    expect(description.toLowerCase()).toContain("do not trust");
    expect(description.toLowerCase()).toContain("rebuild");
  });

  it("points at run_command as the independent cross-check mechanism, not a new tool", () => {
    const description = listFilesTool?.type === "function" ? listFilesTool.function.description ?? "" : "";
    expect(description).toContain("run_command");
    // Confirms the guard reuses an existing tool rather than inventing
    // a parallel filesystem implementation - run_command must actually
    // be a real, separately-registered tool for this cross-check to work.
    expect(AGENT_TOOLS.some((t) => t.type === "function" && t.function.name === "run_command")).toBe(true);
  });
});

/**
 * Phase 20: subgoals should track meaningful product deliverables, not
 * individual files ("build the product catalog", not "create
 * Header.js") - observed live that the model mostly gets this right
 * already, but nothing in the tool's own contract said so explicitly.
 * Same discipline as the list_files test above: proves the guidance
 * can't silently regress out of the description, not that a real model
 * follows it (that's the Phase 20 live benchmark's job).
 */
describe("AGENT_TOOLS - update_progress subgoal granularity guidance (Phase 20 regression)", () => {
  const updateProgressTool = AGENT_TOOLS.find(
    (t) => t.type === "function" && t.function.name === "update_progress"
  );

  it("update_progress is registered", () => {
    expect(updateProgressTool).toBeDefined();
  });

  it("warns against per-file subgoals in both the tool description and the subgoals field description", () => {
    if (updateProgressTool?.type !== "function") throw new Error("update_progress not a function tool");
    expect(updateProgressTool.function.description).toContain("not individual files");

    const params = updateProgressTool.function.parameters as {
      properties: { subgoals: { description: string } };
    };
    expect(params.properties.subgoals.description.toLowerCase()).toContain("not one entry per file");
  });
});

describe("AGENT_TOOLS - update_progress milestone synchronization guidance (Phase 21 regression)", () => {
  const updateProgressTool = AGENT_TOOLS.find(
    (t) => t.type === "function" && t.function.name === "update_progress"
  );

  it("tells the model to sync at real milestones, not after every file, and before claiming done", () => {
    if (updateProgressTool?.type !== "function") throw new Error("update_progress not a function tool");
    expect(updateProgressTool.function.description).toContain("not after every individual file");
    expect(updateProgressTool.function.description).toContain("BEFORE claiming a turn is finished");
  });
});

/**
 * Phase 25: closes the completion-gate gap the audit found - the
 * existing hasUnresolvedSubgoals gate (taskProgress.ts, frozen this
 * phase) only blocks "done" while TRACKED subgoals are pending; it
 * can't catch a request for 4 pages that the model only ever tracked
 * as 1 vague subgoal. The fix has to be upstream, in what subgoals the
 * model records in the first place.
 */
describe("AGENT_TOOLS - update_progress full-scope subgoal guidance (Phase 25 regression)", () => {
  const updateProgressTool = AGENT_TOOLS.find(
    (t) => t.type === "function" && t.function.name === "update_progress"
  );

  it("tells the model to give each named page/section/feature its own subgoal, not one vague one covering all of them", () => {
    if (updateProgressTool?.type !== "function") throw new Error("update_progress not a function tool");
    expect(updateProgressTool.function.description).toContain("give EACH one its own subgoal");
  });
});
