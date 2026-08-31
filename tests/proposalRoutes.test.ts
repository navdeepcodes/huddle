import { beforeEach, describe, expect, it, vi } from "vitest";

const getVerifiedUid = vi.fn();
vi.mock("@/lib/auth/verifyRequest", () => ({
  getVerifiedUid: (...args: unknown[]) => getVerifiedUid(...args),
}));

const runAgentTurn = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/agent/loop", () => ({
  runAgentTurn: (...args: unknown[]) => runAgentTurn(...args),
}));

vi.mock("@/lib/agent/providerResolution", () => ({
  resolveAgentProviders: vi.fn().mockResolvedValue({ providers: [{}], nemotronSource: "platform" }),
}));

const store = new Map<string, Record<string, unknown>>();
let autoIdCounter = 0;

function docRef(collection: string, id: string) {
  const key = `${collection}/${id}`;
  return {
    id,
    _key: key,
    async get() {
      return { exists: store.has(key), data: () => store.get(key) };
    },
    async set(data: Record<string, unknown>) {
      store.set(key, data);
    },
    async update(patch: Record<string, unknown>) {
      store.set(key, { ...(store.get(key) ?? {}), ...patch });
    },
  };
}

const adminDb = {
  collection: (name: string) => ({
    doc: (id?: string) => docRef(name, id ?? `auto-${autoIdCounter++}`),
    where: (field: string, _op: string, value: unknown) => ({
      async get() {
        const prefix = `${name}/`;
        const docs = Array.from(store.entries())
          .filter(([key, data]) => key.startsWith(prefix) && data[field] === value)
          .map(([key, data]) => ({ data: () => data, id: key.slice(prefix.length) }));
        return { docs };
      },
    }),
  }),
  // Phase 39 (Batch 1): the proposal-retry route now calls
  // claimTurnAuthoritative (a real transaction) before its mocked
  // runAgentTurn - no concurrency is under test here (unlike
  // turnRouteConcurrency.test.ts), so a plain sequential run of the
  // callback against the same fake store is sufficient, same pattern
  // as tests/runtimeHostAdmin.test.ts's fake.
  runTransaction: async (
    fn: (tx: {
      get: (ref: ReturnType<typeof docRef>) => Promise<{ exists: boolean; data: () => unknown }>;
      set: (ref: ReturnType<typeof docRef>, data: Record<string, unknown>) => void;
      update: (ref: ReturnType<typeof docRef>, data: Record<string, unknown>) => void;
    }) => Promise<unknown>
  ) => {
    const tx = {
      get: (ref: ReturnType<typeof docRef>) => ref.get(),
      set: (ref: ReturnType<typeof docRef>, data: Record<string, unknown>) => {
        void ref.set(data);
      },
      update: (ref: ReturnType<typeof docRef>, data: Record<string, unknown>) => {
        void ref.update(data);
      },
    };
    return fn(tx);
  },
  batch: () => {
    const pending: Array<{ ref: ReturnType<typeof docRef>; data: Record<string, unknown>; op: "set" | "update" }> = [];
    return {
      set(ref: ReturnType<typeof docRef>, data: Record<string, unknown>) {
        pending.push({ ref, data, op: "set" });
      },
      update(ref: ReturnType<typeof docRef>, data: Record<string, unknown>) {
        pending.push({ ref, data, op: "update" });
      },
      async commit() {
        for (const { ref, data, op } of pending) {
          const key = (ref as ReturnType<typeof docRef>)._key;
          if (op === "update") store.set(key, { ...(store.get(key) ?? {}), ...data });
          else store.set(key, data);
        }
      },
    };
  },
};
vi.mock("@/lib/firebase/admin", () => ({ adminDb }));

const { POST: tryFeedback } = await import("@/app/api/sessions/[sessionId]/feedback/[feedbackId]/try/route");
const { POST: acceptProposalRoute } = await import("@/app/api/sessions/[sessionId]/proposal/accept/route");
const { POST: rejectProposalRoute } = await import("@/app/api/sessions/[sessionId]/proposal/reject/route");
const { listSessionFiles, batchWriteSessionFiles } = await import("@/lib/files/fileStore");

function post(url: string) {
  return new Request(url, { method: "POST", headers: { Authorization: "Bearer fake" } }) as unknown as import("next/server").NextRequest;
}

beforeEach(() => {
  store.clear();
  autoIdCounter = 0;
  getVerifiedUid.mockReset();
  getVerifiedUid.mockResolvedValue("owner-1");
  runAgentTurn.mockClear();

  store.set("sessions/real-1", {
    id: "real-1",
    ownerId: "owner-1",
    memberIds: ["owner-1"],
    hasRealFiles: true,
    worldAccess: true,
  });
  store.set("sessionFeedback/fb-1", {
    id: "fb-1",
    sessionId: "real-1",
    text: "the mobile cards are too cramped",
    status: "new",
    createdAt: 1,
  });
});

