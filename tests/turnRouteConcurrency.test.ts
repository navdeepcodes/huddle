import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Phase 28 Test D: a real integration test proving the server-side
 * 409 lock actually closes the concurrency window, not just that
 * turnRegistry's isTurnActive works in isolation (tests/
 * turnRegistry.test.ts already covers that). Live investigation this
 * phase found the lock was NOT closed - registerTurn happened only
 * after two Firestore round-trips inside runAgentTurn, and the route
 * awaited request.json() AFTER its isTurnActive check, so two
 * genuinely concurrent POSTs for the same session could both pass
 * the check before either registered. Both were fixed (loop.ts:
 * registerTurn is now the first synchronous statement; route.ts: the
 * isTurnActive check now immediately precedes the runAgentTurn call
 * with no await between them). This test drives the REAL route
 * handler and the REAL runAgentTurn (loop.ts), mocking only the
 * external edges (Firestore, the model provider, checkpoint
 * creation) - a mocked implementation of runAgentTurn itself would
 * prove nothing about the actual fix.
 */

const getVerifiedUid = vi.fn();
vi.mock("@/lib/auth/verifyRequest", () => ({
  getVerifiedUid: (...args: unknown[]) => getVerifiedUid(...args),
}));

const firestoreDocs = new Map<string, unknown>();
function fakeDoc(collection: string, id: string) {
  const key = `${collection}/${id}`;
  return {
    get: async () => ({
      exists: firestoreDocs.has(key),
      data: () => firestoreDocs.get(key),
    }),
    set: async (value: unknown) => {
      firestoreDocs.set(key, value);
    },
    update: async (patch: Record<string, unknown>) => {
      firestoreDocs.set(key, { ...(firestoreDocs.get(key) as object), ...patch });
    },
  };
}
/**
 * Phase 39 (Batch 1): the turn route now claims via
 * claimTurnAuthoritative (a real Firestore transaction) instead of the
 * old in-memory-only isTurnActive check - this test is SPECIFICALLY
 * about genuine concurrency (two real-simultaneous POSTs via
 * Promise.all), so the fake runTransaction must actually provide
 * mutual exclusion, not just be callable. A naive fake that runs the
 * callback immediately would let both concurrent calls' `tx.get`
 * reads interleave before either `tx.set` write lands - exactly the
 * race this test exists to prove is closed. Chaining onto a single
 * module-level lock so only one transaction body executes at a time
 * simulates Firestore's real per-document serialization closely enough
 * for this single-session test (unlike runtimeHostAdmin.test.ts's fake,
 * whose own comment says it's only sufficient for sequential calls).
 */
