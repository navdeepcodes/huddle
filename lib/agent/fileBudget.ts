import "server-only";

/**
 * Phase 42: a code-enforced guardrail against file explosion, not
 * another architecture layer. Root cause (see prompt.ts's own §3): the
 * prompt already tells the model not to over-decompose a simple page
 * into one file per named section - Phase 41C's real trace (a
 * hackathon landing page, 6 named sections) still produced 19 files (8
 * single-use components + 4 data files + scaffold) because that
 * guidance is advisory-only. This module is the one small,
 * pure/testable piece that turns "please don't" into a real signal the
 * model sees mid-turn - it never blocks a write, it only warns once
 * the running file count crosses a sensible default (or the model's
 * own stated plan).
 */

export interface FileBudgetManifest {
  fileBudget?: number;
  targetFiles?: string[];
  routes?: string[];
}

/** A plain landing page - the shape of the large majority of Huddle requests observed this session - needs 5-8 files, not 19. */
export const DEFAULT_FILE_BUDGET = 8;
/** A stated route list with more than one entry signals a real multi-page site, not a single landing page. */
const MULTI_PAGE_DEFAULT_BUDGET = 12;
/**
 * Bounded, one-time extension once the default/stated budget is
 * crossed - "allow a bounded extension" per the phase spec, not an
 * unlimited one. Flat, not a multiplier, so it stays predictable
 * regardless of how the base budget was derived.
 */
export const BUDGET_EXTENSION = 6;
/** Clamp for an explicitly model-stated fileBudget - guards against a degenerate value (0, or a suspiciously huge one) without second-guessing a genuinely large, justified project. */
const MIN_STATED_BUDGET = 3;
const MAX_STATED_BUDGET = 40;

/**
 * Pure. No manifest at all -> DEFAULT_FILE_BUDGET (most Huddle
 * requests are exactly this shape). An explicit fileBudget wins if
 * present (clamped). Otherwise a stated targetFiles list implies a
 * budget close to that plan, with a little grace (the model didn't
 * necessarily think of every file up front - a data file, an extra
 * small component). A multi-route manifest with no other signal gets
 * the wider default tier instead of the single-page one.
 */
export function computeFileBudget(manifest: FileBudgetManifest | undefined): number {
  if (!manifest) return DEFAULT_FILE_BUDGET;

  if (typeof manifest.fileBudget === "number" && Number.isFinite(manifest.fileBudget)) {
    return Math.min(MAX_STATED_BUDGET, Math.max(MIN_STATED_BUDGET, Math.round(manifest.fileBudget)));
  }

  if (Array.isArray(manifest.targetFiles) && manifest.targetFiles.length > 0) {
    return manifest.targetFiles.length + 3;
  }

  if (Array.isArray(manifest.routes) && manifest.routes.length > 1) {
    return MULTI_PAGE_DEFAULT_BUDGET;
  }

  return DEFAULT_FILE_BUDGET;
}

/**
 * Non-blocking by design (phase spec: "DO NOT blindly reject the
 * write"). Appended to the write_file tool result that first crosses
 * the budget - the model sees it as part of the SAME result it just
 * got, not a separate turn. Asks for a decision, doesn't make one:
 * consolidate, or state why the extra files are genuinely needed.
 */
export function buildFileBudgetWarning(currentCount: number, budget: number, newlyWrittenPaths: string[]): string {
  return (
    ` FILE_BUDGET_WARNING: this turn has now written ${currentCount} files, past the ${budget}-file guideline for a project this size ` +
    `(most recently: ${newlyWrittenPaths.join(", ")}). This is a guardrail, not a target - having budget left is not a reason to use it. ` +
    `Before writing more: could any of these live as sections inside a page you already have, or as inline data instead of a separate file? ` +
    `If genuinely reused, independently complex, or the user explicitly asked for a larger structure, continue - up to roughly ${budget + BUDGET_EXTENSION} files total is still reasonable for a justified case - otherwise consolidate now rather than adding more.`
  );
}
