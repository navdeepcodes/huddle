import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Phase 32: static source guard against a real, live-reproduced bug -
 * a React hydration error from `<button>` nested inside `<button>`.
 * The original mobile hub's PreviewCard and Activity teaser were each
 * one big tap target (a native <button>) that used to embed components
 * with their OWN interactive <button>s (PreviewRecoveryScene's "Try
 * again"/"View details", HuddlePanel's ActivityRow expand/collapse).
 * Confirmed live via the browser's own hydration warning.
 *
 * Phase 32b reworked the hub to be conversation-first (matching the
 * reference screenshots) - OutputCard replaced PreviewCard as the one
 * remaining "whole card is a tap target" surface, so this guard now
 * targets that. The activity timeline itself is no longer wrapped in
 * one big button at all (it's the page's own scrollable content), so
 * ActivityGroupRow's own expand/collapse button is never nested inside
 * anything - guarded here too, so it can't regress back into that
 * shape either.
 */
describe("MobileProjectView - no interactive component nested inside a card's own tap-target <button> (Phase 32/32b)", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "..", "components", "mobile", "MobileProjectView.tsx"), "utf8");

  it("OutputCard's tap-to-open button contains no nested <button> (the iframe/loading state must stay non-interactive)", () => {
    const outputCardBody = source.match(/function OutputCard[\s\S]*?\n}\n/)![0];
    const openButtonBody = outputCardBody.match(/<button onClick=\{onOpen\}[\s\S]*?\n {6}<\/button>/)![0];
    // The match's own opening tag is one legitimate "<button" occurrence - only a SECOND one would mean nesting.
    expect(openButtonBody.split("<button")).toHaveLength(2);
    expect(openButtonBody).not.toMatch(/<PreviewRecoveryScene/);
  });

  it("OutputCard's own 'Open' button and the tap-to-open button are siblings, not nested", () => {
    const outputCardBody = source.match(/function OutputCard[\s\S]*?\n}\n/)![0];
    // The visible "Open" affordance button must appear AFTER the first button's closing tag, not before it closes.
    const firstButtonClose = outputCardBody.indexOf("</button>");
    const openLabelIndex = outputCardBody.indexOf(">\n          Open\n");
    expect(firstButtonClose).toBeGreaterThan(-1);
    expect(openLabelIndex).toBeGreaterThan(firstButtonClose);
  });

  it("ActivityGroupRow's expand/collapse control is never rendered inside another <button>", () => {
    const groupRowBody = source.match(/function ActivityGroupRow[\s\S]*?\n}\n/)![0];
    // The component's own outer element must be a <div>, not a <button> - only the
    // expand/collapse control itself (one level in) is a button.
    const returnBlocks = groupRowBody.match(/return \(\s*<(\w+)/g) ?? [];
    for (const block of returnBlocks) {
      expect(block).not.toMatch(/<button/);
    }
  });
});
