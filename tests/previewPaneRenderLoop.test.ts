import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Phase 30B: static source guard, same discipline as chatPanel.test.ts
 * - a React infinite-render-loop bug isn't something this codebase's
 * test suite can reproduce directly (no rendering harness is set up
 * for React components here). Live-reproduced on every fresh session
 * load: "Too many re-renders" - PreviewPane compared the RAW
 * `host?.previewUrl` (which is `undefined` while host is still null,
 * the normal state before Firestore data arrives) against a `useState`
 * value that had been normalized to `null` via `?? null`. `undefined
 * !== null` is true forever, so the render-time state-adjustment
 * pattern fired on every single render while host was null - which is
 * every fresh page load, before the runtimeHost doc arrives.
 *
 * The fix computes the normalized value into ONE local variable used
 * for both the comparison and the setState call, so the two sides
 * can't drift into different types again. This guard fails if that
 * discipline regresses - specifically, if a raw `host?.previewUrl`
 * (or `host!.previewUrl`) ever appears directly in the render-time
 * comparison against `prevPreviewUrl` again, instead of the
 * normalized local variable.
 */
describe("PreviewPane - no unnormalized optional-chain comparison against derived state (Phase 30B)", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "..", "components", "workspace", "PreviewPane.tsx"), "utf8");

  it("computes previewUrl as a single normalized (?? null) value before any comparison against prevPreviewUrl", () => {
    const previewUrlDecl = source.match(/const previewUrl = ([^;]+);/);
    expect(previewUrlDecl, "previewUrl declaration not found").not.toBeNull();
    expect(previewUrlDecl![1]).toMatch(/host\?\.previewUrl\s*\?\?\s*null/);
  });

  it("the render-time comparison and its setState both use the normalized `previewUrl` variable, never a raw host?.previewUrl/host!.previewUrl", () => {
    const comparisonBlock = source.match(/if \(previewUrl !== prevPreviewUrl\) \{[\s\S]*?\n {2}\}/);
    expect(comparisonBlock, "the previewUrl !== prevPreviewUrl block was not found").not.toBeNull();
    expect(comparisonBlock![0]).not.toMatch(/host\?\.previewUrl|host!\.previewUrl/);
  });

  it("useState's initializer for prevPreviewUrl is seeded from the same normalized previewUrl variable, not a separately-computed value", () => {
    const stateDecl = source.match(/const \[prevPreviewUrl, setPrevPreviewUrl\] = useState\(([^)]+)\)/);
    expect(stateDecl, "prevPreviewUrl useState call not found").not.toBeNull();
    expect(stateDecl![1].trim()).toBe("previewUrl");
  });
});
