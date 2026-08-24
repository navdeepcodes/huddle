import { beforeEach, describe, expect, it, vi } from "vitest";

import { AgentProviderError } from "@/lib/agent/provider";

import type { AgentModelProvider, AgentStepResult } from "@/lib/agent/provider";
import type { ChatCompletionMessageToolCall } from "openai/resources/chat/completions";

/**
 * Fake Firestore covering everything loop.ts (and, transitively,
 * fileStore.ts) touches: doc get/set/update for agentTurns, and
 * collection/where/batch for sessionFiles. One shared in-memory store,
 * same pattern as tests/runtimeHostAdmin.test.ts and
 * tests/fileStore.test.ts.
 */
function makeFakeAdminDb() {
  const stores = new Map<string, Map<string, Record<string, unknown>>>();

  function collectionStore(name: string) {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name)!;
  }

  function docRef(collectionName: string, id: string) {
    const store = collectionStore(collectionName);
    return {
      id,
      async get() {
        return { exists: store.has(id), data: () => store.get(id) };
      },
      async set(data: Record<string, unknown>) {
        store.set(id, data);
      },
      async update(partial: Record<string, unknown>) {
        store.set(id, { ...(store.get(id) ?? {}), ...partial });
      },
      async delete() {
        store.delete(id);
      },
    };
  }

  function collection(name: string) {
    return {
      doc: (id: string) => docRef(name, id),
      where: (field: string, _op: string, value: unknown) => ({
        async get() {
          const store = collectionStore(name);
          const docs = Array.from(store.entries())
            .filter(([, data]) => data[field] === value)
            .map(([id, data]) => ({ data: () => data, id }));
          return { docs };
        },
      }),
    };
  }

  function batch() {
    const pending: Array<{ ref: ReturnType<typeof docRef>; data: Record<string, unknown>; op: "set" | "update" | "delete" }> = [];
    return {
      set(ref: ReturnType<typeof docRef>, data: Record<string, unknown>) {
        pending.push({ ref, data, op: "set" });
      },
      update(ref: ReturnType<typeof docRef>, data: Record<string, unknown>) {
        pending.push({ ref, data, op: "update" });
      },
      delete(ref: ReturnType<typeof docRef>) {
        pending.push({ ref, data: {}, op: "delete" });
      },
      async commit() {
        for (const { ref, data, op } of pending) {
          if (op === "delete") await ref.delete();
          else if (op === "update") await ref.update(data);
          else await ref.set(data);
        }
      },
    };
  }

  return { stores, adminDb: { collection, batch } };
}

const fake = makeFakeAdminDb();

vi.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return fake.adminDb;
  },
}));

/**
 * Controllable fake provider: reads from a mutable queue array + index
 * that the test controls from outside. loop.ts's AGENT_PROVIDERS is a
 * module-level constant evaluated once at import time, so the mock
 * must be one long-lived object whose behavior changes via external
 * mutable state (reset per test in beforeEach) - not a new object
 * created per access, which loop.ts would never see past its first
 * (empty-queue) read.
 */
function queueProvider(id: string, state: { queue: Array<AgentStepResult | Error>; index: number }): AgentModelProvider {
  return {
    id,
    displayName: id,
    model: "test-model",
    generateStep: vi.fn().mockImplementation(async () => {
      const next = state.queue[state.index++];
      if (next === undefined) throw new Error(`${id}: queue exhausted`);
      if (next instanceof Error) throw next;
      return next;
    }),
  };
}

function writeFileStep(callId: string, path: string, content: string): AgentStepResult {
  return {
    message: {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: callId,
          type: "function",
          function: { name: "write_file", arguments: JSON.stringify({ path, content, reason: "test" }) },
        },
      ] as ChatCompletionMessageToolCall[],
    },
    truncated: false,
    usage: null,
  };
}

function viewPreviewStep(callId: string): AgentStepResult {
  return {
    message: {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: callId,
          type: "function",
          function: { name: "view_preview", arguments: JSON.stringify({ reason: "test" }) },
        },
      ] as ChatCompletionMessageToolCall[],
    },
    truncated: false,
    usage: null,
  };
}

function doneStep(text: string): AgentStepResult {
  return { message: { role: "assistant", content: text }, truncated: false, usage: null };
}

function updateProgressStep(
  callId: string,
  objective: string,
  subgoals: Array<{ description: string; status: string }>,
  projectContract?: Record<string, string>
): AgentStepResult {
  return {
    message: {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: callId,
          type: "function",
          function: { name: "update_progress", arguments: JSON.stringify({ objective, subgoals, projectContract }) },
        },
      ] as ChatCompletionMessageToolCall[],
    },
    truncated: false,
    usage: null,
  };
}

const NO_ALIAS_CONTRACT = {
  framework: "Next.js 15",
  router: "Pages Router",
  language: "JavaScript",
  styling: "Tailwind CSS v4",
  pathAliases: "NONE",
  importConvention: "Relative imports",
  packageManager: "npm",
};

