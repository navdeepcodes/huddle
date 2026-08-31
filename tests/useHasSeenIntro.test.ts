import { describe, expect, it } from "vitest";

import { parseIntroSeen } from "@/hooks/useHasSeenIntro";

describe("parseIntroSeen", () => {
  it("treats the exact stored marker as seen", () => {
    expect(parseIntroSeen("1")).toBe(true);
  });

  it("treats a missing key (never written) as not seen", () => {
    expect(parseIntroSeen(null)).toBe(false);
  });

  it("treats any other stray value as not seen, not a crash", () => {
    expect(parseIntroSeen("true")).toBe(false);
    expect(parseIntroSeen("")).toBe(false);
  });
});
