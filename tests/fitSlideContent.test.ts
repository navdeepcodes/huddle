import { describe, expect, it } from "vitest";

import { fitPresentationPlan, fitSlideContent } from "@/lib/presentations/fitSlideContent";
import type { PresentationPlan } from "@/lib/presentations/schema";

describe("fitSlideContent", () => {
  it("leaves already-short content untouched", () => {
    const slide = fitSlideContent({ type: "title_content", heading: "Short", body: "Also short." });
    expect(slide.heading).toBe("Short");
    expect(slide.body).toBe("Also short.");
  });

  it("truncates an overly long body with an ellipsis, never leaving it raw", () => {
    const slide = fitSlideContent({ type: "title_content", body: "x".repeat(1000) });
    expect(slide.body!.length).toBeLessThanOrEqual(500);
    expect(slide.body!.endsWith("…")).toBe(true);
  });

  it("caps the number of bullets rather than letting the list grow unbounded", () => {
    const bullets = Array.from({ length: 20 }, (_, i) => `Point ${i}`);
    const slide = fitSlideContent({ type: "title_content", bullets });
    expect(slide.bullets!.length).toBeLessThanOrEqual(6);
  });

  it("truncates individual bullets that are themselves too long", () => {
    const slide = fitSlideContent({ type: "title_content", bullets: ["y".repeat(400)] });
    expect(slide.bullets![0].length).toBeLessThanOrEqual(120);
  });

  it("fits both two_column sides independently", () => {
    const slide = fitSlideContent({
      type: "two_column",
      columnLeftBullets: Array.from({ length: 10 }, (_, i) => `L${i}`),
      columnRightBullets: Array.from({ length: 10 }, (_, i) => `R${i}`),
    });
    expect(slide.columnLeftBullets!.length).toBeLessThanOrEqual(6);
    expect(slide.columnRightBullets!.length).toBeLessThanOrEqual(6);
  });

  it("fits a long quote", () => {
    const slide = fitSlideContent({ type: "quote", quote: "q".repeat(500) });
    expect(slide.quote!.length).toBeLessThanOrEqual(260);
  });
});

describe("fitPresentationPlan", () => {
  it("fits the title/subtitle and every slide in one pass", () => {
    const plan: PresentationPlan = {
      title: "T".repeat(200),
      subtitle: "S".repeat(200),
      slides: [{ type: "title_content", body: "B".repeat(1000) }],
    };
    const fitted = fitPresentationPlan(plan);
    expect(fitted.title.length).toBeLessThanOrEqual(90);
    expect(fitted.subtitle!.length).toBeLessThanOrEqual(120);
    expect(fitted.slides[0].body!.length).toBeLessThanOrEqual(500);
  });
});
