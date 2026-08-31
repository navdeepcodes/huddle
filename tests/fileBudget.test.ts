import { describe, expect, it } from "vitest";

import { computeFileBudget, buildFileBudgetWarning, DEFAULT_FILE_BUDGET, BUDGET_EXTENSION } from "@/lib/agent/fileBudget";

/**
 * Phase 42 §2: the code-enforced guardrail against file explosion.
 * Root cause this addresses - Phase 41C's real trace: a 6-section
 * landing page request produced 19 files (8 single-use components + 4
 * data files + scaffold) with the prompt's own over-decomposition
 * warning already in place and unenforced.
 */
describe("computeFileBudget", () => {
  it("with no manifest at all, defaults to a plain landing page's budget", () => {
    expect(computeFileBudget(undefined)).toBe(DEFAULT_FILE_BUDGET);
    expect(computeFileBudget({})).toBe(DEFAULT_FILE_BUDGET);
  });

  it("an explicit fileBudget wins over any other signal", () => {
    expect(computeFileBudget({ fileBudget: 15, targetFiles: ["a.js"], routes: ["/", "/about"] })).toBe(15);
  });

  it("an explicit fileBudget is clamped to a sane range - never a degenerate 0 or a runaway huge number", () => {
    expect(computeFileBudget({ fileBudget: 0 })).toBeGreaterThanOrEqual(3);
    expect(computeFileBudget({ fileBudget: -5 })).toBeGreaterThanOrEqual(3);
    expect(computeFileBudget({ fileBudget: 9999 })).toBeLessThanOrEqual(40);
  });

  it("a stated targetFiles plan sets the budget close to that plan, with a little grace", () => {
    const budget = computeFileBudget({ targetFiles: ["src/App.jsx", "src/styles.css", "src/main.jsx"] });
    expect(budget).toBe(3 + 3); // len + grace
  });

  it("a multi-route manifest with no other signal gets the wider multi-page tier, not the single-page default", () => {
    const budget = computeFileBudget({ routes: ["/", "/about", "/contact"] });
    expect(budget).toBeGreaterThan(DEFAULT_FILE_BUDGET);
  });

  it("a single-route manifest (still just a landing page) does NOT get bumped to the multi-page tier", () => {
    expect(computeFileBudget({ routes: ["/"] })).toBe(DEFAULT_FILE_BUDGET);
  });

  it("no regression for a genuinely complex, larger project - a real stated plan is honored, not capped down to the small default", () => {
    const manyFiles = Array.from({ length: 18 }, (_, i) => `components/Section${i}.js`);
    const budget = computeFileBudget({ targetFiles: manyFiles });
    expect(budget).toBe(18 + 3);
    expect(budget).toBeGreaterThan(DEFAULT_FILE_BUDGET);
  });
});

describe("buildFileBudgetWarning", () => {
  it("names the current count, the budget, and the files that crossed it - never silent, never a rejection", () => {
    const text = buildFileBudgetWarning(11, 8, ["components/Prizes.js"]);
    expect(text).toContain("FILE_BUDGET_WARNING");
    expect(text).toContain("11");
    expect(text).toContain("8");
    expect(text).toContain("components/Prizes.js");
  });

  it("frames itself as a guardrail, not a hard stop, and states the bounded extension", () => {
    const text = buildFileBudgetWarning(9, 8, ["x.js"]);
    expect(text).toContain("guardrail");
    expect(text).toContain(String(8 + BUDGET_EXTENSION));
  });
});
