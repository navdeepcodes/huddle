import { describe, expect, it } from "vitest";
import { normalizeCritique } from "@/lib/preview/normalizeCritique";

/** The exact real text local Qwen returned live during Phase 26's Ember benchmark - not a synthetic fixture. */
const REAL_REPEATED_OUTPUT = `### ISSUES:
1. **Typography**: The font color for "NEW HARCVENT" appears muted and could be more eye-catching.
2. **Spacing**: There are no visible margins or spacing affecting the visibility or readability of content below the main heading.
3. **Color Consistency**: The background is primarily white, which contrasts well with the light blue text but makes it hard to discern finer details against a dark screen.
4. **Alignment**: All elements within this section seem top-aligned, as there are no instances where vertical or horizontal alignment issues are evident from these observations.

### RECOMMENDATIONS:
1. **Typography**:
   - Change "NEW HARCVENT" font color to a brighter and more contrasting shade (e.g., orange) to improve readability.
2. **Alignment**: Review the entire layout for potential misalignment or poor top-aligned elements that may interfere with overall design clarity.

### ISSUES:
5. **Component Consistency**: No specific component like button, heading, or link is clearly consistent against this theme and content style observed in image.

### RECOMMENDATIONS:
1. **Color Gradient**:
   - If there's any inconsistency in color between "NEW HARCVENT" text and other elements not visible ("Shop"), "Our Story" ), ensure it matches the overall color scheme for brand consistency.

### ISSUES:
8. **Responsiveness**:
   - Ensure responsiveness in view mode by checking if elements adjust responsively when viewed on devices of various screen sizes, as responsive design impacts user experience during both web browsing and mobile usage.

### RECOMMENDATIONS:
1. **Responsive Design Tools**: Use tools such as Google's Mobile-Friendly Test or similar to verify how different sections adapt.

### ISSUES:
10. No rendering errors are visible in the screenshot provided here.

### RECOMMENDATIONS:
No specific action needed regarding this section as no actual issues evident for recommendation.

This is intended for a static view of design elements but requires further interaction or visibility against real content and usage to see rendering and usability issues.`;

describe("normalizeCritique (Phase 27 Part I.1)", () => {
  it("collapses repeated ISSUES/RECOMMENDATIONS headers from the real observed Qwen output into exactly one of each", () => {
    const result = normalizeCritique(REAL_REPEATED_OUTPUT);
    expect(result.match(/ISSUES:/g)?.length).toBe(1);
    expect(result.match(/RECOMMENDATIONS:/g)?.length).toBe(1);
  });

  it("preserves every real bullet point's content across the repeated sections", () => {
    const result = normalizeCritique(REAL_REPEATED_OUTPUT);
    expect(result).toContain("Component Consistency");
    expect(result).toContain("Responsiveness");
    expect(result).toContain("Color Gradient");
    expect(result).toContain("Mobile-Friendly Test");
  });

  it("ISSUES section appears before RECOMMENDATIONS in the output", () => {
    const result = normalizeCritique(REAL_REPEATED_OUTPUT);
    expect(result.indexOf("ISSUES:")).toBeLessThan(result.indexOf("RECOMMENDATIONS:"));
  });

  it("drops the trailing prose that isn't inside a recognized section", () => {
    const result = normalizeCritique(REAL_REPEATED_OUTPUT);
    expect(result).not.toContain("This is intended for a static view");
  });

  it("returns already-clean, single-header text unchanged (idempotent on well-formed output)", () => {
    const clean = "ISSUES:\n- Hero heading has insufficient contrast.\n\nRECOMMENDATIONS:\n- Increase hero text contrast.";
    expect(normalizeCritique(clean)).toBe(clean);
  });

  it("returns freeform text with no ISSUES/RECOMMENDATIONS headers unchanged (e.g. Gemini's prose style)", () => {
    const prose = "This page shows a clean hero section with a bold headline and a blue CTA button.";
    expect(normalizeCritique(prose)).toBe(prose);
  });

  it("handles plain '-' bullets, not just numbered ones", () => {
    const result = normalizeCritique(
      "ISSUES:\n- first issue\n\nRECOMMENDATIONS:\n- first fix\n\nISSUES:\n- second issue\n\nRECOMMENDATIONS:\n- second fix"
    );
    expect(result).toContain("first issue");
    expect(result).toContain("second issue");
    expect(result).toContain("first fix");
    expect(result).toContain("second fix");
    expect(result.match(/ISSUES:/g)?.length).toBe(1);
  });

  it("dedups an exact-duplicate bullet repeated across sections", () => {
    const result = normalizeCritique("ISSUES:\n- same issue\n\nISSUES:\n- same issue\n- new issue");
    const occurrences = result.split("same issue").length - 1;
    expect(occurrences).toBe(1);
    expect(result).toContain("new issue");
  });
});
