import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Phase 27 Part G / Phase 28 Part 5: static source guard, same
 * discipline as runtimeCommandAuth.test.ts/
 * runtimeVisibilityRecovery.test.ts - a React component using the
 * Firestore-client-SDK-adjacent authedFetch pattern isn't mockable at
 * the unit level in this suite without disproportionate new test
 * infrastructure. The real, live proof is the two-browser chaos test;
 * this locks in that the fix can't silently regress out of the
 * source. Phase 28 moved the actual POST + failure-handling out of
 * sendFollowUp into a separate `submit` function (sendFollowUp now
 * also has to decide whether to submit immediately or queue while
 * busy), so these guards target `submit`, not `sendFollowUp`. Phase 31
 * merged ChatPanel + ActivityFeed into HuddlePanel.tsx. Phase 32 moved
 * the submit/queue/cancel state machine itself out of HuddlePanel.tsx
 * into hooks/useHuddleComposer.ts (so the mobile Conversation overlay
 * can share it instead of a second implementation) - this guard's
 * target path moved with it; the underlying logic is unchanged. The
 * one thing that's still HuddlePanel.tsx's own concern is the JSX
 * (the input must never be disabled while a turn is active), checked
 * separately below against the component, not the hook.
 */
describe("useHuddleComposer - does not silently lose a request on failure (Phase 27 Part G / Phase 28 Part 5)", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "..", "hooks", "useHuddleComposer.ts"), "utf8");
  const submitBody = source.match(/async function submit[\s\S]*?\n {2}\}/)![0];

  it("checks the response before restoring the input, instead of always clearing it silently", () => {
    expect(submitBody).toMatch(/if \(!res\.ok\)/);
  });

  it("restores the typed message back into the input on failure, rather than losing it", () => {
    expect(submitBody).toMatch(/setFollowUp\(message\)/);
  });

  it("surfaces a specific message for the concurrent-turn (409) case", () => {
    expect(submitBody.toLowerCase()).toContain("already working on this project");
  });

  it("Phase 28 Part 5: a submit attempt while a turn is active queues the message instead of discarding it", () => {
    const sendFollowUpBody = source.match(/async function sendFollowUp[\s\S]*?\n {2}\}/)![0];
    expect(sendFollowUpBody).toMatch(/if \(turn\?\.active\)/);
    expect(sendFollowUpBody).toMatch(/setQueued\(message\)/);
  });

  it("Phase 28 Part 5: the queued message auto-sends once the turn stops being active, not on a poll", () => {
    expect(source).toMatch(/wasActive\s*&&\s*!isActive\s*&&\s*queued/);
  });
});

describe("HuddlePanel / MobileConversation - the composer input is never disabled just because a turn is active", () => {
  it("Phase 28 Part 5: HuddlePanel's own input is never gated on turn.active", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "..", "components", "workspace", "HuddlePanel.tsx"), "utf8");
    const inputMatch = source.match(/<input[\s\S]*?\/>/);
    expect(inputMatch, "composer input not found").not.toBeNull();
    expect(inputMatch![0]).not.toMatch(/disabled=\{turn\?\.active\}/);
  });
});
