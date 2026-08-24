import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Regression guard for the runtime-command-relay auth fix (2026-08-20).
 *
 * Proven live: reportCommandResult() in RuntimeSession used a plain
 * fetch() to POST to /api/runtime-commands/[commandId]/complete, which
 * never attaches a Firebase ID token. The route calls getVerifiedUid()
 * (see lib/auth/verifyRequest.ts) and correctly rejects unauthenticated
 * requests with 401 - so every real run_command/capture_preview result
 * (3/3 observed live: npm install, dev-server start) failed to report
 * back, leaving its runtimeCommands doc stuck "pending" forever and the
 * whole boot pipeline stalled behind it, with runtimeHost never
 * reaching "running".
 *
 * RuntimeSession is a class that subscribes to live Firestore snapshots
 * (onSnapshot) and drives a real WebContainerRuntime - unit-testing
 * reportCommandResult's actual network call behaviorally would require
 * mocking the Firestore client SDK's onSnapshot/collection/query calls,
 * which nothing in this test suite currently does (the existing
 * runtimeSession.test.ts only exercises startDevServer, a pure function
 * extracted specifically to avoid that scaffolding). A static source
 * guard is the narrowest-appropriate-level test for this class of bug -
 * the same approach already used for the crossOriginIsolated fix, see
 * sessionNavigation.test.ts's own doc comment.
 */
describe("runtime command relay authentication", () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "..", "lib", "runtime", "runtimeSession.ts"),
    "utf8"
  );

  it("imports the authenticated fetch helper", () => {
    expect(source).toMatch(/import\s*\{\s*authedFetch\s*\}\s*from\s*["']@\/lib\/firebase\/authedFetch["']/);
  });

  it("reports command results through authedFetch, not a bare fetch()", () => {
    const match = source.match(/private async reportCommandResult\([\s\S]*?\n {2}\}/);
    expect(match, "reportCommandResult method not found").not.toBeNull();
    const body = match![0];

    expect(body).toMatch(/authedFetch\(`\/api\/runtime-commands\/\$\{commandId\}\/complete`/);
    expect(body).not.toMatch(/(?<!authed)fetch\(`\/api\/runtime-commands/);
  });
});