const REAL_ALIAS_CONTRACT = {
  ...NO_ALIAS_CONTRACT,
  pathAliases: "@/* -> ./*",
  importConvention: "Alias imports (@/...)",
};

/** A response cut off by finish_reason "length" that still emitted some visible text first, no tool call. */
function truncatedWithPartialContentStep(text: string): AgentStepResult {
  return { message: { role: "assistant", content: text }, truncated: true, usage: null };
}

const nemotronState = { queue: [] as Array<AgentStepResult | Error>, index: 0 };
const deepseekState = { queue: [] as Array<AgentStepResult | Error>, index: 0 };

function setNemotronQueue(queue: Array<AgentStepResult | Error>) {
  nemotronState.queue = queue;
  nemotronState.index = 0;
}
function setDeepseekQueue(queue: Array<AgentStepResult | Error>) {
  deepseekState.queue = queue;
  deepseekState.index = 0;
}

/**
 * Phase 29: loop.ts no longer imports the providers directly - it
 * resolves them per turn via resolveAgentProviders(uid) (personal
 * credential, or the platform fallback). These tests are about the
 * agent LOOP's behavior (continuation, taskState, completion gate,
 * etc.), not credential resolution (that's providerResolution.test.ts/
 * credentialStore.test.ts's job) - mocking resolveAgentProviders
 * itself to return the same controllable fake providers, ignoring
 * whichever uid loop.ts passes, keeps every existing test's intent
 * unchanged.
 */
vi.mock("@/lib/agent/providerResolution", () => ({
  resolveAgentProviders: vi.fn().mockImplementation(async () => ({
    providers: [queueProvider("nvidia", nemotronState), queueProvider("deepseek", deepseekState)],
    nemotronSource: "platform",
  })),
}));

/**
 * Phase 21: executeTool's own internals (view_preview's bounded wait,
 * run_command's readiness check, etc.) are already covered by
 * viewPreview.test.ts/runtimeSession.test.ts - this mock only needs to
 * control what loop.ts's `otherCalls` branch sees back for a
 * view_preview call, since that's what lastViewPreviewOk tracking and
 * the blocking-preview completion gate actually react to.
 */
const executeToolState: { viewPreviewResult: { ok: boolean; content: string } } = {
  viewPreviewResult: { ok: true, content: "Screenshot captured (1280x800).\n\nLooks good." },
};
function setViewPreviewResult(result: { ok: boolean; content: string }) {
  executeToolState.viewPreviewResult = result;
}
vi.mock("@/lib/agent/executeTool", () => ({
  executeTool: vi.fn().mockImplementation(async (_sessionId: string, call: ChatCompletionMessageToolCall) => {
    if (call.type === "function" && call.function.name === "view_preview") {
      return executeToolState.viewPreviewResult;
    }
    return { ok: true, content: "ok" };
  }),
}));

const { runAgentTurn } = await import("@/lib/agent/loop");

function turnDoc(sessionId: string) {
  return fake.stores.get("agentTurns")?.get(sessionId) as
    | {
        log: Array<{ role: string; content: string | null }>;
        providerMessages?: unknown[];
        active: boolean;
        telemetry: {
          terminationReason: string | null;
          repeatedIterations: number;
          stagnationNudgesSent: number;
          incompleteObjectiveNudgesSent: number;
          finishModeNudgesSent: number;
          blockingPreviewNudgesSent: number;
        };
        taskState?: {
          objective: string;
          subgoals: Array<{ description: string; status: string }>;
          projectContract?: Record<string, string>;
          updatedAt: number;
        };
      }
    | undefined;
}

function sessionFiles(sessionId: string) {
  return Array.from((fake.stores.get("sessionFiles") ?? new Map()).values()).filter(
    (f) => (f as { sessionId: string }).sessionId === sessionId
  ) as Array<{ path: string; content: string }>;
}

beforeEach(() => {
  fake.stores.clear();
  setNemotronQueue([]);
  setDeepseekQueue([]);
  setViewPreviewResult({ ok: true, content: "Screenshot captured (1280x800).\n\nLooks good." });
});

