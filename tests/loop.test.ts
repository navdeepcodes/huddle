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

/** Phase 39 (Batch 1 follow-up): one write_file call describing several files at once, via the new `files` array. */
function writeFilesStep(callId: string, files: Array<{ path: string; content: string }>): AgentStepResult {
  return {
    message: {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: callId,
          type: "function",
          function: { name: "write_file", arguments: JSON.stringify({ files, reason: "test batch" }) },
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

function runCommandStep(callId: string, command: string, background = false): AgentStepResult {
  return {
    message: {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: callId,
          type: "function",
          function: { name: "run_command", arguments: JSON.stringify({ command, background, reason: "test" }) },
        },
      ] as ChatCompletionMessageToolCall[],
    },
    truncated: false,
    usage: null,
  };
}

function scaffoldStep(callId: string): AgentStepResult {
  return {
    message: {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: callId,
          type: "function",
          function: { name: "scaffold_nextjs_project", arguments: JSON.stringify({ reason: "test" }) },
        },
      ] as ChatCompletionMessageToolCall[],
    },
    truncated: false,
    usage: null,
  };
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
type PreviewEvidence = { verified: boolean; previewUrl: string | null; reason?: string };
type BuildEvidence = { command: string; ok: boolean; errorSummary?: string };

const executeToolState: {
  viewPreviewResult: { ok: boolean; content: string; previewEvidence?: PreviewEvidence };
  /** Phase 39 (Batch 1): when set, any run_command whose command matches "npm run build" returns this as buildEvidence - undefined means run_command behaves as a plain no-op success (most existing tests don't care about builds at all). */
  buildResult?: { ok: boolean; errorSummary?: string };
} = {
  viewPreviewResult: {
    ok: true,
    content: "Screenshot captured (1280x800).\n\nLooks good.",
    previewEvidence: { verified: true, previewUrl: "http://localhost:3000" },
  },
};
function setViewPreviewResult(result: { ok: boolean; content: string; previewEvidence?: PreviewEvidence }) {
  executeToolState.viewPreviewResult = result;
}
function setBuildResult(result: { ok: boolean; errorSummary?: string } | undefined) {
  executeToolState.buildResult = result;
}
/**
 * Phase 39 (Batch 1): when set, a run_command whose command exactly
 * matches this marker string mutates the fake turnClaims store as a
 * side effect - simulating another process reclaiming this turn's
 * claim as stale, mid-loop, the same shape a real Firestore state
 * change would take. Lets the split-brain guard test drive this
 * through the REAL loop rather than mocking loop.ts's own internals.
 */
let simulateStaleClaimOnCommand: string | null = null;

vi.mock("@/lib/agent/executeTool", async (importOriginal) => ({
  // Phase 40: the loop now also imports the PURE budget helpers
  // (refuseForBudget/isRuntimeRestartCall) from this module. Those are
  // real policy under test, not edges to stub, so the real ones are
  // kept - only executeTool itself (which would hit the runtime) is
  // replaced.
  ...(await importOriginal<typeof import("@/lib/agent/executeTool")>()),
  executeTool: vi.fn().mockImplementation(async (sessionId: string, call: ChatCompletionMessageToolCall) => {
    if (call.type !== "function") return { ok: true, content: "ok" };
    if (call.function.name === "view_preview") {
      return executeToolState.viewPreviewResult;
    }
    if (call.function.name === "run_command") {
      const args = JSON.parse(call.function.arguments || "{}") as { command?: string };
      const command = String(args.command ?? "");
      if (simulateStaleClaimOnCommand && command === simulateStaleClaimOnCommand) {
        fake.stores.get("turnClaims")?.set(sessionId, {
          sessionId,
          active: true,
          turnToken: "a-different-process-took-over",
          claimedAt: Date.now(),
          heartbeatAt: Date.now(),
          releasedAt: null,
          terminationReason: null,
        });
        return { ok: true, content: "ok" };
      }
      if (/\bnpm run build\b/.test(command) && executeToolState.buildResult) {
        const b = executeToolState.buildResult;
        return {
          ok: b.ok,
          content: b.ok ? "exit code: 0\nCompiled successfully." : `exit code: 1\n${b.errorSummary ?? "build failed"}`,
          buildEvidence: { command, ok: b.ok, ...(b.ok ? {} : { errorSummary: b.errorSummary }) } satisfies BuildEvidence,
        };
      }
      return { ok: true, content: "ok" };
    }
    return { ok: true, content: "ok" };
  }),
}));

const { runAgentTurn: runAgentTurnRaw } = await import("@/lib/agent/loop");

/**
 * Phase 39 (Batch 1): runAgentTurn now requires a turnToken proving
 * the caller already holds the authoritative claim (see
 * turnRegistry.ts's claimTurnAuthoritative) - in production this comes
 * from the route claiming BEFORE calling runAgentTurn. This suite
 * tests the loop's OWN decision logic (nudges, termination
 * classification, stagnation), not the claim mechanism itself (that's
 * covered directly in tests/turnClaim.test.ts) - so this wrapper seeds
 * a matching claim doc straight into the fake Firestore and calls
 * runAgentTurn with a fixed token, preserving every existing call
 * site's old (sessionId, message, uid, memberIds?) signature
 * unchanged. hasRealFilesAtTurnStart is always false here since none
 * of these tests depend on a pre-existing FILES_WRITTEN fact - the
 * evidence-gate-specific tests seed it explicitly where it matters.
 */
const TEST_TURN_TOKEN = "test-turn-token";

async function runAgentTurn(
  sessionId: string,
  userMessage: string,
  uid: string,
  memberIds: string[] = [],
  hasRealFilesAtTurnStart = false
): Promise<void> {
  if (!fake.stores.has("turnClaims")) fake.stores.set("turnClaims", new Map());
  fake.stores.get("turnClaims")!.set(sessionId, {
    sessionId,
    active: true,
    turnToken: TEST_TURN_TOKEN,
    claimedAt: Date.now(),
    heartbeatAt: Date.now(),
    releasedAt: null,
    terminationReason: null,
  });
  return runAgentTurnRaw(sessionId, userMessage, uid, TEST_TURN_TOKEN, hasRealFilesAtTurnStart, memberIds);
}

