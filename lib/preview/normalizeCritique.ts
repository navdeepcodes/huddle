import "server-only";

/**
 * Phase 27 Part I.1: the real, live-observed problem (Phase 26's Ember
 * benchmark) - local Qwen (a small, 3.8B model) sometimes doesn't
 * follow "one ISSUES block, one RECOMMENDATIONS block" cleanly, instead
 * repeating both headers several times through its own response (e.g.
 * "### ISSUES: 1... ### RECOMMENDATIONS: 1... ### ISSUES: 5... ###
 * RECOMMENDATIONS: 1..."), each restarting its own numbering. This
 * collapses every occurrence into exactly one ISSUES section and one
 * RECOMMENDATIONS section, preserving every real bullet, deterministic
 * line-classification only (no semantic judgment about which points
 * matter) - matching the same "cheap, deterministic, narrow" discipline
 * as importConventionCheck.ts. If NO recognizable ISSUES/RECOMMENDATIONS
 * header is found at all, the input is returned unchanged - this exists
 * to fix repeated structure, not to impose structure on freeform text.
 */
const HEADER_RE = /^#{0,3}\s*\*{0,2}(ISSUES|RECOMMENDATIONS)\*{0,2}:?\s*$/i;
const BULLET_RE = /^(?:[-*]|\d+[.)])\s+(.*)$/;

export function normalizeCritique(raw: string): string {
  const lines = raw.split("\n");
  const issues: string[] = [];
  const recommendations: string[] = [];
  let current: "issues" | "recommendations" | null = null;
  let sawHeader = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const headerMatch = trimmed.match(HEADER_RE);
    if (headerMatch) {
      sawHeader = true;
      current = headerMatch[1].toUpperCase() === "ISSUES" ? "issues" : "recommendations";
      continue;
    }

    if (!current) continue; // preamble before the first header - not part of either list

    // Only genuine bullet-shaped lines count as a point - a stray
    // non-bulleted sentence under a header is more often closing
    // meta-commentary ("this is intended for a static view...", real,
    // live-observed) than a missed real point, and the prompt itself
    // asks for bullets - dropping it here is what keeps this "concise,
    // actionable," not a transcript of everything the model said.
    const bulletMatch = trimmed.match(BULLET_RE);
    if (!bulletMatch) continue;
    const text = bulletMatch[1].trim();
    if (!text) continue;

    const target = current === "issues" ? issues : recommendations;
    if (!target.includes(text)) target.push(text); // dedup exact repeats across sections
  }

  if (!sawHeader) return raw.trim();

  const parts: string[] = [];
  if (issues.length > 0) {
    parts.push(`ISSUES:\n${issues.map((i) => `- ${i}`).join("\n")}`);
  }
  if (recommendations.length > 0) {
    parts.push(`RECOMMENDATIONS:\n${recommendations.map((r) => `- ${r}`).join("\n")}`);
  }

  return parts.length > 0 ? parts.join("\n\n") : raw.trim();
}