describe("runAgentTurn - continuation context (Phase 15, Phase 6 regressions)", () => {
  it("1. AEREN -> follow-up remains AEREN, not the system prompt's own worked example", async () => {
    setNemotronQueue([doneStep("Building the AEREN sneaker site.")]);
    await runAgentTurn("s-aeren", "Build a premium ecommerce website for a fictional luxury sneaker brand called AEREN.", "test-uid");

    setNemotronQueue([doneStep("Continuing AEREN.")]);
    await runAgentTurn("s-aeren", "please finish this", "test-uid");

    const doc = turnDoc("s-aeren");
    const providerMessages = doc?.providerMessages as Array<{ role: string; content: string }>;
    const userMessages = providerMessages.filter((m) => m.role === "user");
    expect(userMessages[0].content).toContain("AEREN");
    expect(userMessages[0].content).toContain("sneaker");
    // The follow-up call actually saw the original brief in its own input.
  });

  it("2. FORM/01 -> follow-up remains FORM/01", async () => {
    setNemotronQueue([doneStep("Building FORM/01.")]);
    await runAgentTurn("s-form01", "Build a cinematic architecture publication called FORM/01.", "test-uid");

    setNemotronQueue([doneStep("Continuing FORM/01.")]);
    await runAgentTurn("s-form01", "please continue", "test-uid");

    const providerMessages = turnDoc("s-form01")?.providerMessages as Array<{ role: string; content: string }>;
    const userMessages = providerMessages.filter((m) => m.role === "user");
    expect(userMessages[0].content).toContain("FORM/01");
  });

  it("3. two simultaneous sessions cannot cross-contaminate context", async () => {
    setNemotronQueue([doneStep("ok")]);
    await runAgentTurn("s-a", "Build a site for brand A.", "test-uid");
    setNemotronQueue([doneStep("ok")]);
    await runAgentTurn("s-b", "Build a site for brand B.", "test-uid");

    setNemotronQueue([doneStep("ok")]);
    await runAgentTurn("s-a", "continue", "test-uid");
    setNemotronQueue([doneStep("ok")]);
    await runAgentTurn("s-b", "continue", "test-uid");

    const aMessages = turnDoc("s-a")?.providerMessages as Array<{ role: string; content: string }>;
    const bMessages = turnDoc("s-b")?.providerMessages as Array<{ role: string; content: string }>;

    expect(aMessages.some((m) => m.content?.includes("brand A"))).toBe(true);
    expect(aMessages.some((m) => m.content?.includes("brand B"))).toBe(false);
    expect(bMessages.some((m) => m.content?.includes("brand B"))).toBe(true);
    expect(bMessages.some((m) => m.content?.includes("brand A"))).toBe(false);
  });

  it("4. provider retry (transient failure then success within the same turn) preserves original task context", async () => {
    setNemotronQueue([
      new AgentProviderError("nvidia", "network", "500", true),
      doneStep("recovered and built the Ember coffee site"),
    ]);
    await runAgentTurn("s-ember", "Build a simple React website for a coffee brand called Ember.", "test-uid");

    const providerMessages = turnDoc("s-ember")?.providerMessages as Array<{ role: string; content: string }>;
    expect(providerMessages.some((m) => m.content?.includes("Ember"))).toBe(true);
    expect(turnDoc("s-ember")?.log.some((m) => m.content?.includes("recovered"))).toBe(true);
  });

  it("5. provider fallback (primary exhausted, secondary serves the step) preserves original task context", async () => {
    setNemotronQueue([
      new AgentProviderError("nvidia", "network", "500", true),
      new AgentProviderError("nvidia", "network", "500", true),
      new AgentProviderError("nvidia", "network", "500", true),
    ]);
    setDeepseekQueue([doneStep("deepseek finished the Ember site")]);

    await runAgentTurn("s-ember2", "Build a simple React website for a coffee brand called Ember.", "test-uid");

    const providerMessages = turnDoc("s-ember2")?.providerMessages as Array<{ role: string; content: string }>;
    expect(providerMessages.some((m) => m.content?.includes("Ember"))).toBe(true);
    expect(turnDoc("s-ember2")?.log.some((m) => m.content?.includes("deepseek finished"))).toBe(true);
  });
});

describe("runAgentTurn - tool-call safety (Phase 15, Phase 2 test 5)", () => {
  it("a successful write_file is never re-executed by a later provider failure in the same turn", async () => {
    setNemotronQueue([
      writeFileStep("call-1", "index.js", "// first file"),
      new AgentProviderError("nvidia", "network", "500", true),
      new AgentProviderError("nvidia", "network", "500", true),
      new AgentProviderError("nvidia", "network", "500", true),
    ]);
    setDeepseekQueue([
      new AgentProviderError("deepseek", "network", "500", true),
      new AgentProviderError("deepseek", "network", "500", true),
      new AgentProviderError("deepseek", "network", "500", true),
    ]);

    await runAgentTurn("s-dup", "Build something.", "test-uid");

    const files = sessionFiles("s-dup");
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("index.js");
    expect(files[0].content).toBe("// first file");
  });

  it("a continuation turn does not re-run a tool call from a prior, already-completed turn", async () => {
    setNemotronQueue([writeFileStep("call-1", "index.js", "// v1"), doneStep("done")]);
    await runAgentTurn("s-cont", "Build something.", "test-uid");
    expect(sessionFiles("s-cont")).toHaveLength(1);

    setNemotronQueue([writeFileStep("call-2", "about.js", "// v2"), doneStep("done")]);
    await runAgentTurn("s-cont", "add an about page", "test-uid");

    const files = sessionFiles("s-cont");
    expect(files.map((f) => f.path).sort()).toEqual(["about.js", "index.js"]);
    // index.js's content is exactly what turn 1 wrote - never touched again.
    expect(files.find((f) => f.path === "index.js")?.content).toBe("// v1");
  });
});

