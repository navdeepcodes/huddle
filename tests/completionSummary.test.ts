import { describe, expect, it } from "vitest";

import { deriveCompletionSummary } from "@/lib/agent/completionSummary";

import type { AgentTurn, TurnMessage, TurnTelemetry } from "@/types/session";

function telemetry(overrides: Partial<TurnTelemetry> = {}): TurnTelemetry {
  return {
    iterations: 1,
    toolCalls: 1,
    successfulActions: 1,
    failedActions: 0,
    iterationDurationsMs: [],
    timeToFirstRunMs: null,
    timeToFirstPreviewMs: null,
    totalDurationMs: null,
    terminationReason: "done",
    repeatedIterations: 0,
    stagnationNudgesSent: 0,
    incompleteObjectiveNudgesSent: 0,
    finishModeNudgesSent: 0,
    blockingPreviewNudgesSent: 0,
    evidenceNudgesSent: 0,
    truncatedNoActionRetries: 0,
    providerFallback: { activated: false, fromProviderId: null, toProviderId: null, reason: null },
    timeToFirstBuildMs: null,
    fileBudgetWarningSent: false,
    buildEarlyNudgeSent: false,
    ...overrides,
  };
}

function turnWith(log: TurnMessage[], overrides: Partial<AgentTurn> = {}): AgentTurn {
  return {
    sessionId: "s1",
    active: false,
    startedAt: 0,
    cancelledAt: null,
    log,
    telemetry: telemetry(overrides.telemetry),
    ...overrides,
  };
}

