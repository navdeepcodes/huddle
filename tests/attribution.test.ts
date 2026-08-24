import { describe, expect, it } from "vitest";
import { buildTeammateLabels, labelForUid } from "@/lib/presence/attribution";

describe("buildTeammateLabels / labelForUid (Phase 28 Part 3)", () => {
  it("labels the sole other member 'Teammate', with no number", () => {
    const labels = buildTeammateLabels(["me", "them"], "me");
    expect(labels.get("them")).toBe("Teammate");
  });

  it("numbers multiple other members by their memberIds join order", () => {
    const labels = buildTeammateLabels(["me", "a", "b", "c"], "me");
    expect(labels.get("a")).toBe("Teammate 1");
    expect(labels.get("b")).toBe("Teammate 2");
    expect(labels.get("c")).toBe("Teammate 3");
  });

  it("never includes self in the teammate labels", () => {
    const labels = buildTeammateLabels(["me", "them"], "me");
    expect(labels.has("me")).toBe(false);
  });

  it("labelForUid returns 'You' for self, 'Huddle' for a missing uid, and the teammate label otherwise", () => {
    const labels = buildTeammateLabels(["me", "them"], "me");
    expect(labelForUid("me", "me", labels)).toBe("You");
    expect(labelForUid(undefined, "me", labels)).toBe("Huddle");
    expect(labelForUid(null, "me", labels)).toBe("Huddle");
    expect(labelForUid("them", "me", labels)).toBe("Teammate");
  });

  it("labelForUid falls back to generic 'Teammate' for a uid not in the map (e.g. a member who joined after labels were built)", () => {
    const labels = buildTeammateLabels(["me"], "me");
    expect(labelForUid("stranger", "me", labels)).toBe("Teammate");
  });
});