describe("runAgentTurn - completion-state detection (Phase 15, Phase 8 regression)", () => {
  it("a truncated response with partial visible content is reported as truncated_no_action, not done - the exact Benchmark B failure (stated an unfinished plan, no tool call, cut off by finish_reason length)", async () => {
    setNemotronQueue([
      truncatedWithPartialContentStep("Now I need to create the collection page with filters, sorting, and product grid."),
    ]);

    await runAgentTurn("s-truncated", "Build a premium ecommerce website for a fictional luxury sneaker brand called AEREN.", "test-uid");

    expect(turnDoc("s-truncated")?.telemetry.terminationReason).toBe("truncated_no_action");
    expect(
      turnDoc("s-truncated")?.log.some((m) => m.content?.includes("ran out of response budget"))
    ).toBe(true);
  });

  it("an untruncated response with content and no tool call is still correctly reported as done - a genuine deliberate stop is not misclassified as truncation", async () => {
    setNemotronQueue([doneStep("The site is complete and verified.")]);

    await runAgentTurn("s-genuinely-done", "Build a simple site.", "test-uid");

    expect(turnDoc("s-genuinely-done")?.telemetry.terminationReason).toBe("done");
  });

  it("a truncated response with NO content at all is still reported as truncated_no_action (the original, already-correct case)", async () => {
    setNemotronQueue([
      { message: { role: "assistant", content: null }, truncated: true, usage: null },
    ]);

    await runAgentTurn("s-truncated-empty", "Build a simple site.", "test-uid");

    expect(turnDoc("s-truncated-empty")?.telemetry.terminationReason).toBe("truncated_no_action");
  });
});

/**
 * Phase 16: the core invariant is that the user's original objective
 * outranks any subproblem the agent runs into pursuing it - see
 * taskProgress.ts's own doc comment. These are the 10 regression
 * scenarios that phase's own brief requires, using deterministic
 * mocked provider steps (never a live model), same discipline as the
 * Phase 15 suite above.
 */