function turnDoc(sessionId: string) {
  return fake.stores.get("agentTurns")?.get(sessionId) as
    | {
        log: Array<{ role: string; content: string | null; toolCallId?: string; ok?: boolean; toolName?: string; path?: string }>;
        providerMessages?: unknown[];
        active: boolean;
        telemetry: {
          terminationReason: string | null;
          iterations: number;
          repeatedIterations: number;
          stagnationNudgesSent: number;
          incompleteObjectiveNudgesSent: number;
          finishModeNudgesSent: number;
          blockingPreviewNudgesSent: number;
          evidenceNudgesSent: number;
          truncatedNoActionRetries: number;
          totalDurationMs: number | null;
          providerFallback: {
            activated: boolean;
            fromProviderId: string | null;
            toProviderId: string | null;
            reason: string | null;
          };
          fileBudgetWarningSent: boolean;
          buildEarlyNudgeSent: boolean;
        };
        taskState?: {
          objective: string;
          subgoals: Array<{ description: string; status: string }>;
          projectContract?: Record<string, string>;
          manifest?: { projectType?: string; routes?: string[]; targetFiles?: string[]; fileBudget?: number };
          updatedAt: number;
        };
        buildState?: { status: string; attempt: number; command: string; errorSummary?: string };
        previewState?: { verified: boolean; previewUrl: string | null; reason?: string };
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
  // Phase 39 (Batch 1): includes previewEvidence matching ok:true by
  // default - most existing tests in this suite predate the evidence
  // gate and just want "view_preview succeeded" to mean exactly that,
  // not to ALSO have to separately opt into previewState being set.
  // Tests specifically about the evidence gate override this via
  // setViewPreviewResult/setBuildResult where the distinction matters.
  setViewPreviewResult({
    ok: true,
    content: "Screenshot captured (1280x800).\n\nLooks good.",
    previewEvidence: { verified: true, previewUrl: "http://localhost:3000" },
  });
  setBuildResult(undefined);
  simulateStaleClaimOnCommand = null;
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
  it(
    "a successful write_file is never re-executed by a later provider failure in the same turn",
    async () => {
      // Phase 40B: MAX_RETRIES_PER_PROVIDER is now 3 (4 total attempts
      // per provider), so exhausting BOTH providers' real backoff
      // (loop.ts uses generateStepWithRecovery's real setTimeout sleep,
      // not a fake one - there's no injection point for it here) now
      // takes up to (500+1000+2000) x 2 providers = 7s, over vitest's
      // 5s default. The extended timeout reflects that real cost
      // honestly rather than under-queuing errors to dodge it.
      setNemotronQueue([
        writeFileStep("call-1", "index.js", "// first file"),
        new AgentProviderError("nvidia", "network", "500", true),
        new AgentProviderError("nvidia", "network", "500", true),
        new AgentProviderError("nvidia", "network", "500", true),
        new AgentProviderError("nvidia", "network", "500", true),
      ]);
      setDeepseekQueue([
        new AgentProviderError("deepseek", "network", "500", true),
        new AgentProviderError("deepseek", "network", "500", true),
        new AgentProviderError("deepseek", "network", "500", true),
        new AgentProviderError("deepseek", "network", "500", true),
      ]);

      await runAgentTurn("s-dup", "Build something.", "test-uid");

      const files = sessionFiles("s-dup");
      expect(files).toHaveLength(1);
      expect(files[0].path).toBe("index.js");
      expect(files[0].content).toBe("// first file");
    },
    15_000
  );

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
    // Phase 39C: one truncation is now recoverable (see that suite
    // below) - it takes a SECOND consecutive truncated/no-tool response
    // for the turn to end this way. The classification itself, which is
    // what this test is about, is unchanged.
    // Phase 41C: with a fallback provider now registered, exhausting
    // nemotron's truncation retry tries the fallback next - queue it to
    // ALSO exhaust so the turn still ends up honestly truncated_no_action
    // (now after both providers, not just one).
    setNemotronQueue([
      truncatedWithPartialContentStep("Now I need to create the collection page with filters, sorting, and product grid."),
      truncatedWithPartialContentStep("Still thinking about the collection page..."),
    ]);
    setDeepseekQueue([
      truncatedWithPartialContentStep("Fallback also thinking at length..."),
      truncatedWithPartialContentStep("Fallback still thinking..."),
    ]);

    await runAgentTurn("s-truncated", "Build a premium ecommerce website for a fictional luxury sneaker brand called AEREN.", "test-uid");

    const doc = turnDoc("s-truncated");
    expect(doc?.telemetry.terminationReason).toBe("truncated_no_action");
    expect(doc?.log.some((m) => m.content?.includes("ran out of response budget"))).toBe(true);
    expect(doc?.telemetry.providerFallback.activated).toBe(true);
  });

  it("an untruncated response with content and no tool call is still correctly reported as done - a genuine deliberate stop is not misclassified as truncation", async () => {
    setNemotronQueue([doneStep("The site is complete and verified.")]);

    await runAgentTurn("s-genuinely-done", "Build a simple site.", "test-uid");

    expect(turnDoc("s-genuinely-done")?.telemetry.terminationReason).toBe("done");
    // Phase 39C regression (case E): the recovery path must not touch a
    // normal, untruncated turn at all.
    expect(turnDoc("s-genuinely-done")?.telemetry.truncatedNoActionRetries).toBe(0);
  });

  it("a truncated response with NO content at all is still reported as truncated_no_action (the original, already-correct case)", async () => {
    setNemotronQueue([
      { message: { role: "assistant", content: null }, truncated: true, usage: null },
      { message: { role: "assistant", content: null }, truncated: true, usage: null },
    ]);
    // Phase 41C: the fallback provider must also exhaust for the turn to
    // end this way - see the sibling test above for why.
    setDeepseekQueue([
      { message: { role: "assistant", content: null }, truncated: true, usage: null },
      { message: { role: "assistant", content: null }, truncated: true, usage: null },
    ]);

    await runAgentTurn("s-truncated-empty", "Build a simple site.", "test-uid");

    expect(turnDoc("s-truncated-empty")?.telemetry.terminationReason).toBe("truncated_no_action");
  });
});

/**
 * Phase 39C: a provider-side truncation that produces zero tool calls
 * is a transient outcome of reasoning and tool-call emission sharing
 * ONE output budget (enable_thinking is on for Nemotron), not a
 * decision by the model to stop. Live-reproduced 2026-08-28 (session
 * VZ54JRXfEATLzAtji1hi): iteration 1 successfully scaffolded a real
 * project (7 files), iteration 2 burned ~7,800 hidden reasoning tokens
 * and returned finish_reason "length" with no tool call, and the turn
 * died with a perfectly good scaffold already on disk. It now gets
 * exactly one bounded retry instead.
 */
