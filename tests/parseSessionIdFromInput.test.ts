import { describe, expect, it } from "vitest";

import { parseSessionIdFromInput } from "@/lib/sessions/parseSessionIdFromInput";

describe("parseSessionIdFromInput", () => {
  it("extracts the id from a full share URL", () => {
    expect(parseSessionIdFromInput("http://localhost:3010/session/abc123XYZ")).toBe("abc123XYZ");
  });

  it("extracts the id from a share URL with trailing query/hash", () => {
    expect(parseSessionIdFromInput("https://huddle.app/session/abc123?ref=share#top")).toBe("abc123");
  });

  it("accepts a bare id pasted directly", () => {
    expect(parseSessionIdFromInput("abc123XYZ")).toBe("abc123XYZ");
  });

  it("trims surrounding whitespace", () => {
    expect(parseSessionIdFromInput("  abc123  ")).toBe("abc123");
  });

  it("returns null for empty input", () => {
    expect(parseSessionIdFromInput("   ")).toBeNull();
  });

  it("returns null for garbage that isn't a plausible id or share URL", () => {
    expect(parseSessionIdFromInput("not a link at all!!")).toBeNull();
  });
});