describe("runAgentTurn - long-horizon task tracking (Phase 16)", () => {
  it("1. the original objective survives multiple intervening iterations untouched", async () => {
    setNemotronQueue([
      updateProgressStep("p1", "Build a coffee site and add a pricing section", [
        { description: "Build homepage", status: "in_progress" },
        { description: "Add pricing section", status: "pending" },
      ]),
      writeFileStep("w1", "index.html", "<html><body>v1</body></html>"),
      writeFileStep("w2", "index.html", "<html><body>v2 - added hero</body></html>"),
      updateProgressStep("p2", "Build a coffee site and add a pricing section", [
        { description: "Build homepage", status: "done" },
        { description: "Add pricing section", status: "done" },
      ]),
      doneStep("Coffee site with pricing section is complete."),
    ]);

    await runAgentTurn("s-survive", "Build a coffee site and add a pricing section.", "test-uid");

    const doc = turnDoc("s-survive");
    expect(doc?.taskState?.objective).toBe("Build a coffee site and add a pricing section");
    expect(doc?.telemetry.terminationReason).toBe("done");
  });

  it("2. a subproblem (blocked subgoal) never silently drops or replaces an unrelated pending subgoal", async () => {
    setNemotronQueue([
      updateProgressStep("p1", "Build a coffee site and add a pricing section", [
        { description: "Build homepage", status: "in_progress" },
        { description: "Add pricing section", status: "pending" },
      ]),
      // The model hits a CSS blocker on the homepage subgoal and
      // re-reports its plan - the objective string and the unrelated
      // pending subgoal must both still be there afterward.
      updateProgressStep("p2", "Build a coffee site and add a pricing section", [
        { description: "Build homepage", status: "blocked" },
        { description: "Add pricing section", status: "pending" },
      ]),
      doneStep("stopping for now"),
      doneStep("stopping for now, final"),
    ]);

    await runAgentTurn("s-no-replace", "Build a coffee site and add a pricing section.", "test-uid");

    const doc = turnDoc("s-no-replace");
    expect(doc?.taskState?.objective).toBe("Build a coffee site and add a pricing section");
    expect(doc?.taskState?.subgoals.find((s) => s.description === "Add pricing section")?.status).toBe("pending");
    expect(doc?.taskState?.subgoals.find((s) => s.description === "Build homepage")?.status).toBe("blocked");
  });

  it("3. progress (differing results across iterations) is never flagged as stagnation", async () => {
    setNemotronQueue([
      writeFileStep("w1", "app.css", "body { color: red; }"),
      writeFileStep("w2", "app.css", "body { color: blue; }"),
      writeFileStep("w3", "app.css", "body { color: green; }"),
      doneStep("styled"),
    ]);

    await runAgentTurn("s-progress", "Style the page.", "test-uid");

    const doc = turnDoc("s-progress");
    expect(doc?.telemetry.stagnationNudgesSent).toBe(0);
    expect(doc?.telemetry.repeatedIterations).toBe(0);
  });

  it("4. repeated identical no-progress iterations trigger a bounded strategy-escalation nudge", async () => {
    setNemotronQueue([
      writeFileStep("w1", "tailwind.config.js", "module.exports = { content: [] }"),
      writeFileStep("w2", "tailwind.config.js", "module.exports = { content: [] }"),
      writeFileStep("w3", "tailwind.config.js", "module.exports = { content: [] }"),
      doneStep("moving on"),
    ]);

    await runAgentTurn("s-stagnant", "Fix the CSS loading problem.", "test-uid");

    const doc = turnDoc("s-stagnant");
    expect(doc?.telemetry.repeatedIterations).toBeGreaterThanOrEqual(1);
    expect(doc?.telemetry.stagnationNudgesSent).toBe(1);
    expect(doc?.log.some((m) => m.content?.includes("isn't working"))).toBe(true);
  });

  it("5. independent work continues on an unblocked subgoal while another stays genuinely blocked, and completion is reported as blocked, not falsely done", async () => {
    setNemotronQueue([
      updateProgressStep("p1", "Build a coffee site and add a pricing section", [
        { description: "Build homepage", status: "done" },
        { description: "Fix Tailwind CSS loading", status: "blocked" },
        { description: "Add pricing section", status: "pending" },
      ]),
      writeFileStep("w1", "pricing.html", "<section>Pricing</section>"),
      updateProgressStep("p2", "Build a coffee site and add a pricing section", [
        { description: "Build homepage", status: "done" },
        { description: "Fix Tailwind CSS loading", status: "blocked" },
        { description: "Add pricing section", status: "done" },
      ]),
      doneStep("Pricing section added; CSS loading is still blocked."),
    ]);

    await runAgentTurn("s-independent", "Build a coffee site and add a pricing section.", "test-uid");

    const files = sessionFiles("s-independent");
    expect(files.some((f) => f.path === "pricing.html")).toBe(true);

    const doc = turnDoc("s-independent");
    expect(doc?.taskState?.subgoals.find((s) => s.description === "Add pricing section")?.status).toBe("done");
    // Everything not blocked is genuinely done, but one real blocker
    // remains - never silently reported as full success.
    expect(doc?.telemetry.terminationReason).toBe("blocked");
  });

  it("6. a premature 'done' is rejected once (nudged) while a required subgoal is still pending, then bounded", async () => {
    setNemotronQueue([
      updateProgressStep("p1", "Build X and Y", [
        { description: "Build X", status: "done" },
        { description: "Build Y", status: "pending" },
      ]),
      doneStep("I'm done"),
      doneStep("Actually done now"),
    ]);

    await runAgentTurn("s-incomplete", "Build X and Y.", "test-uid");

    const doc = turnDoc("s-incomplete");
    expect(doc?.telemetry.incompleteObjectiveNudgesSent).toBe(1);
    expect(doc?.log.some((m) => m.content?.includes("Build Y") && m.content?.includes("unfinished"))).toBe(true);
    // Bounded to one nudge - a model that insists it's done a second
    // time isn't bounced forever.
    expect(doc?.telemetry.terminationReason).toBe("done");
  });

  it("7. a truncated response is still reported as truncated_no_action even with unresolved subgoals tracked - the completion gate never intercepts it", async () => {
    setNemotronQueue([
      updateProgressStep("p1", "Build a big site", [
        { description: "Build homepage", status: "in_progress" },
        { description: "Add footer", status: "pending" },
      ]),
      truncatedWithPartialContentStep("Now I need to build the footer with links and..."),
    ]);

    await runAgentTurn("s-truncated-taskstate", "Build a big site.", "test-uid");

    const doc = turnDoc("s-truncated-taskstate");
    expect(doc?.telemetry.terminationReason).toBe("truncated_no_action");
    expect(doc?.telemetry.incompleteObjectiveNudgesSent).toBe(0);
  });

  it("8. task state persists across a continuation turn even when the follow-up never calls update_progress again", async () => {
    setNemotronQueue([
      updateProgressStep("p1", "Build a coffee site", [{ description: "Build homepage", status: "done" }]),
      doneStep("Homepage built."),
    ]);
    await runAgentTurn("s-cont-taskstate", "Build a coffee site.", "test-uid");
    expect(turnDoc("s-cont-taskstate")?.taskState?.objective).toBe("Build a coffee site");

    setNemotronQueue([doneStep("Still just the homepage, all good.")]);
    await runAgentTurn("s-cont-taskstate", "looks good, anything else?", "test-uid");

    const doc = turnDoc("s-cont-taskstate");
    expect(doc?.taskState?.objective).toBe("Build a coffee site");
    expect(doc?.taskState?.subgoals).toHaveLength(1);
  });

  it("9. task state survives a provider retry/fallback within the same turn", async () => {
    setNemotronQueue([
      updateProgressStep("p1", "Build the Ember coffee site", [
        { description: "Build homepage", status: "in_progress" },
      ]),
      new AgentProviderError("nvidia", "network", "500", true),
      doneStep("recovered, homepage built"),
    ]);

    await runAgentTurn("s-retry-taskstate", "Build the Ember coffee site.", "test-uid");

    const doc = turnDoc("s-retry-taskstate");
    expect(doc?.taskState?.objective).toBe("Build the Ember coffee site");
  });

  it("10. task state from one session never leaks into a different session", async () => {
    setNemotronQueue([
      updateProgressStep("p1", "Session A objective", [{ description: "a", status: "done" }]),
      doneStep("done a"),
    ]);
    await runAgentTurn("s-isolated-a", "Session A objective.", "test-uid");

    setNemotronQueue([
      updateProgressStep("p1", "Session B objective", [{ description: "b", status: "done" }]),
      doneStep("done b"),
    ]);
    await runAgentTurn("s-isolated-b", "Session B objective.", "test-uid");

    expect(turnDoc("s-isolated-a")?.taskState?.objective).toBe("Session A objective");
    expect(turnDoc("s-isolated-b")?.taskState?.objective).toBe("Session B objective");
  });
});

