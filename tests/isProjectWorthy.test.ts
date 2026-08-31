import { describe, expect, it } from "vitest";

import { isProjectWorthy } from "@/lib/projects/isProjectWorthy";
import type { Session } from "@/types/session";

function session(overrides: Partial<Session> = {}): Session {
  return { id: "s1", name: "X", ownerId: "u1", memberIds: ["u1"], createdAt: 1, updatedAt: 1, ...overrides };
}

describe("isProjectWorthy", () => {
  it("is false when hasRealFiles is absent", () => {
    expect(isProjectWorthy(session())).toBe(false);
  });

  it("is false when hasRealFiles is explicitly false", () => {
    expect(isProjectWorthy(session({ hasRealFiles: false }))).toBe(false);
  });

  it("is true when hasRealFiles is true", () => {
    expect(isProjectWorthy(session({ hasRealFiles: true }))).toBe(true);
  });
});