let transactionLock: Promise<void> = Promise.resolve();
async function runTransaction<T>(
  fn: (tx: {
    get: (ref: ReturnType<typeof fakeDoc>) => Promise<{ exists: boolean; data: () => unknown }>;
    set: (ref: ReturnType<typeof fakeDoc>, data: Record<string, unknown>) => void;
    update: (ref: ReturnType<typeof fakeDoc>, data: Record<string, unknown>) => void;
  }) => Promise<T>
): Promise<T> {
  const previous = transactionLock;
  let release: () => void = () => {};
  transactionLock = new Promise((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    const tx = {
      get: (ref: ReturnType<typeof fakeDoc>) => ref.get(),
      set: (ref: ReturnType<typeof fakeDoc>, data: Record<string, unknown>) => {
        void ref.set(data);
      },
      update: (ref: ReturnType<typeof fakeDoc>, data: Record<string, unknown>) => {
        void ref.update(data);
      },
    };
    return await fn(tx);
  } finally {
    release();
  }
}

const adminDb = {
  collection: (name: string) => ({
    doc: (id: string) => fakeDoc(name, id),
  }),
  runTransaction,
};
vi.mock("@/lib/firebase/admin", () => ({ adminDb }));

// Deferred so the test controls exactly when the (mocked) model call
// resolves - proves registration happens BEFORE this ever resolves,
// not just before it's called.
let releaseFirstStep: (() => void) | null = null;
const generateStepWithRecovery = vi.fn(async () => {
  if (releaseFirstStep === null) {
    // First call: hang until the test explicitly releases it.
    await new Promise<void>((resolve) => {
      releaseFirstStep = resolve;
    });
  }
  return {
    step: { message: { role: "assistant", content: "Done.", tool_calls: [] }, truncated: false },
  };
});
vi.mock("@/lib/agent/providerRecovery", () => ({
  generateStepWithRecovery: () => generateStepWithRecovery(),
}));

vi.mock("@/lib/checkpoints/checkpointStore", () => ({
  createCheckpoint: vi.fn(async () => {}),
}));

// Phase 29: the route's own pre-flight credential check (and loop.ts's
// internal resolution) both go through resolveAgentProviders now -
// mocked directly, same reasoning as loop.test.ts's own mock, so this
// test stays about concurrency, not credential resolution.
vi.mock("@/lib/agent/providerResolution", () => ({
  resolveAgentProviders: vi.fn().mockResolvedValue({ providers: [{}], nemotronSource: "platform" }),
}));

const { POST } = await import("@/app/api/sessions/[sessionId]/turn/route");
const { isTurnActive } = await import("@/lib/agent/turnRegistry");

async function waitUntilTurnInactive(sessionId: string, maxTicks = 50): Promise<void> {
  for (let i = 0; i < maxTicks && isTurnActive(sessionId); i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

function req(message: string) {
  return new Request("http://localhost/api/sessions/s1/turn", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer fake" },
    body: JSON.stringify({ message }),
  }) as unknown as import("next/server").NextRequest;
}

beforeEach(() => {
  firestoreDocs.clear();
  releaseFirstStep = null;
  getVerifiedUid.mockReset();
  getVerifiedUid.mockResolvedValue("user-a");
  generateStepWithRecovery.mockClear();
  firestoreDocs.set("sessions/s1", { id: "s1", memberIds: ["user-a", "user-b"] });
});

describe("POST /api/sessions/[sessionId]/turn - concurrent requests (Phase 28 Test D)", () => {
  it("accepts the first of two genuinely concurrent requests and rejects the second with 409 - never both", async () => {
    const params = Promise.resolve({ sessionId: "s1" });

    const [resA, resB] = await Promise.all([
      POST(req("Request A"), { params }),
      POST(req("Request B"), { params }),
    ]);

    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([200, 409]);

    const bodies = await Promise.all([resA.json(), resB.json()]);
    const rejected = resA.status === 409 ? bodies[0] : bodies[1];
    expect(rejected.error).toMatch(/already running/i);

    // Exactly one turn actually started - the model provider was
    // only ever invoked once, proving the second request never
    // reached runAgentTurn's real work at all (not just that it got
    // a 409 while a duplicate turn ran anyway in the background).
    expect(generateStepWithRecovery).toHaveBeenCalledTimes(1);

    releaseFirstStep?.();
    await waitUntilTurnInactive("s1");

    const turn = firestoreDocs.get("agentTurns/s1") as { active: boolean } | undefined;
    expect(turn?.active).toBe(false);
  });

  it("allows a second request to start a new turn once the first has fully finished", async () => {
    const params = Promise.resolve({ sessionId: "s1" });

    const first = POST(req("Request A"), { params });
    // generateStepWithRecovery isn't reached synchronously - the route
    // and runAgentTurn each have their own real awaits before it (auth
    // verification, the session lookup, request.json(), turnRef.get()).
    // Poll for the mock to actually be mid-call before releasing it.
    for (let i = 0; i < 50 && releaseFirstStep === null; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    releaseFirstStep?.();
    const resA = await first;
    expect(resA.status).toBe(200);

    // Wait for the (now-released) turn to actually finish and unregister.
    await waitUntilTurnInactive("s1");

    const resB = await POST(req("Request B"), { params });
    expect(resB.status).toBe(200);
  });
});

describe("POST /api/sessions/[sessionId]/turn - missing-key handling (Phase 29 Part 1/13)", () => {
  it("returns a clean 422 with an actionable message, and never starts a turn, when no provider is available", async () => {
    const { resolveAgentProviders } = await import("@/lib/agent/providerResolution");
    vi.mocked(resolveAgentProviders).mockResolvedValueOnce({ providers: [], nemotronSource: "unavailable" });

    const params = Promise.resolve({ sessionId: "s1" });
    const res = await POST(req("Build something"), { params });

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/no nemotron api key is configured/i);
    expect(generateStepWithRecovery).not.toHaveBeenCalled();
  });

  it("the pre-flight check happens before the isTurnActive check consumes the request - no turn is registered either way", async () => {
    const { resolveAgentProviders } = await import("@/lib/agent/providerResolution");
    vi.mocked(resolveAgentProviders).mockResolvedValueOnce({ providers: [], nemotronSource: "unavailable" });

    const params = Promise.resolve({ sessionId: "s1" });
    await POST(req("Build something"), { params });

    const { isTurnActive } = await import("@/lib/agent/turnRegistry");
    expect(isTurnActive("s1")).toBe(false);
  });
});