/**
 * Phase 18: the Project Contract mechanism, integrated end-to-end
 * through the same runAgentTurn loop the Phase 16/17 suites above
 * exercise - see checkImportConventions's own doc comment for the root
 * cause and taskProgress.test.ts/importConventionCheck.test.ts for the
 * pure-function-level coverage of the parsing/checking logic itself.
 */
describe("runAgentTurn - project contract (Phase 18)", () => {
  it("1. an @/ import is rejected (never persisted) once the contract declares no alias, and the agent can retry with a relative import", async () => {
    setNemotronQueue([
      updateProgressStep("p1", "Build a site", [{ description: "Build homepage", status: "in_progress" }], NO_ALIAS_CONTRACT),
      writeFileStep("w1", "pages/index.js", 'import Header from "@/components/Header";\nexport default function Home() { return null; }'),
      writeFileStep("w2", "pages/index.js", 'import Header from "../components/Header";\nexport default function Home() { return null; }'),
      doneStep("done"),
    ]);

    await runAgentTurn("s-no-alias", "Build a site.", "test-uid");

    const files = sessionFiles("s-no-alias");
    expect(files).toHaveLength(1);
    expect(files[0].content).toContain("../components/Header");
    expect(files[0].content).not.toContain('"@/components/Header"');

    const doc = turnDoc("s-no-alias");
    expect(doc?.log.some((m) => m.content?.includes("INVALID_TOOL_ARGUMENTS") && m.content?.includes("@/components/Header"))).toBe(true);
  });

  it("2. an @/ import is allowed when the contract declares a real, configured alias", async () => {
    setNemotronQueue([
      updateProgressStep("p1", "Build a site", [{ description: "Build homepage", status: "in_progress" }], REAL_ALIAS_CONTRACT),
      writeFileStep("w1", "pages/index.js", 'import Header from "@/components/Header";\nexport default function Home() { return null; }'),
      doneStep("done"),
    ]);

    await runAgentTurn("s-real-alias", "Build a site.", "test-uid");

    const files = sessionFiles("s-real-alias");
    expect(files).toHaveLength(1);
    expect(files[0].content).toContain('"@/components/Header"');
  });

  it("4. a .tsx file is rejected (never persisted) when the contract declares JavaScript", async () => {
    setNemotronQueue([
      updateProgressStep("p1", "Build a site", [{ description: "Build homepage", status: "in_progress" }], NO_ALIAS_CONTRACT),
      writeFileStep("w1", "components/Header.tsx", "export default function Header() { return null; }"),
      writeFileStep("w2", "components/Header.js", "export default function Header() { return null; }"),
      doneStep("done"),
    ]);

    await runAgentTurn("s-no-ts", "Build a site.", "test-uid");

    const files = sessionFiles("s-no-ts");
    expect(files.map((f) => f.path)).toEqual(["components/Header.js"]);
  });

  it("5. the project contract persists across a continuation turn without being re-stated", async () => {
    setNemotronQueue([
      updateProgressStep("p1", "Build a site", [{ description: "Build homepage", status: "done" }], NO_ALIAS_CONTRACT),
      doneStep("Homepage built."),
    ]);
    await runAgentTurn("s-cont-contract", "Build a site.", "test-uid");
    expect(turnDoc("s-cont-contract")?.taskState?.projectContract).toEqual(NO_ALIAS_CONTRACT);

    // Follow-up turn never re-sends projectContract - only a plain status update.
    setNemotronQueue([
      updateProgressStep("p2", "Build a site", [
        { description: "Build homepage", status: "done" },
        { description: "Add footer", status: "done" },
      ]),
      writeFileStep("w1", "components/Footer.js", 'import x from "@/lib/x";\nexport default function Footer() { return null; }'),
      writeFileStep("w2", "components/Footer.js", 'import x from "../lib/x";\nexport default function Footer() { return null; }'),
      doneStep("done"),
    ]);
    await runAgentTurn("s-cont-contract", "add a footer", "test-uid");

    // The contract from turn 1 is STILL enforced in turn 2, even though
    // turn 2's own update_progress call never repeated it - this is the
    // structural guarantee, not just observed model good behavior.
    expect(turnDoc("s-cont-contract")?.taskState?.projectContract).toEqual(NO_ALIAS_CONTRACT);
    const files = sessionFiles("s-cont-contract");
    expect(files.find((f) => f.path === "components/Footer.js")?.content).toContain("../lib/x");
  });

  it("6. a project contract from one session never leaks into a different session", async () => {
    setNemotronQueue([
      updateProgressStep("p1", "Build A", [{ description: "a", status: "in_progress" }], NO_ALIAS_CONTRACT),
      writeFileStep("w1", "pages/index.js", 'import x from "@/x";'),
      writeFileStep("w2", "pages/index.js", 'import x from "../x";'),
      doneStep("done"),
    ]);
    await runAgentTurn("s-contract-a", "Build A.", "test-uid");

    // Session B never sets a contract at all - its @/ import must go through untouched.
    setNemotronQueue([writeFileStep("w1", "pages/index.js", 'import x from "@/x";'), doneStep("done")]);
    await runAgentTurn("s-contract-b", "Build B.", "test-uid");

    expect(sessionFiles("s-contract-b")[0].content).toBe('import x from "@/x";');
  });

  it("7. an existing project with a real, configured alias writes many @/-importing files without any being rejected", async () => {
    setNemotronQueue([
      updateProgressStep("p1", "Build a site", [{ description: "Build it", status: "in_progress" }], REAL_ALIAS_CONTRACT),
      writeFileStep("w1", "components/Header.js", 'import x from "@/lib/x";'),
      writeFileStep("w2", "components/Footer.js", 'import y from "@/data/y";'),
      writeFileStep("w3", "pages/index.js", 'import Header from "@/components/Header";\nimport Footer from "@/components/Footer";'),
      doneStep("done"),
    ]);

    await runAgentTurn("s-many-alias", "Build a site.", "test-uid");

    expect(sessionFiles("s-many-alias")).toHaveLength(3);
  });

  it("8. the contract mechanism never itself triggers a tool call or modifies file content - it only accepts or rejects exactly what the model wrote", async () => {
    setNemotronQueue([
      updateProgressStep("p1", "Build a site", [{ description: "Build it", status: "in_progress" }], NO_ALIAS_CONTRACT),
      writeFileStep("w1", "pages/index.js", 'import Header from "../components/Header";\nexport default function Home() { return null; }'),
      doneStep("done"),
    ]);

    await runAgentTurn("s-no-side-effects", "Build a site.", "test-uid");

    const files = sessionFiles("s-no-side-effects");
    // Persisted byte-for-byte as written - no rewriting, no injected
    // dependency/install step, no extra files.
    expect(files).toHaveLength(1);
    expect(files[0].content).toBe('import Header from "../components/Header";\nexport default function Home() { return null; }');
  });
});

