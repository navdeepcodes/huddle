import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Phase 32: static source guard against a real, live-reproduced bug -
 * a React hydration error from `<button>` nested inside `<button>`.
 * The mobile hub's PreviewCard and Activity teaser are each one big
 * tap target (a native <button>), but two of the components they used
 * to embed directly (HuddlePanel's ActivityRow, via FeedRow - its own
 * expand/collapse control for multi-item entries - and
 * PreviewRecoveryScene - its own "Try again"/"View details" controls)
 * render their own interactive <button>s. Confirmed live via the
 * browser's own hydration warning during this phase's verification;
 * this guard is what stops it from silently coming back if either
 * card's tap target is ever widened again to include full-fidelity
 * content instead of a read-only summary.
 */
describe("MobileProjectView - no interactive component nested inside the card <button>s (Phase 32)", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "..", "components", "mobile", "MobileProjectView.tsx"), "utf8");

  it("does not render PreviewRecoveryScene (has its own Try again/View details buttons) inside PreviewCard's outer button", () => {
    const previewCardBody = source.match(/function PreviewCard[\s\S]*?\n}\n/)![0];
    expect(previewCardBody).not.toMatch(/<PreviewRecoveryScene/);
  });

  it("does not render FeedRow/ActivityRow (has its own expand/collapse button) inside the Activity teaser's outer button", () => {
    const hubBody = source.match(/export function MobileProjectView[\s\S]*?\n {2}return \(([\s\S]*?)\n {2}\);\n}/)![1];
    const activityButton = hubBody.match(/onClick=\{\(\) => setView\("conversation"\)\}[\s\S]*?<\/button>/)![0];
    expect(activityButton).not.toMatch(/<FeedRow|<ActivityRow/);
  });

  it("PreviewCard's non-ready state uses only BuildingPreviewScene (no interactive children) for every state, including recovering/error", () => {
    const previewCardBody = source.match(/function PreviewCard[\s\S]*?\n}\n/)![0];
    const notReadyBlock = previewCardBody.match(/\{!isReady && \([\s\S]*?\n {8}\)\}/)![0];
    expect(notReadyBlock).toMatch(/<BuildingPreviewScene/);
    expect(notReadyBlock).not.toMatch(/<button/);
  });
});
