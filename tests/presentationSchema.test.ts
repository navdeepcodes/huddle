import { describe, expect, it } from "vitest";

import { validatePresentationPlan } from "@/lib/presentations/schema";

describe("validatePresentationPlan", () => {
  it("accepts a well-formed plan", () => {
    const result = validatePresentationPlan({
      title: "Huddle Pitch Deck",
      subtitle: "Build together",
      slides: [
        { type: "title", heading: "Huddle" },
        { type: "title_content", heading: "The problem", body: "Coding alone is slow." },
        { type: "two_column", columnLeftHeading: "Before", columnLeftBullets: ["Solo work"] },
        { type: "quote", quote: "Real teammates build together." },
        { type: "closing", heading: "Thank you" },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a missing title", () => {
    const result = validatePresentationPlan({ slides: [{ type: "title" }] });
    expect(result.ok).toBe(false);
  });

  it("rejects an empty title", () => {
    const result = validatePresentationPlan({ title: "   ", slides: [{ type: "title" }] });
    expect(result.ok).toBe(false);
  });

  it("rejects an empty slides array", () => {
    const result = validatePresentationPlan({ title: "X", slides: [] });
    expect(result.ok).toBe(false);
  });

  it("rejects a missing slides array", () => {
    const result = validatePresentationPlan({ title: "X" });
    expect(result.ok).toBe(false);
  });

  it("rejects an invalid slide type", () => {
    const result = validatePresentationPlan({ title: "X", slides: [{ type: "video_reel" }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/invalid type/);
  });

  it("rejects a quote slide with no quote text", () => {
    const result = validatePresentationPlan({ title: "X", slides: [{ type: "quote" }] });
    expect(result.ok).toBe(false);
  });

  it("rejects a two_column slide with no content in either column", () => {
    const result = validatePresentationPlan({ title: "X", slides: [{ type: "two_column" }] });
    expect(result.ok).toBe(false);
  });

  it("rejects malformed bullets (not an array of strings)", () => {
    const result = validatePresentationPlan({
      title: "X",
      slides: [{ type: "title_content", bullets: ["ok", 5, null] }],
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a non-object slide", () => {
    const result = validatePresentationPlan({ title: "X", slides: ["not an object"] });
    expect(result.ok).toBe(false);
  });

  it("rejects a runaway number of slides", () => {
    const slides = Array.from({ length: 40 }, () => ({ type: "title_content", heading: "X" }));
    const result = validatePresentationPlan({ title: "X", slides });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/too many/i);
  });

  it("rejects a non-object top-level payload", () => {
    expect(validatePresentationPlan(null).ok).toBe(false);
    expect(validatePresentationPlan("nope").ok).toBe(false);
  });

  it("trims and caps an excessively long title rather than rejecting it", () => {
    const longTitle = "T".repeat(500);
    const result = validatePresentationPlan({ title: longTitle, slides: [{ type: "title" }] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.plan.title.length).toBeLessThanOrEqual(120);
  });
});