/**
 * Phase 21: finish mode and the blocking-preview completion gate,
 * integrated end-to-end through runAgentTurn - see taskProgress.test.ts
 * for the pure-function-level coverage of the nudge builders
 * themselves. Root cause this closes: the Phase 20 live benchmark ran
 * out of its 40-iteration budget mid-verification with a real,
 * unresolved browser render error - it never got a structural nudge to
 * prioritize finishing/verifying over continuing to add work.
 */
describe("runAgentTurn - finish mode and blocking-preview completion gate (Phase 21)", () => {
  it("finish mode: nudges toward finishing once remaining iterations drop low, while unresolved work remains", async () => {
    const filler = Array.from({ length: 31 }, (_, i) =>
      writeFileStep(`f${i}`, `data/filler${i}.js`, `export const x = ${i};`)
    );
    setNemotronQueue([
      updateProgressStep("p1", "Build a site", [
        { description: "Build homepage", status: "in_progress" },
        { description: "Verify runtime", status: "pending" },
      ]),
      ...filler,
    ]);

    await runAgentTurn("s-finish-mode", "Build a site.", "test-uid");

    const doc = turnDoc("s-finish-mode");
    expect(doc?.telemetry.finishModeNudgesSent).toBe(1);
    expect(doc?.log.some((m) => m.content?.toLowerCase().includes("stop adding optional features"))).toBe(true);
  });

  it("finish mode never fires when there's nothing left unresolved to nudge toward", async () => {
    setNemotronQueue([
      updateProgressStep("p1", "Build a site", [{ description: "Build homepage", status: "done" }]),
      doneStep("done"),
    ]);

    await runAgentTurn("s-finish-mode-not-needed", "Build a site.", "test-uid");

    expect(turnDoc("s-finish-mode-not-needed")?.telemetry.finishModeNudgesSent).toBe(0);
  });

  it("rejects a premature 'done' when the last view_preview call actually failed, even though taskState shows everything done", async () => {
    setViewPreviewResult({ ok: false, content: "not_ready: No live preview page to capture yet." });
    setNemotronQueue([
      updateProgressStep("p1", "Build a site", [{ description: "Build homepage", status: "done" }]),
      viewPreviewStep("v1"),
      doneStep("Done - verified"),
      doneStep("Actually done now"),
    ]);

    await runAgentTurn("s-blocking-preview", "Build a site.", "test-uid");

    const doc = turnDoc("s-blocking-preview");
    expect(doc?.telemetry.blockingPreviewNudgesSent).toBe(1);
    expect(doc?.log.some((m) => m.content?.includes("view_preview"))).toBe(true);
    // Bounded to one nudge - a second "done" attempt is accepted, same
    // discipline as the incomplete-objective gate.
    expect(doc?.telemetry.terminationReason).toBe("done");
  });

  it("allows completion when the last view_preview call actually succeeded", async () => {
    setNemotronQueue([
      updateProgressStep("p1", "Build a site", [{ description: "Build homepage", status: "done" }]),
      viewPreviewStep("v1"),
      doneStep("Done - verified"),
    ]);

    await runAgentTurn("s-preview-ok", "Build a site.", "test-uid");

    const doc = turnDoc("s-preview-ok");
    expect(doc?.telemetry.blockingPreviewNudgesSent).toBe(0);
    expect(doc?.telemetry.terminationReason).toBe("done");
  });

  it("does not block completion when view_preview was never called this turn (null, not failed, for a task that never needed one)", async () => {
    setNemotronQueue([
      updateProgressStep("p1", "Write a script", [{ description: "Write the script", status: "done" }]),
      doneStep("Done"),
    ]);

    await runAgentTurn("s-no-preview-needed", "Write a script.", "test-uid");

    const doc = turnDoc("s-no-preview-needed");
    expect(doc?.telemetry.blockingPreviewNudgesSent).toBe(0);
    expect(doc?.telemetry.terminationReason).toBe("done");
  });
});