describe("POST .../feedback/[feedbackId]/try - the ONLY expensive path, and only for real project members", () => {
  it("rejects an unauthenticated caller and never starts a turn", async () => {
    getVerifiedUid.mockResolvedValue(null);
    const res = await tryFeedback(post("http://localhost/x"), { params: Promise.resolve({ sessionId: "real-1", feedbackId: "fb-1" }) });
    expect(res.status).toBe(401);
    expect(runAgentTurn).not.toHaveBeenCalled();
  });

  it("rejects a caller who isn't a member of the project", async () => {
    getVerifiedUid.mockResolvedValue("stranger");
    const res = await tryFeedback(post("http://localhost/x"), { params: Promise.resolve({ sessionId: "real-1", feedbackId: "fb-1" }) });
    expect(res.status).toBe(403);
    expect(runAgentTurn).not.toHaveBeenCalled();
  });

  it("creates an isolated proposal session and runs the turn against the PROPOSAL id, not the real sessionId", async () => {
    const res = await tryFeedback(post("http://localhost/x"), { params: Promise.resolve({ sessionId: "real-1", feedbackId: "fb-1" }) });
    expect(res.status).toBe(200);
    const { proposalSessionId } = await res.json();
    expect(proposalSessionId).not.toBe("real-1");

    expect(runAgentTurn).toHaveBeenCalledTimes(1);
    const [calledSessionId, calledMessage] = runAgentTurn.mock.calls[0] as [string, string, string, string[]];
    expect(calledSessionId).toBe(proposalSessionId);
    expect(calledMessage).toContain("cramped");
  });

  it("marks the feedback 'trying' and links it to the proposal session", async () => {
    const res = await tryFeedback(post("http://localhost/x"), { params: Promise.resolve({ sessionId: "real-1", feedbackId: "fb-1" }) });
    const { proposalSessionId } = await res.json();
    const feedback = store.get("sessionFeedback/fb-1") as { status: string; proposalSessionId: string };
    expect(feedback.status).toBe("trying");
    expect(feedback.proposalSessionId).toBe(proposalSessionId);
  });

  it("refuses to try the same feedback twice", async () => {
    await tryFeedback(post("http://localhost/x"), { params: Promise.resolve({ sessionId: "real-1", feedbackId: "fb-1" }) });
    const second = await tryFeedback(post("http://localhost/x"), { params: Promise.resolve({ sessionId: "real-1", feedbackId: "fb-1" }) });
    expect(second.status).toBe(409);
    expect(runAgentTurn).toHaveBeenCalledTimes(1);
  });
});

describe("POST .../proposal/accept and /reject - isolation invariants", () => {
  async function createProposal() {
    const res = await tryFeedback(post("http://localhost/x"), { params: Promise.resolve({ sessionId: "real-1", feedbackId: "fb-1" }) });
    return (await res.json()).proposalSessionId as string;
  }

  it("accept copies the proposal's files into the real project", async () => {
    const proposalId = await createProposal();
    await batchWriteSessionFiles(proposalId, [{ path: "pages/index.js", content: "// fixed cards", updatedBy: "agent" }]);

    const res = await acceptProposalRoute(post("http://localhost/x"), { params: Promise.resolve({ sessionId: proposalId }) });
    expect(res.status).toBe(200);

    const realFiles = await listSessionFiles("real-1");
    expect(realFiles.find((f) => f.path === "pages/index.js")?.content).toBe("// fixed cards");
  });

  it("accept marks the originating feedback 'accepted'", async () => {
    const proposalId = await createProposal();
    await acceptProposalRoute(post("http://localhost/x"), { params: Promise.resolve({ sessionId: proposalId }) });
    const feedback = store.get("sessionFeedback/fb-1") as { status: string };
    expect(feedback.status).toBe("accepted");
  });

  it("reject does NOT change the real project's files", async () => {
    const proposalId = await createProposal();
    await batchWriteSessionFiles(proposalId, [{ path: "pages/index.js", content: "// a bad attempt", updatedBy: "agent" }]);
    await batchWriteSessionFiles("real-1", [{ path: "pages/index.js", content: "// untouched original", updatedBy: "agent" }]);

    const res = await rejectProposalRoute(post("http://localhost/x"), { params: Promise.resolve({ sessionId: proposalId }) });
    expect(res.status).toBe(200);

    const realFiles = await listSessionFiles("real-1");
    expect(realFiles.find((f) => f.path === "pages/index.js")?.content).toBe("// untouched original");
  });

  it("reject marks the originating feedback 'rejected'", async () => {
    const proposalId = await createProposal();
    await rejectProposalRoute(post("http://localhost/x"), { params: Promise.resolve({ sessionId: proposalId }) });
    const feedback = store.get("sessionFeedback/fb-1") as { status: string };
    expect(feedback.status).toBe("rejected");
  });

  it("accept/reject reject a caller who isn't a member of the proposal session", async () => {
    const proposalId = await createProposal();
    getVerifiedUid.mockResolvedValue("stranger");
    const res = await acceptProposalRoute(post("http://localhost/x"), { params: Promise.resolve({ sessionId: proposalId }) });
    expect(res.status).toBe(403);
  });

  it("refuses to accept/reject an ordinary (non-proposal) session", async () => {
    const res = await acceptProposalRoute(post("http://localhost/x"), { params: Promise.resolve({ sessionId: "real-1" }) });
    expect(res.status).toBe(422);
  });
});
