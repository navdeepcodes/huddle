import "server-only";

/**
 * Phase 26: ONE prompt, shared by every vision provider (local and
 * external) - a critique's usefulness shouldn't drift depending on
 * which provider happened to answer. Deliberately short and
 * structured (section 5's own framing: "a debugging/quality-control
 * tool, not a design essay generator") - the earlier Gemini-only
 * prompt asked for "a few sentences," which measured live (Phase 25) as
 * 150-250 word paragraphs; this asks for a fixed ISSUES/RECOMMENDATIONS
 * shape instead, which is both more actionable for the agent and
 * cheaper for a local model to produce.
 */
export function buildVisionCritiquePrompt(width: number, height: number): string {
  return `This is a real screenshot (${width}x${height}px) of a web application currently running in a live preview. Evaluate it as a UI/UX debugging tool would, against these:

1. Overall visual quality
2. Layout hierarchy
3. Typography
4. Spacing
5. Alignment
6. Color consistency
7. Component consistency
8. Image quality/relevance
9. Responsiveness, if visible
10. Obvious rendering errors
11. Missing content
12. Whether it reads as a considered, specific product or a generic AI-scaffolded page

Reference actual elements visible in the screenshot, not generic praise or criticism - name the specific thing you're evaluating. Respond concisely, in this exact shape (omit a section only if it's genuinely empty):

ISSUES:
- concrete problem, referencing what's actually visible
- concrete problem, referencing what's actually visible

RECOMMENDATIONS:
- concrete, actionable fix
- concrete, actionable fix

Keep it short - this is a debugging tool, not a design essay. If there's nothing wrong, say so briefly instead of inventing issues.`;
}
