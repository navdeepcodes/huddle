import { describe, expect, it } from "vitest";
import { buildRequesterContext } from "@/lib/agent/loop";

describe("buildRequesterContext (Phase 29 Part 2/4)", () => {
  it("returns null for a solo project - nothing useful to say when there's only one member", () => {
    expect(buildRequesterContext(["me"], "me")).toBeNull();
  });

  it("returns null when uid is missing, even in a multiplayer project", () => {
    expect(buildRequesterContext(["me", "them"], undefined)).toBeNull();
  });

  it("names the requester by their stable Teammate label in a two-person project", () => {
    const context = buildRequesterContext(["me", "them"], "them");
    expect(context).toContain("Current requester: Teammate");
    expect(context).toContain("Project collaborators:");
  });

  it("lists every collaborator, not just the requester", () => {
    const context = buildRequesterContext(["a", "b", "c"], "b")!;
    // buildTeammateLabels numbers by memberIds order with no self excluded here (server-side, no "You").
    expect(context).toContain("Teammate 1");
    expect(context).toContain("Teammate 2");
    expect(context).toContain("Teammate 3");
  });

  it("is a single compact line, not a multi-paragraph block - stays out of the way of the actual message", () => {
    const context = buildRequesterContext(["a", "b"], "a")!;
    expect(context.split("\n")).toHaveLength(1);
  });
});
