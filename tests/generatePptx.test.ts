import { describe, expect, it } from "vitest";

import { generatePptx } from "@/lib/presentations/generatePptx";
import { fitPresentationPlan } from "@/lib/presentations/fitSlideContent";
import { validatePresentationPlan } from "@/lib/presentations/schema";

import type { PresentationPlan } from "@/lib/presentations/schema";

/** A real ZIP local-file-header signature ("PK\x03\x04") - .pptx is an OOXML ZIP container, so this is genuine structural evidence the output is a real archive, not just "a non-empty string." */
function isValidZipBase64(base64: string): boolean {
  const bytes = Buffer.from(base64.slice(0, 8), "base64");
  return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

const FULL_PLAN: PresentationPlan = {
  title: "Huddle Pitch Deck",
  subtitle: "Build together, ship faster",
  slides: [
    { type: "title", heading: "Huddle", subheading: "Your AI teammate" },
    { type: "title_content", heading: "The problem", body: "Building alone is slow and lonely." },
    { type: "title_content", heading: "Why it matters", bullets: ["Solo dev bottleneck", "Slow iteration", "No real teammate"] },
    { type: "two_column", columnLeftHeading: "Before", columnLeftBullets: ["Manual setup"], columnRightHeading: "After", columnRightBullets: ["Instant build"] },
    { type: "image_content", heading: "The workspace", body: "A real coding environment.", imageCaption: "Screenshot" },
    { type: "section", heading: "How it works" },
    { type: "quote", quote: "Huddle feels like a real teammate.", attribution: "An early user" },
    { type: "closing", heading: "Thank you", body: "Let's build together." },
  ],
};

describe("generatePptx", () => {
  it("produces a real, valid, non-empty PPTX exercising every slide type", async () => {
    const result = await generatePptx(FULL_PLAN);
    expect(result.slideCount).toBe(FULL_PLAN.slides.length);
    expect(result.base64.length).toBeGreaterThan(1000);
    expect(isValidZipBase64(result.base64)).toBe(true);
  });

  it("produces valid output for a minimal one-slide plan", async () => {
    const plan: PresentationPlan = { title: "X", slides: [{ type: "title", heading: "X" }] };
    const result = await generatePptx(plan);
    expect(result.slideCount).toBe(1);
    expect(isValidZipBase64(result.base64)).toBe(true);
  });

  it("handles content-fit long text end to end without throwing or producing invalid output", async () => {
    const raw = {
      title: "T".repeat(500),
      slides: Array.from({ length: 10 }, () => ({
        type: "title_content",
        heading: "H".repeat(300),
        bullets: Array.from({ length: 30 }, (_, i) => `Bullet ${i} `.repeat(20)),
      })),
    };
    const validated = validatePresentationPlan(raw);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const fitted = fitPresentationPlan(validated.plan);
    const result = await generatePptx(fitted);
    expect(result.slideCount).toBe(10);
    expect(isValidZipBase64(result.base64)).toBe(true);
  });

  it("stays comfortably within Firestore's ~1MiB document limit for a realistic deck", async () => {
    const result = await generatePptx(FULL_PLAN);
    const byteLength = Buffer.from(result.base64, "base64").length;
    expect(byteLength).toBeLessThan(900_000);
  });
});