describe("runAgentTurn - requester identity and multiplayer attribution (Phase 29 Part 2/4/5)", () => {
  it("stamps the requesting uid on the user's own log entry", async () => {
    setNemotronQueue([doneStep("ok")]);
    await runAgentTurn("s-attrib-1", "Change the hero.", "uid-teammate-2", ["uid-owner", "uid-teammate-2"]);

    const doc = turnDoc("s-attrib-1");
    const userEntry = doc?.log.find((m) => m.role === "user" && m.content === "Change the hero.") as
      | { uid?: string }
      | undefined;
    expect(userEntry?.uid).toBe("uid-teammate-2");
  });

  it("a solo-project turn's log entry still carries the uid, even though no requester-context line is injected", async () => {
    setNemotronQueue([doneStep("ok")]);
    await runAgentTurn("s-attrib-solo", "Build a site.", "uid-owner", ["uid-owner"]);

    const doc = turnDoc("s-attrib-solo");
    const userEntry = doc?.log.find((m) => m.role === "user" && m.content === "Build a site.") as
      | { uid?: string }
      | undefined;
    expect(userEntry?.uid).toBe("uid-owner");
  });

  it("the model-facing message carries the compact requester context in a multiplayer project, but the human-readable log entry stays exactly what the user typed", async () => {
    setNemotronQueue([doneStep("ok")]);
    await runAgentTurn("s-attrib-2", "Make the hero darker.", "uid-teammate-2", ["uid-owner", "uid-teammate-2"]);

    const doc = turnDoc("s-attrib-2");
    const userEntry = doc?.log.find((m) => m.role === "user" && (m as { uid?: string }).uid === "uid-teammate-2");
    expect(userEntry?.content).toBe("Make the hero darker."); // no "[Current requester: ...]" prefix leaking into the display log

    const providerUserMessage = doc?.providerMessages?.find(
      (m) => (m as { role?: string }).role === "user" && String((m as { content?: string }).content).includes("Make the hero darker.")
    ) as { content?: string } | undefined;
    expect(providerUserMessage?.content).toContain("Current requester:");
  });

  it("two sequential turns from different requesters on the same project both stay in the SAME conversation - no separate context per user", async () => {
    setNemotronQueue([doneStep("First reply")]);
    await runAgentTurn("s-shared-convo", "Change hero background.", "uid-a", ["uid-a", "uid-b"]);

    setNemotronQueue([doneStep("Second reply")]);
    await runAgentTurn("s-shared-convo", "Change hero layout.", "uid-b", ["uid-a", "uid-b"]);

    const doc = turnDoc("s-shared-convo");
    // Same agentTurns doc, same accumulated log - both requests and both replies present.
    const userMessages = doc?.log.filter((m) => m.role === "user").map((m) => m.content);
    expect(userMessages).toContain("Change hero background.");
    expect(userMessages).toContain("Change hero layout.");
  });
});