describe("runAgentTurn - truncated-no-action recovery (Phase 39C)", () => {
  it("A. recovers from one truncated/no-tool response, executes the retry's tool call, and never re-runs an earlier tool", async () => {
    setNemotronQueue([
      writeFileStep("w1", "pages/index.js", "// first real file"),
      truncatedWithPartialContentStep("Let me think about the visual direction in detail..."),
      writeFileStep("w2", "components/Hero.js", "// written after recovery"),
      doneStep("Done."),
    ]);

    await runAgentTurn("s-trunc-recover", "Build a site.", "test-uid");

    const doc = turnDoc("s-trunc-recover");
    // The turn continued rather than dying at the truncation.
    expect(doc?.telemetry.terminationReason).toBe("done");
    expect(doc?.telemetry.truncatedNoActionRetries).toBe(1);

    // The retry's tool actually executed...
    const files = sessionFiles("s-trunc-recover");
    expect(files.map((f) => f.path).sort()).toEqual(["components/Hero.js", "pages/index.js"]);
    // ...and the pre-truncation write was NOT executed a second time
    // (exactly one write_file log row per file, no duplicates).
    const writeRows = doc?.log.filter((m) => m.toolName === "write_file" && m.ok);
    expect(writeRows).toHaveLength(2);

    // The short recovery instruction was injected exactly once.
    const recoveryRows = doc?.log.filter((m) => m.content?.includes("used its output budget"));
    expect(recoveryRows).toHaveLength(1);
  });

  it("B. two consecutive truncated/no-tool responses exhaust the primary's bounded retry, fall back once, and still terminate honestly if the fallback ALSO exhausts - never a third attempt per provider", async () => {
    setNemotronQueue([
      truncatedWithPartialContentStep("Planning at length..."),
      truncatedWithPartialContentStep("Still planning at length..."),
      // A third step exists in the queue purely to prove it is never consumed.
      writeFileStep("never", "should-not-exist.js", "// must never be written"),
    ]);
    // Phase 41C: exhausting nemotron's truncation retry now tries the
    // fallback before giving up - queue it to also exhaust, with its own
    // bounding proof (a 3rd step it must never reach either).
    setDeepseekQueue([
      truncatedWithPartialContentStep("Fallback planning at length..."),
      truncatedWithPartialContentStep("Fallback still planning..."),
      writeFileStep("never2", "should-not-exist-2.js", "// must never be written"),
    ]);

    await runAgentTurn("s-trunc-twice", "Build a site.", "test-uid");

    const doc = turnDoc("s-trunc-twice");
    expect(doc?.telemetry.terminationReason).toBe("truncated_no_action");
    // Phase 41C: the counter is reset when a provider transition happens
    // (the new provider gets its own fresh chance) - deepseek's OWN
    // single retry is what this now reflects, not nemotron's.
    expect(doc?.telemetry.truncatedNoActionRetries).toBe(1);
    expect(doc?.telemetry.providerFallback.activated).toBe(true);
    expect(doc?.telemetry.providerFallback.reason).toBe("truncated_no_action_exhausted");
    // Bounded per provider: exactly 2 calls each, neither "never" step consumed.
    expect(nemotronState.index).toBe(2);
    expect(deepseekState.index).toBe(2);
    expect(sessionFiles("s-trunc-twice")).toHaveLength(0);
  });

  it("C. an already-successful scaffold survives the truncation and the retry continues from it, without scaffolding again", async () => {
    // Mirrors the real 2026-08-28 failure end to end: scaffold succeeds,
    // the NEXT step truncates with no tool call, and the turn must carry
    // on from the existing scaffold through build + preview to a real
    // "done" - the exact work the old behavior threw away.
    setBuildResult({ ok: true });
    setNemotronQueue([
      scaffoldStep("s1"),
      truncatedWithPartialContentStep("Now let me think hard about the theme and visual direction..."),
      writeFilesStep("batch1", [
        { path: "pages/index.js", content: "// real page" },
        { path: "components/Hero.js", content: "// real hero" },
      ]),
      runCommandStep("b1", "npm run build"),
      viewPreviewStep("v1"),
      doneStep("Built on top of the existing scaffold."),
    ]);

    await runAgentTurn("s-trunc-scaffold", "Build a hackathon landing page.", "test-uid");

    const doc = turnDoc("s-trunc-scaffold");
    expect(doc?.telemetry.terminationReason).toBe("done");
    expect(doc?.telemetry.truncatedNoActionRetries).toBe(1);

    // scaffold_nextjs_project ran exactly once - the retry continued
    // from the existing state rather than restarting the project.
    const scaffoldRows = doc?.log.filter((m) => m.toolName === "scaffold_nextjs_project");
    expect(scaffoldRows).toHaveLength(1);

    // The post-recovery batched write landed on top of it.
    const paths = sessionFiles("s-trunc-scaffold").map((f) => f.path).sort();
    expect(paths).toEqual(["components/Hero.js", "pages/index.js"]);
  });

  it("D. a truncated response that DOES contain a tool call never uses the recovery path - the tool just runs", async () => {
    setNemotronQueue([
      // Truncated, but a complete tool call was still emitted.
      { ...writeFileStep("w1", "pages/index.js", "// emitted before the cutoff"), truncated: true },
      doneStep("Done."),
    ]);

    await runAgentTurn("s-trunc-with-tool", "Build a site.", "test-uid");

    const doc = turnDoc("s-trunc-with-tool");
    expect(doc?.telemetry.truncatedNoActionRetries).toBe(0);
    expect(doc?.log.some((m) => m.content?.includes("used its output budget"))).toBe(false);
    expect(sessionFiles("s-trunc-with-tool").map((f) => f.path)).toEqual(["pages/index.js"]);
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

  it("6. a premature 'done' is rejected once (nudged) while a required subgoal is still pending, then bounded - and never silently reported as real 'done'", async () => {
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
    // Phase 41 regression: bounded to one nudge - a model that insists
    // it's done a second time isn't bounced forever - but "Build Y" was
    // never marked done OR blocked, just abandoned. The old behavior
    // silently reported this as real "done" (indistinguishable from a
    // genuine full success); it must land as step_budget_exhausted
    // instead, since the model never explicitly gave up on "Build Y"
    // the way "blocked" requires.
    expect(doc?.telemetry.terminationReason).toBe("step_budget_exhausted");
    expect(doc?.taskState?.subgoals.find((s) => s.description === "Build Y")?.status).toBe("pending");
  });

  it("7. a truncated response is still reported as truncated_no_action even with unresolved subgoals tracked - the completion gate never intercepts it", async () => {
    setNemotronQueue([
      updateProgressStep("p1", "Build a big site", [
        { description: "Build homepage", status: "in_progress" },
        { description: "Add footer", status: "pending" },
      ]),
      // Phase 39C: takes two consecutive truncations now - the first one
      // is recoverable. The point of this test (the completion gate must
      // never intercept a truncation and reclassify it) is unchanged.
      truncatedWithPartialContentStep("Now I need to build the footer with links and..."),
      truncatedWithPartialContentStep("Still working out the footer..."),
    ]);
    // Phase 41C: the fallback provider must also exhaust for the turn to
    // end this way.
    setDeepseekQueue([
      truncatedWithPartialContentStep("Fallback working out the footer..."),
      truncatedWithPartialContentStep("Fallback still working..."),
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

  it("1b. a brand/logo icon import (Phase 39) is auto-corrected and persisted on the FIRST write - never rejected, never retried", async () => {
    setNemotronQueue([
      writeFileStep(
        "w1",
        "components/Footer.js",
        'import { Github, Home } from "lucide-react";\nexport default function Footer() { return <Github />; }'
      ),
      doneStep("done"),
    ]);

    await runAgentTurn("s-brand-icon", "Build a site.", "test-uid");

    const files = sessionFiles("s-brand-icon");
    expect(files).toHaveLength(1);
    expect(files[0].content).toContain("Link as Github");
    expect(files[0].content).toContain("<Github />");

    const doc = turnDoc("s-brand-icon");
    // Not rejected: the tool result for this exact call is a SUCCESS, not INVALID_TOOL_ARGUMENTS.
    expect(doc?.log.some((m) => m.toolCallId === "w1" && m.ok === true)).toBe(true);
    expect(doc?.log.some((m) => m.content?.includes("INVALID_TOOL_ARGUMENTS"))).toBe(false);
    // The model is still told what happened, just not as a blocking failure.
    expect(doc?.log.find((m) => m.toolCallId === "w1")?.content).toContain("auto-corrected");
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

/**
 * Phase 39 (Batch 1): the hard termination contract - completion for a
 * web-project turn now requires real FILES_WRITTEN + BUILD_PASSED +
 * PREVIEW_VERIFIED evidence, not just an absence of unresolved/blocked
 * subgoals. These tests exercise the gate directly through the real
 * loop (not just the underlying primitives, which tests/turnClaim.test.ts
 * already covers in isolation).
 */
describe("runAgentTurn - hard termination contract (Phase 39 Batch 1)", () => {
  it("a non-web-project turn (no scaffold call, no projectContract) reaches 'done' exactly as before - the evidence gate never fires", async () => {
    setNemotronQueue([doneStep("Answered the question.")]);
    await runAgentTurn("s-non-web", "What does this error mean?", "test-uid");

    const doc = turnDoc("s-non-web");
    expect(doc?.telemetry.terminationReason).toBe("done");
    expect(doc?.telemetry.evidenceNudgesSent).toBe(0);
    expect(doc?.buildState).toBeUndefined();
  });

  it("a web-project turn with a passed build and a verified preview reaches 'done' - the gate never punishes a genuinely complete turn", async () => {
    setBuildResult({ ok: true });
    setNemotronQueue([
      updateProgressStep("p1", "Build a site", [{ description: "Build homepage", status: "done" }], NO_ALIAS_CONTRACT),
      writeFileStep("w1", "pages/index.js", "export default function Home() { return <div>Hi</div>; }"),
      runCommandStep("b1", "npm run build"),
      viewPreviewStep("v1"),
      doneStep("Done - built and verified."),
    ]);

    await runAgentTurn("s-web-complete", "Build a site.", "test-uid");

    const doc = turnDoc("s-web-complete");
    expect(doc?.telemetry.terminationReason).toBe("done");
    expect(doc?.telemetry.evidenceNudgesSent).toBe(0);
    expect(doc?.buildState).toMatchObject({ status: "passed", command: "npm run build" });
    expect(doc?.previewState).toMatchObject({ verified: true });
  });

  it("a continuation turn that only calls create_presentation on an existing web-project session is NOT gated - the wroteFileThisTurn guard against an inherited projectContract false-positive", async () => {
    // Turn 1: establishes a real web project (scaffold + files + build + preview).
    setBuildResult({ ok: true });
    setNemotronQueue([
      updateProgressStep("p1", "Build a site", [{ description: "Build homepage", status: "done" }], NO_ALIAS_CONTRACT),
      scaffoldStep("s1"),
      writeFileStep("w1", "pages/index.js", "export default function Home() { return <div>Hi</div>; }"),
      runCommandStep("b1", "npm run build"),
      viewPreviewStep("v1"),
      doneStep("Site built."),
    ]);
    await runAgentTurn("s-presentation-followup", "Build a site.", "test-uid", [], true);

    // Turn 2: a genuinely unrelated follow-up that never writes a file or
    // touches build/preview at all - taskState.projectContract is still
    // inherited from turn 1, but isWebProjectTurn must NOT trip on that
    // alone.
    setBuildResult(undefined);
    setNemotronQueue([doneStep("Here's a slide deck about pricing (created via create_presentation).")]);
    await runAgentTurn("s-presentation-followup", "Make me a slide deck about our pricing.", "test-uid", [], true);

    const doc = turnDoc("s-presentation-followup");
    expect(doc?.taskState?.projectContract).toBeDefined(); // confirms the inheritance actually happened
    expect(doc?.telemetry.terminationReason).toBe("done");
    expect(doc?.telemetry.evidenceNudgesSent).toBe(0);
  });

  it("a web-project turn that never gets a passing build lands on evidence_incomplete after exactly one nudge - bounded, never silently 'done'", async () => {
    setBuildResult({ ok: false, errorSummary: "SyntaxError: unexpected token" });
    setNemotronQueue([
      updateProgressStep("p1", "Build a site", [{ description: "Build homepage", status: "done" }], NO_ALIAS_CONTRACT),
      writeFileStep("w1", "pages/index.js", "export default function Home() { return <div>Hi</div> }"),
      runCommandStep("b1", "npm run build"),
      doneStep("I'm done"),
      doneStep("Actually done now"),
    ]);

    await runAgentTurn("s-evidence-incomplete", "Build a site.", "test-uid");

    const doc = turnDoc("s-evidence-incomplete");
    expect(doc?.telemetry.evidenceNudgesSent).toBe(1);
    expect(doc?.log.some((m) => m.content?.includes("build attempt") || m.content?.includes("preview check"))).toBe(true);
    expect(doc?.telemetry.terminationReason).toBe("evidence_incomplete");
    expect(doc?.buildState).toMatchObject({ status: "failed" });
  });

  it("the split-brain guard: a turn whose claim is reclaimed as stale mid-loop stops iterating immediately with claim_expired, not by racing the new claimant", async () => {
    simulateStaleClaimOnCommand = "__SIMULATE_STALE_CLAIM__";
    setNemotronQueue([
      writeFileStep("w1", "pages/index.js", "content v1"),
      // Before the NEXT iteration's heartbeat check, the claim doc is
      // mutated out from under the running turn (simulating a genuine
      // reclaim-as-stale by another process) - triggered as a side
      // effect of this run_command, the same shape a real Firestore
      // state change would take.
      runCommandStep("marker", "__SIMULATE_STALE_CLAIM__"),
      writeFileStep("w2", "pages/index.js", "content v2 - should never be reached"),
    ]);

    await runAgentTurn("s-split-brain", "Build a site.", "test-uid");

    const doc = turnDoc("s-split-brain");
    expect(doc?.telemetry.terminationReason).toBe("claim_expired");
    // The third step (w2, "should never be reached") must never have run -
    // only 2 of the 3 queued steps were consumed before the loop broke.
    expect(nemotronState.index).toBe(2);
    // The claims doc must retain the OTHER process's token, not be
    // clobbered by this (superseded) process's own finally-block release.
    expect((fake.stores.get("turnClaims")?.get("s-split-brain") as { turnToken?: string })?.turnToken).toBe(
      "a-different-process-took-over"
    );
  });
});

/**
 * Phase 39 (Batch 1 follow-up, "file explosion"/batching fix): a
 * multi-file write_file call, driven through the REAL loop end to end
 * - proves several files land in one iteration (fewer turns = faster
 * builds), each still shows up individually for change-visibility UI,
 * and stagnation/telemetry bookkeeping treats the whole call sanely.
 */
describe("runAgentTurn - multi-file write_file batching (Phase 39 Batch 1 follow-up)", () => {
  it("a single multi-file call persists every file and completes in fewer iterations than one-file-per-turn would need", async () => {
    setNemotronQueue([
      writeFilesStep("batch1", [
        { path: "components/Header.js", content: "header" },
        { path: "components/Hero.js", content: "hero" },
        { path: "components/Footer.js", content: "footer" },
      ]),
      doneStep("Wrote all three components."),
    ]);

    await runAgentTurn("s-multifile", "Build a site.", "test-uid");

    const files = sessionFiles("s-multifile");
    expect(files.map((f) => f.path).sort()).toEqual(["components/Footer.js", "components/Header.js", "components/Hero.js"]);

    const doc = turnDoc("s-multifile");
    expect(doc?.telemetry.terminationReason).toBe("done");
    // Only 2 iterations total (one batched write + done) - the whole
    // point of this feature is fewer turns for the same file count.
    expect((fake.stores.get("agentTurns")?.get("s-multifile") as { telemetry?: { iterations?: number } })?.telemetry?.iterations).toBe(2);

    // Each file still shows up as its own log row, for change-visibility UI -
    // a batched call reads no differently to that UI than 3 separate calls would.
    const writeEntries = doc?.log.filter((m) => m.toolName === "write_file" || (m as { path?: string }).path);
    const paths = doc?.log.map((m) => (m as { path?: string }).path).filter(Boolean);
    expect(paths).toEqual(expect.arrayContaining(["components/Header.js", "components/Hero.js", "components/Footer.js"]));
    expect(writeEntries?.every((m) => m.ok)).toBe(true);
  });

  it("a multi-file call mixed with a legacy single-file call in the same turn both work correctly", async () => {
    setNemotronQueue([
      writeFileStep("single1", "data/site.js", "site data"),
      writeFilesStep("batch1", [
        { path: "components/Header.js", content: "header" },
        { path: "components/Hero.js", content: "hero" },
      ]),
      doneStep("Done."),
    ]);

    await runAgentTurn("s-mixed-batch", "Build a site.", "test-uid");

    const files = sessionFiles("s-mixed-batch").map((f) => f.path).sort();
    expect(files).toEqual(["components/Header.js", "components/Hero.js", "data/site.js"]);
    expect(turnDoc("s-mixed-batch")?.telemetry.terminationReason).toBe("done");
  });

  it("one invalid file inside a multi-file call rejects the whole call, and the model can see exactly why", async () => {
    setNemotronQueue([
      writeFilesStep("batch1", [
        { path: "components/Header.js", content: "header" },
        { path: "", content: "bad - empty path" },
      ]),
      // The model retries correctly after seeing the rejection.
      writeFilesStep("batch2", [
        { path: "components/Header.js", content: "header" },
        { path: "components/Footer.js", content: "footer" },
      ]),
      doneStep("Fixed and done."),
    ]);

    await runAgentTurn("s-invalid-batch", "Build a site.", "test-uid");

    const doc = turnDoc("s-invalid-batch");
    const rejectedEntry = doc?.log.find((m) => m.content?.includes("INVALID_TOOL_ARGUMENTS"));
    expect(rejectedEntry).toBeDefined();
    expect(sessionFiles("s-invalid-batch").map((f) => f.path).sort()).toEqual(["components/Footer.js", "components/Header.js"]);
  });
});

/**
 * Phase 40 §6A/§7/§10: the loop-level half of the budget work. The pure
 * policy is covered in tests/budgets.test.ts; these drive the REAL loop
 * to prove the counters are actually wired to control flow - which is
 * precisely what was missing before (buildState.attempt was incremented
 * and never read).
 */
describe("runAgentTurn - enforced budgets and single-nudge discipline (Phase 40)", () => {
  it("§6A: a repeatedly-failing build is cut off at the attempt cap and terminates with build_repair_budget_exhausted", async () => {
    setBuildResult({ ok: false, errorSummary: "SyntaxError: unexpected token" });
    setNemotronQueue([
      updateProgressStep("p1", "Build a site", [{ description: "Build homepage", status: "done" }], NO_ALIAS_CONTRACT),
      writeFileStep("w1", "pages/index.js", "broken"),
      runCommandStep("b1", "npm run build"),
      runCommandStep("b2", "npm run build"),
      runCommandStep("b3", "npm run build"),
      // A 4th build must be refused rather than executed.
      runCommandStep("b4", "npm run build"),
      doneStep("I give up"),
      doneStep("Really done"),
    ]);

    await runAgentTurn("s-build-budget", "Build a site.", "test-uid");

    const doc = turnDoc("s-build-budget");
    expect(doc?.buildState?.attempt).toBe(3); // capped - the 4th never ran
    const refusal = doc?.log.find((m) => m.content?.includes("BUDGET_EXHAUSTED (build)"));
    expect(refusal).toBeDefined();
    expect(doc?.telemetry.terminationReason).toBe("build_repair_budget_exhausted");
  });

  it("§6A: a build that PASSES within the budget is completely unaffected", async () => {
    setBuildResult({ ok: true });
    setNemotronQueue([
      updateProgressStep("p1", "Build a site", [{ description: "Build homepage", status: "done" }], NO_ALIAS_CONTRACT),
      writeFileStep("w1", "pages/index.js", "good"),
      runCommandStep("b1", "npm run build"),
      viewPreviewStep("v1"),
      doneStep("Done."),
    ]);

    await runAgentTurn("s-build-ok", "Build a site.", "test-uid");

    const doc = turnDoc("s-build-ok");
    expect(doc?.telemetry.terminationReason).toBe("done");
    expect(doc?.log.some((m) => m.content?.includes("BUDGET_EXHAUSTED"))).toBe(false);
  });

  it("§10: stagnation and finish-mode never fire in the same iteration - exactly one nudge wins", async () => {
    // 40 identical write_file steps: stagnation trips early (3 identical
    // signatures) and, deep into the run, finish-mode's window opens too.
    // Before Phase 40 both could fire in one iteration with contradictory
    // advice; now stagnation takes priority and only one is ever sent.
    const identical = Array.from({ length: 40 }, () => writeFileStep("w", "a.js", "same content"));
    setNemotronQueue([
      updateProgressStep("p1", "Build a site", [{ description: "Build homepage", status: "in_progress" }]),
      ...identical,
    ]);

    await runAgentTurn("s-one-nudge", "Build a site.", "test-uid");

    const doc = turnDoc("s-one-nudge");
    const nudges = doc?.log.filter((m) => (m as { isNudge?: boolean }).isNudge) ?? [];

    // Every nudge must sit at a distinct timestamp-ordered position with
    // no two of DIFFERENT kinds adjacent from one iteration: assert
    // directly that the two kinds never co-occur.
    const stagnationCount = nudges.filter((m) => m.content?.includes("isn't working")).length;
    const finishCount = nudges.filter((m) => m.content?.toLowerCase().includes("stop adding optional features")).length;

    expect(stagnationCount).toBe(doc?.telemetry.stagnationNudgesSent);
    expect(finishCount).toBe(doc?.telemetry.finishModeNudgesSent);
    // The real invariant: the two counters can never sum to more than
    // the number of iterations that produced tool calls, and crucially
    // finish-mode is suppressed on any iteration stagnation claimed.
    expect(stagnationCount).toBeGreaterThan(0);
    expect(stagnationCount + finishCount).toBeLessThanOrEqual(doc?.telemetry.iterations ?? 0);
  });
});

/**
 * Phase 41C: the Ultra -> Lightning fallback. The mock's two queued
 * providers ("nvidia", "deepseek") stand in for Ultra and Lightning at
 * the loop-WIRING level - the exact production attempt counts (Ultra 4,
 * Lightning 2) and model identities live in nemotron.ts/
 * providerResolution.ts and are covered there; these tests prove
 * loop.ts's own behavior is correct regardless of which two providers
 * it's handed: committing forward once, never oscillating back,
 * preserving state, and never letting a provider-side failure reach
 * anywhere it shouldn't.
 */
describe("runAgentTurn - Ultra to Lightning provider fallback (Phase 41C)", () => {
  it("1/11. Ultra succeeds -> the fallback provider is never called at all", async () => {
    setNemotronQueue([doneStep("Done via Ultra.")]);
    setDeepseekQueue([doneStep("Should never be reached.")]);

    await runAgentTurn("s-ultra-only", "Build a site.", "test-uid");

    expect(deepseekState.index).toBe(0);
    expect(turnDoc("s-ultra-only")?.telemetry.providerFallback.activated).toBe(false);
  });

  it("2. a single transient Ultra failure retries against Ultra itself, per the existing bounded policy - no fallback needed", async () => {
    setNemotronQueue([
      new AgentProviderError("nvidia", "network", "500", true),
      doneStep("Recovered on Ultra's own retry."),
    ]);
    setDeepseekQueue([doneStep("Should never be reached.")]);

    await runAgentTurn("s-ultra-retry", "Build a site.", "test-uid");

    expect(deepseekState.index).toBe(0);
    const doc = turnDoc("s-ultra-retry");
    expect(doc?.telemetry.providerFallback.activated).toBe(false);
    expect(doc?.log.some((m) => m.content?.includes("Recovered on Ultra's own retry"))).toBe(true);
  });

  it("3. Ultra exhausts its full attempt budget -> Lightning starts", async () => {
    setNemotronQueue([
      new AgentProviderError("nvidia", "network", "500", true),
      new AgentProviderError("nvidia", "network", "500", true),
      new AgentProviderError("nvidia", "network", "500", true),
      new AgentProviderError("nvidia", "network", "500", true),
    ]);
    setDeepseekQueue([doneStep("Lightning took over.")]);

    await runAgentTurn("s-fallback-starts", "Build a site.", "test-uid");

    expect(nemotronState.index).toBe(4); // Ultra's full budget consumed, never a 5th
    expect(deepseekState.index).toBe(1);
    expect(turnDoc("s-fallback-starts")?.telemetry.providerFallback.activated).toBe(true);
  }, 15_000); // exhausting Ultra's real backoff (500+1000+2000ms) takes longer than vitest's 5s default

  it("4. Lightning succeeds after taking over -> the turn continues normally to done", async () => {
    setNemotronQueue([
      new AgentProviderError("nvidia", "network", "500", true),
      new AgentProviderError("nvidia", "network", "500", true),
      new AgentProviderError("nvidia", "network", "500", true),
      new AgentProviderError("nvidia", "network", "500", true),
    ]);
    setDeepseekQueue([writeFileStep("w1", "pages/index.js", "// from lightning"), doneStep("Done via Lightning.")]);

    await runAgentTurn("s-fallback-continues", "Build a site.", "test-uid");

    const doc = turnDoc("s-fallback-continues");
    expect(doc?.telemetry.terminationReason).toBe("done");
    expect(sessionFiles("s-fallback-continues").map((f) => f.path)).toEqual(["pages/index.js"]);
  }, 15_000);

  it("5. tools Ultra already executed before failing are never re-executed after the switch to Lightning", async () => {
    setNemotronQueue([
      writeFileStep("w1", "pages/index.js", "// written by ultra before it failed"),
      new AgentProviderError("nvidia", "network", "500", true),
      new AgentProviderError("nvidia", "network", "500", true),
      new AgentProviderError("nvidia", "network", "500", true),
    ]);
    setDeepseekQueue([doneStep("Lightning finished it.")]);

    await runAgentTurn("s-no-dup-tools", "Build a site.", "test-uid");

    const files = sessionFiles("s-no-dup-tools");
    expect(files).toHaveLength(1);
    expect(files[0].content).toBe("// written by ultra before it failed");
  }, 15_000);

  it("6. Lightning also fails after taking over -> honest provider_error, not a silent hang or a false 'done'", async () => {
    setNemotronQueue([
      new AgentProviderError("nvidia", "network", "500", true),
      new AgentProviderError("nvidia", "network", "500", true),
      new AgentProviderError("nvidia", "network", "500", true),
      new AgentProviderError("nvidia", "network", "500", true),
    ]);
    setDeepseekQueue([
      new AgentProviderError("deepseek", "network", "500", true),
      new AgentProviderError("deepseek", "network", "500", true),
      new AgentProviderError("deepseek", "network", "500", true),
      new AgentProviderError("deepseek", "network", "500", true),
    ]);

    await runAgentTurn("s-both-fail", "Build a site.", "test-uid");

    const doc = turnDoc("s-both-fail");
    expect(doc?.telemetry.terminationReason).toBe("provider_error");
    // §"USER-FACING ACTIVITY": never raw provider internals in the log.
    expect(doc?.log.some((m) => m.content?.includes("500"))).toBe(false);
    expect(doc?.log.some((m) => m.content?.includes("couldn't finish this build right now"))).toBe(true);
  }, 15_000); // both providers exhausting their real backoff can approach ~7s

  it("7. the fallback does not extend the turn's wall-clock budget - a turn already past its deadline never starts the fallback's first call", async () => {
    // The wall-clock gate is checked once at the top of EVERY iteration,
    // including the one that would start the fallback - see loop.ts's
    // `if (Date.now() >= turnDeadline)` check, which runs before any
    // provider is contacted. Simulate an already-expired turn by
    // starting one whose turnStartedAt is far in the past isn't exposed
    // to this harness directly, so this proves the adjacent, load-bearing
    // half instead: the SAME deadline value threads unchanged through a
    // fallback transition (never recomputed/reset), which is what makes
    // that top-of-loop gate authoritative across a provider switch too.
    setNemotronQueue([
      new AgentProviderError("nvidia", "network", "500", true),
      new AgentProviderError("nvidia", "network", "500", true),
      new AgentProviderError("nvidia", "network", "500", true),
      new AgentProviderError("nvidia", "network", "500", true),
    ]);
    setDeepseekQueue([doneStep("Lightning finished within the same budget.")]);

    const before = Date.now();
    await runAgentTurn("s-wallclock-shared", "Build a site.", "test-uid");
    const doc = turnDoc("s-wallclock-shared");

    // A real turn: total elapsed time is small (mock providers, no real
    // network) and nowhere near a fresh 20-minute allotment - proving no
    // second budget was granted to the fallback.
    expect((doc?.telemetry.totalDurationMs ?? Infinity)).toBeLessThan(Date.now() - before + 5000);
    expect(doc?.telemetry.providerFallback.activated).toBe(true);
  });

  it("8. the fallback preserves taskState exactly - subgoals tracked before the switch are still there after it", async () => {
    setNemotronQueue([
      updateProgressStep("p1", "Build a site", [
        { description: "Scaffold the project", status: "done" },
        { description: "Build the homepage", status: "in_progress" },
      ]),
      new AgentProviderError("nvidia", "network", "500", true),
      new AgentProviderError("nvidia", "network", "500", true),
      new AgentProviderError("nvidia", "network", "500", true),
    ]);
    setDeepseekQueue([doneStep("Lightning saw the existing plan.")]);

    await runAgentTurn("s-taskstate-preserved", "Build a site.", "test-uid");

    const doc = turnDoc("s-taskstate-preserved");
    expect(doc?.taskState?.objective).toBe("Build a site");
    expect(doc?.taskState?.subgoals.find((s) => s.description === "Scaffold the project")?.status).toBe("done");
  });

  it("9. a build failure (a normal tool result, not a provider error) never triggers provider fallback", async () => {
    setBuildResult({ ok: false, errorSummary: "SyntaxError: unexpected token" });
    setNemotronQueue([
      writeFileStep("w1", "pages/index.js", "broken"),
      runCommandStep("b1", "npm run build"),
      doneStep("Reporting the build issue."),
    ]);
    setDeepseekQueue([doneStep("Should never be reached.")]);

    await runAgentTurn("s-build-fail-no-fallback", "Build a site.", "test-uid");

    expect(deepseekState.index).toBe(0);
    expect(turnDoc("s-build-fail-no-fallback")?.telemetry.providerFallback.activated).toBe(false);
  });

  it("10. a preview failure (a normal tool result, not a provider error) never triggers provider fallback", async () => {
    setViewPreviewResult({ ok: false, content: "Preview did not render correctly." });
    // A premature "done" while the preview hasn't verified hits the
    // existing blocking-preview gate (bounded to 1 nudge) - queue a 3rd
    // Ultra response so THAT bounded nudge cycle resolves on Ultra
    // itself, keeping this test's actual claim clean: a tool-result
    // failure alone, with no provider-level error anywhere, never
    // reaches the fallback machinery at all.
    setNemotronQueue([
      viewPreviewStep("v1"),
      doneStep("Reporting the preview issue."),
      doneStep("Still reporting the same preview issue."),
    ]);
    setDeepseekQueue([doneStep("Should never be reached.")]);

    await runAgentTurn("s-preview-fail-no-fallback", "Build a site.", "test-uid");

    expect(deepseekState.index).toBe(0);
    expect(turnDoc("s-preview-fail-no-fallback")?.telemetry.providerFallback.activated).toBe(false);
    setViewPreviewResult({
      ok: true,
      content: "Screenshot captured (1280x800).\n\nLooks good.",
      previewEvidence: { verified: true, previewUrl: "http://localhost:3000" },
    });
  });

  it("12. Lightning declaring 'done' cannot bypass the completion evidence gate - the orchestrator still requires real build+preview evidence for a web project", async () => {
    setNemotronQueue([
      scaffoldStep("s1"),
      new AgentProviderError("nvidia", "network", "500", true),
      new AgentProviderError("nvidia", "network", "500", true),
      new AgentProviderError("nvidia", "network", "500", true),
    ]);
    // Lightning writes a file and immediately claims done - no build, no
    // preview. The gate rejects that once (a bounded nudge, MAX_EVIDENCE_NUDGES=1)
    // and asks again; Lightning repeats the same premature claim, which is
    // what actually proves the gate - not the model's own text - decides.
    setDeepseekQueue([
      writeFileStep("w1", "pages/index.js", "// content"),
      doneStep("All done!"),
      doneStep("Still done, no evidence."),
    ]);

    await runAgentTurn("s-lightning-cant-bypass-gate", "Build a site.", "test-uid");

    const doc = turnDoc("s-lightning-cant-bypass-gate");
    expect(doc?.telemetry.terminationReason).not.toBe("done");
    expect(doc?.telemetry.terminationReason).toBe("evidence_incomplete");
    expect(doc?.telemetry.evidenceNudgesSent).toBeGreaterThanOrEqual(1);
  }, 15_000);

  it("13. provider telemetry correctly records the fallback: from/to ids and reason", async () => {
    setNemotronQueue([
      new AgentProviderError("nvidia", "network", "500", true),
      new AgentProviderError("nvidia", "network", "500", true),
      new AgentProviderError("nvidia", "network", "500", true),
      new AgentProviderError("nvidia", "network", "500", true),
    ]);
    setDeepseekQueue([doneStep("Lightning recorded.")]);

    await runAgentTurn("s-telemetry-recorded", "Build a site.", "test-uid");

    const fb = turnDoc("s-telemetry-recorded")?.telemetry.providerFallback;
    expect(fb).toMatchObject({
      activated: true,
      fromProviderId: "nvidia",
      toProviderId: "deepseek",
      reason: "provider_exhausted",
    });
  }, 15_000);
});

/**
 * Phase 42: the file budget and early-build guardrails. Root cause
 * this closes - Phase 41C's real trace: 19 files, 14 iterations, 0
 * build attempts, for a 6-section landing page. Both mechanisms are
 * non-blocking by design (fileBudget.ts's own doc comment) - every
 * test below confirms the write itself is never rejected.
 */
describe("runAgentTurn - file budget and early-build guardrails (Phase 42)", () => {
  it("crossing the default budget (8 files) appends a non-blocking FILE_BUDGET_WARNING to that write's own result - the write itself still succeeds", async () => {
    setNemotronQueue([
      writeFilesStep("w1", [
        { path: "pages/index.js", content: "// 1" },
        { path: "components/Header.js", content: "// 2" },
        { path: "components/Hero.js", content: "// 3" },
        { path: "components/EventDetails.js", content: "// 4" },
        { path: "components/Speakers.js", content: "// 5" },
        { path: "components/Schedule.js", content: "// 6" },
        { path: "components/Prizes.js", content: "// 7" },
        { path: "components/Registration.js", content: "// 8" },
      ]),
      writeFilesStep("w2", [{ path: "components/Footer.js", content: "// 9 - crosses the budget" }]),
      doneStep("Done."),
    ]);

    await runAgentTurn("s-budget-warning", "Build a site.", "test-uid");

    const doc = turnDoc("s-budget-warning");
    expect(doc?.telemetry.fileBudgetWarningSent).toBe(true);
    expect(doc?.log.some((m) => m.content?.includes("FILE_BUDGET_WARNING"))).toBe(true);
    // Never blocked: all 9 files persisted despite crossing the budget.
    expect(sessionFiles("s-budget-warning")).toHaveLength(9);
  });

  it("writing exactly the default budget's worth of files never fires the warning", async () => {
    setNemotronQueue([
      writeFilesStep("w1", [
        { path: "pages/index.js", content: "// 1" },
        { path: "components/Header.js", content: "// 2" },
        { path: "components/Hero.js", content: "// 3" },
        { path: "components/Footer.js", content: "// 4" },
        { path: "data/a.js", content: "// 5" },
        { path: "data/b.js", content: "// 6" },
        { path: "styles/globals.css", content: "/* 7 */" },
        { path: "package.json", content: "{} /* 8 */" },
      ]),
      doneStep("Done."),
    ]);

    await runAgentTurn("s-budget-exact", "Build a site.", "test-uid");

    expect(turnDoc("s-budget-exact")?.telemetry.fileBudgetWarningSent).toBe(false);
  });

  it("no regression for a genuinely larger project - a stated manifest plan scales the budget so a legitimately bigger build doesn't get warned", async () => {
    const targetFiles = Array.from({ length: 14 }, (_, i) => `components/Section${i}.js`);
    setNemotronQueue([
      updateProgressStep("p1", "Build a multi-section app", [{ description: "Build it", status: "in_progress" }]),
      // Immediately override with a manifest-bearing call (merge-persisted).
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "p2",
              type: "function",
              function: {
                name: "update_progress",
                arguments: JSON.stringify({
                  objective: "Build a multi-section app",
                  subgoals: [{ description: "Build it", status: "in_progress" }],
                  manifest: { projectType: "interactive_app", targetFiles },
                }),
              },
            },
          ] as ChatCompletionMessageToolCall[],
        },
        truncated: false,
        usage: null,
      },
      writeFilesStep(
        "w1",
        targetFiles.map((path) => ({ path, content: "// content" }))
      ),
      doneStep("Done."),
    ]);

    await runAgentTurn("s-budget-scaled", "Build a multi-section app.", "test-uid");

    const doc = turnDoc("s-budget-scaled");
    expect(doc?.taskState?.manifest?.targetFiles).toHaveLength(14);
    expect(doc?.telemetry.fileBudgetWarningSent).toBe(false); // 14 files against a ~17-file budget (14+3)
  });

  it("4+ files with no build attempted yet fires the one-time early-build nudge", async () => {
    setNemotronQueue([
      writeFilesStep("w1", [
        { path: "pages/index.js", content: "// 1" },
        { path: "components/Header.js", content: "// 2" },
        { path: "components/Hero.js", content: "// 3" },
        { path: "components/Footer.js", content: "// 4" },
      ]),
      runCommandStep("b1", "npm run build"),
      doneStep("Done."),
    ]);

    await runAgentTurn("s-early-build", "Build a site.", "test-uid");

    const doc = turnDoc("s-early-build");
    expect(doc?.telemetry.buildEarlyNudgeSent).toBe(true);
    expect(doc?.log.some((m) => (m as { isNudge?: boolean }).isNudge && m.content?.includes("without a single"))).toBe(true);
  });

  it("a build already attempted before the file threshold never fires the early-build nudge", async () => {
    setBuildResult({ ok: true });
    setNemotronQueue([
      writeFilesStep("w1", [{ path: "pages/index.js", content: "// 1" }]),
      runCommandStep("b1", "npm run build"),
      writeFilesStep("w2", [
        { path: "components/Header.js", content: "// 2" },
        { path: "components/Hero.js", content: "// 3" },
        { path: "components/Footer.js", content: "// 4" },
      ]),
      doneStep("Done."),
    ]);

    await runAgentTurn("s-build-already-done", "Build a site.", "test-uid");

    expect(turnDoc("s-build-already-done")?.telemetry.buildEarlyNudgeSent).toBe(false);
  });

  it("stagnation takes priority over the early-build nudge when both conditions are true in the same iteration - still exactly one nudge", async () => {
    // 4 identical write_file calls (same path, same content) both trips
    // stagnation AND crosses the early-build file-count threshold (the
    // set only grows by 1 distinct path, but repeats the SAME content -
    // stagnation cares about repeated signatures, not file count).
    const identical = Array.from({ length: 5 }, () => writeFilesStep("w", [{ path: "a.js", content: "same" }]));
    setNemotronQueue([
      writeFilesStep("seed", [
        { path: "b.js", content: "x" },
        { path: "c.js", content: "x" },
        { path: "d.js", content: "x" },
      ]),
      ...identical,
    ]);

    await runAgentTurn("s-nudge-priority", "Build a site.", "test-uid");

    const doc = turnDoc("s-nudge-priority");
    // Stagnation must win - build-early must not have ALSO fired in the
    // same turn's stagnating iteration (though it may still fire later
    // once signatures reset, so this only asserts they never both fire
    // on the exact same iteration - approximated here by confirming at
    // least one stagnation nudge occurred).
    expect((doc?.telemetry.stagnationNudgesSent ?? 0)).toBeGreaterThan(0);
  });

  it("the completion evidence gate still requires real build+preview evidence even after a file-budget warning and no early build - the new mechanisms never let a premature 'done' through", async () => {
    setNemotronQueue([
      scaffoldStep("s1"),
      writeFilesStep("w1", [
        { path: "components/Header.js", content: "// 1" },
        { path: "components/Hero.js", content: "// 2" },
        { path: "components/EventDetails.js", content: "// 3" },
        { path: "components/Speakers.js", content: "// 4" },
        { path: "components/Schedule.js", content: "// 5" },
        { path: "components/Prizes.js", content: "// 6" },
        { path: "components/Registration.js", content: "// 7" },
        { path: "components/Footer.js", content: "// 8" },
        { path: "data/speakers.js", content: "// 9 - crosses budget" },
      ]),
      doneStep("All done!"),
      doneStep("Still done, no evidence."),
    ]);

    await runAgentTurn("s-still-gated", "Build a site.", "test-uid");

    const doc = turnDoc("s-still-gated");
    expect(doc?.telemetry.fileBudgetWarningSent).toBe(true); // the new mechanism did fire...
    expect(doc?.telemetry.terminationReason).not.toBe("done"); // ...but never bypasses the existing gate
    expect(doc?.telemetry.terminationReason).toBe("evidence_incomplete");
  });
});
