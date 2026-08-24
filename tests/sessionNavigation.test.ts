import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Regression guard for the cross-origin-isolation fix (2026-08-19).
 *
 * Proven live, side by side, with the identical /session/[id] URL:
 * a direct top-level navigation gives self.crossOriginIsolated === true
 * (WebContainer's SharedArrayBuffer usage works); a client-side
 * router.push transition into the same URL gives false (WebContainer
 * fails immediately with "SharedArrayBuffer transfer requires
 * self.crossOriginIsolated"). crossOriginIsolated is fixed at whatever
 * top-level document the browser actually navigated to - a Next.js
 * client-side transition never re-fetches the document, so it never
 * picks up /session/:sessionId's COOP/COEP header rule (already
 * correctly configured in next.config.ts and unchanged by this fix).
 *
 * This can't be verified in jsdom (it doesn't implement real
 * cross-origin-isolation semantics), so the actual verification is the
 * live browser diagnostic recorded above. This is a source-level
 * guard against silently reintroducing router.push for this specific
 * transition, not a functional test.
 *
 * Phase 32: the navigation call itself moved into a shared
 * `navigateToSession(id)` function (desktop and mobile create-project
 * flows both need it) - same window.location.href mechanism, just a
 * function parameter (`id`) instead of the previous inline
 * `session.id`. The guard below matches either shape.
 */
describe("session creation navigation", () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "..", "app", "page.tsx"),
    "utf8"
  );

  it("does not import next/navigation's router (the reliable signal - router.push itself may appear in prose explaining why not to use it)", () => {
    expect(source).not.toMatch(/from ["']next\/navigation["']/);
    expect(source).not.toContain("useRouter(");
  });

  it("uses a real top-level navigation (window.location) into the session route", () => {
    expect(source).toMatch(/window\.location\.href\s*=\s*`\/session\/\$\{(session\.)?id\}`/);
  });
});
