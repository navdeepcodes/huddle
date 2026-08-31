import { describe, expect, it } from "vitest";

import { deriveProjectIdentity } from "@/lib/agent/projectIdentity";

describe("deriveProjectIdentity", () => {
  it("returns null when no taskState was ever recorded", () => {
    expect(deriveProjectIdentity(undefined)).toBeNull();
  });

  it("returns the objective and a done-count progress label", () => {
    const identity = deriveProjectIdentity({
      objective: "Build a coffee site with a shop page",
      subgoals: [
        { description: "Homepage", status: "done" },
        { description: "Shop page", status: "in_progress" },
      ],
      updatedAt: 1,
    });
    expect(identity).toEqual({ objective: "Build a coffee site with a shop page", progressLabel: "1 of 2 done" });
  });

  it("truncates a long objective for a header line", () => {
    const longObjective = "Build a fully-featured ecommerce storefront with a home, collections, product, and cart page".repeat(1);
    const identity = deriveProjectIdentity({ objective: longObjective, subgoals: [], updatedAt: 1 });
    expect(identity?.objective.length).toBeLessThanOrEqual(80);
    expect(identity?.objective.endsWith("…")).toBe(true);
  });

  it("omits the progress label when no subgoals were tracked yet", () => {
    const identity = deriveProjectIdentity({ objective: "Build a blog", subgoals: [], updatedAt: 1 });
    expect(identity?.progressLabel).toBeNull();
  });
});