describe("deriveCompletionSummary", () => {
  it("returns null while the turn is still active", () => {
    const turn = turnWith([{ role: "tool", toolName: "write_file", ok: true, path: "a.js", content: "", createdAt: 1 }], {
      active: true,
    });
    expect(deriveCompletionSummary(turn, new Set(), null)).toBeNull();
  });

  it("returns null when nothing happened this turn (pure Q&A, no tool activity)", () => {
    const turn = turnWith([
      { role: "user", content: "what stack is this?", createdAt: 1 },
      { role: "assistant", content: "Next.js Pages Router.", createdAt: 2 },
    ]);
    expect(deriveCompletionSummary(turn, new Set(), null)).toBeNull();
  });

  it("reports success with done subgoals and verified preview when everything checks out", () => {
    const log: TurnMessage[] = [
      { role: "user", content: "build a blog", createdAt: 1 },
      { role: "tool", toolName: "write_file", ok: true, path: "pages/index.js", content: "", createdAt: 2 },
      { role: "tool", toolName: "view_preview", ok: true, content: "looks good", createdAt: 3 },
    ];
    const turn = turnWith(log, {
      taskState: {
        objective: "build a blog",
        subgoals: [{ description: "Build the homepage", status: "done" }],
        updatedAt: 3,
      },
    });
    const summary = deriveCompletionSummary(turn, new Set(), { previewUrl: "http://x", state: "running" } as never);
    expect(summary).toEqual({
      status: "success",
      headline: "Completed",
      whatItDid: ["Build the homepage"],
      changedFiles: [{ path: "pages/index.js", status: "added" }],
      verified: true,
      previewAvailable: true,
      blocked: [],
      remaining: [],
    });
  });

  it("falls back to a file-count summary when no taskState was ever recorded", () => {
    const log: TurnMessage[] = [
      { role: "user", content: "change the footer year", createdAt: 1 },
      { role: "tool", toolName: "write_file", ok: true, path: "components/Footer.js", content: "", createdAt: 2 },
    ];
    const summary = deriveCompletionSummary(turnWith(log), new Set(), null);
    expect(summary?.whatItDid).toEqual(["Updated 1 file"]);
    expect(summary?.verified).toBe(false);
  });

  it("marks status partial and lists blocked subgoals by their real description, not a paraphrase", () => {
    const log: TurnMessage[] = [
      { role: "user", content: "add stripe checkout", createdAt: 1 },
      { role: "tool", toolName: "write_file", ok: true, path: "pages/checkout.js", content: "", createdAt: 2 },
    ];
    const turn = turnWith(log, {
      telemetry: telemetry({ terminationReason: "blocked" }),
      taskState: {
        objective: "add stripe checkout",
        subgoals: [
          { description: "Build the checkout page", status: "done" },
          { description: "Wire up a real Stripe API key", status: "blocked" },
        ],
        updatedAt: 2,
      },
    });
    const summary = deriveCompletionSummary(turn, new Set(), null);
    expect(summary?.status).toBe("partial");
    expect(summary?.blocked).toEqual(["Wire up a real Stripe API key"]);
    expect(summary?.headline).toBe("Stopped - some work is blocked");
  });

  it("marks status failed on a provider error, distinct from a blocked/partial result", () => {
    const log: TurnMessage[] = [
      { role: "user", content: "build a site", createdAt: 1 },
      { role: "tool", toolName: "run_command", ok: true, content: "", argsSummary: "npm install", createdAt: 2 },
    ];
    const turn = turnWith(log, { telemetry: telemetry({ terminationReason: "provider_error" }) });
    const summary = deriveCompletionSummary(turn, new Set(), null);
    expect(summary?.status).toBe("failed");
    expect(summary?.headline).toBe("Stopped - a provider error occurred");
  });

  it("only counts the LAST view_preview call this turn for verified, not an earlier failed one", () => {
    const log: TurnMessage[] = [
      { role: "user", content: "build a site", createdAt: 1 },
      { role: "tool", toolName: "view_preview", ok: false, content: "crashed", createdAt: 2 },
      { role: "tool", toolName: "write_file", ok: true, path: "a.js", content: "", createdAt: 3 },
      { role: "tool", toolName: "view_preview", ok: true, content: "fixed", createdAt: 4 },
    ];
    const summary = deriveCompletionSummary(turnWith(log), new Set(), null);
    expect(summary?.verified).toBe(true);
  });

  it("never claims verified when no view_preview call happened this turn", () => {
    const log: TurnMessage[] = [
      { role: "user", content: "rename a variable", createdAt: 1 },
      { role: "tool", toolName: "write_file", ok: true, path: "a.js", content: "", createdAt: 2 },
    ];
    const summary = deriveCompletionSummary(turnWith(log), new Set(), null);
    expect(summary?.verified).toBe(false);
  });

  it("reports real presentation-creation evidence in whatItDid, verbatim from the tool result", () => {
    const log: TurnMessage[] = [
      { role: "user", content: "make a 5-slide pitch deck", createdAt: 1 },
      {
        role: "tool",
        toolName: "create_presentation",
        ok: true,
        content: 'Presentation created: "Huddle Pitch Deck" - 5 slides, saved to artifacts/huddle-pitch-deck-abc123.pptx.',
        createdAt: 2,
      },
    ];
    const summary = deriveCompletionSummary(turnWith(log), new Set(), null);
    expect(summary?.whatItDid).toContain(
      'Presentation created: "Huddle Pitch Deck" - 5 slides, saved to artifacts/huddle-pitch-deck-abc123.pptx.'
    );
    expect(summary?.status).toBe("success");
  });

  it("never reports presentation success when the tool call actually failed", () => {
    const log: TurnMessage[] = [
      { role: "user", content: "make a pitch deck", createdAt: 1 },
      {
        role: "tool",
        toolName: "create_presentation",
        ok: false,
        content: "Presentation generation failed: too many slides. The project is otherwise unchanged.",
        createdAt: 2,
      },
    ];
    const summary = deriveCompletionSummary(turnWith(log), new Set(), null);
    expect(summary?.whatItDid.some((line) => line.includes("Presentation created"))).toBe(false);
  });

  it("reports real image-creation evidence in whatItDid, verbatim from the tool result", () => {
    const log: TurnMessage[] = [
      { role: "user", content: "create a hero image", createdAt: 1 },
      {
        role: "tool",
        toolName: "create_image",
        ok: true,
        content: 'Image created: "Hero" - 1536×1024, saved to artifacts/hero-abc123.png.',
        createdAt: 2,
      },
    ];
    const summary = deriveCompletionSummary(turnWith(log), new Set(), null);
    expect(summary?.whatItDid).toContain('Image created: "Hero" - 1536×1024, saved to artifacts/hero-abc123.png.');
    expect(summary?.status).toBe("success");
  });

  it("never reports image success when generation actually failed", () => {
    const log: TurnMessage[] = [
      { role: "user", content: "create a hero image", createdAt: 1 },
      {
        role: "tool",
        toolName: "create_image",
        ok: false,
        content: "Image generation failed: rate-limited. The project is otherwise unchanged.",
        createdAt: 2,
      },
    ];
    const summary = deriveCompletionSummary(turnWith(log), new Set(), null);
    expect(summary?.whatItDid.some((line) => line.includes("Image created"))).toBe(false);
  });

  it("ignores tool activity from a prior turn when finding what happened this turn", () => {
    const log: TurnMessage[] = [
      { role: "user", content: "build a site", createdAt: 1 },
      { role: "tool", toolName: "write_file", ok: true, path: "old.js", content: "", createdAt: 2 },
      { role: "user", content: "add a footer", createdAt: 3 },
      { role: "tool", toolName: "write_file", ok: true, path: "Footer.js", content: "", createdAt: 4 },
    ];
    const summary = deriveCompletionSummary(turnWith(log), new Set(["old.js"]), null);
    expect(summary?.changedFiles).toEqual([{ path: "Footer.js", status: "added" }]);
  });
});
