import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A single fake store shared across sessions/sessionFiles/checkpoints -
 * proposalStore.ts genuinely composes fileStore.ts and
 * checkpointStore.ts (both real, unmocked, imported transitively), so
 * this needs to support everything they need: doc get/set/update, a
 * where(field==) query, and a batch with set/update/commit.
 */
function makeFakeAdminDb() {
  // Keyed by "collection/id", never bare id - a checkpoints doc and a
  // sessionFiles doc can both have a `sessionId` field with the same
  // value, so where() must filter by collection too, not just by
  // field==value across one shared flat namespace.
  const store = new Map<string, Record<string, unknown>>();
  let autoIdCounter = 0;

  function docRef(collectionName: string, id: string) {
    const key = `${collectionName}/${id}`;
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
      async delete() {
        store.delete(key);
      },
    };
  }

  const collection = (name: string) => ({
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
  });

  const batch = () => {
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
          const key = ref._key;
          if (op === "update") store.set(key, { ...(store.get(key) ?? {}), ...data });
          else store.set(key, data);
        }
      },
    };
  };

  return { store, adminDb: { collection, batch } };
}

const fake = makeFakeAdminDb();
vi.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return fake.adminDb;
  },
}));

const { batchWriteSessionFiles, listSessionFiles } = await import("@/lib/files/fileStore");
const { createProposalSession, acceptProposal, archiveProposal, buildProposalTurnMessage } = await import(
  "@/lib/proposals/proposalStore"
);
const { listCheckpoints } = await import("@/lib/checkpoints/checkpointStore");

beforeEach(() => {
  fake.store.clear();
});

const originalSession = {
  id: "real-1",
  name: "Huddle Weather",
  ownerId: "owner-1",
  memberIds: ["owner-1", "collaborator-2"],
  createdAt: 1,
  updatedAt: 1,
  hasRealFiles: true,
  worldAccess: true,
};

async function seedOriginalFiles() {
  await batchWriteSessionFiles("real-1", [
    { path: "pages/index.js", content: "// original home page", updatedBy: "agent" },
  ]);
}

describe("createProposalSession", () => {
  it("copies the original session's files into a new, isolated session", async () => {
    await seedOriginalFiles();
    const feedback = { id: "fb-1", sessionId: "real-1", text: "cards are cramped", status: "new" as const, createdAt: 1 };

    const proposal = await createProposalSession(originalSession, feedback);

    expect(proposal.id).not.toBe("real-1");
    expect(proposal.isProposal).toBe(true);
    expect(proposal.proposalOf).toBe("real-1");
    expect(proposal.proposalFeedbackId).toBe("fb-1");

    const proposalFiles = await listSessionFiles(proposal.id);
    expect(proposalFiles.map((f) => f.path)).toEqual(["pages/index.js"]);
    expect(proposalFiles[0].content).toBe("// original home page");
  });

  it("does NOT modify the original session's own files", async () => {
    await seedOriginalFiles();
    const feedback = { id: "fb-1", sessionId: "real-1", text: "x", status: "new" as const, createdAt: 1 };
    await createProposalSession(originalSession, feedback);

    const originalFiles = await listSessionFiles("real-1");
    expect(originalFiles.map((f) => f.path)).toEqual(["pages/index.js"]);
    expect(originalFiles[0].content).toBe("// original home page");
  });

  it("copies memberIds and ownerId from the original session, so every real collaborator (not just the owner) can review it", async () => {
    await seedOriginalFiles();
    const feedback = { id: "fb-1", sessionId: "real-1", text: "x", status: "new" as const, createdAt: 1 };
    const proposal = await createProposalSession(originalSession, feedback);

    expect(proposal.ownerId).toBe("owner-1");
    expect(proposal.memberIds).toEqual(["owner-1", "collaborator-2"]);
  });
});

describe("buildProposalTurnMessage", () => {
  it("frames the visitor's text as feedback to evaluate, not as an owner instruction", () => {
    const message = buildProposalTurnMessage("add dark mode");
    expect(message).toContain("visitor");
    expect(message).toContain("add dark mode");
    expect(message.toLowerCase()).toContain("evaluate");
  });
});

describe("acceptProposal", () => {
  it("copies the proposal's files back into the real (proposalOf) session", async () => {
    await seedOriginalFiles();
    const feedback = { id: "fb-1", sessionId: "real-1", text: "x", status: "new" as const, createdAt: 1 };
    const proposal = await createProposalSession(originalSession, feedback);

    // Simulate the agent turn changing the proposal's own files.
    await batchWriteSessionFiles(proposal.id, [
      { path: "pages/index.js", content: "// spacious cards", updatedBy: "agent" },
    ]);

    await acceptProposal(proposal);

    const realFiles = await listSessionFiles("real-1");
    expect(realFiles.find((f) => f.path === "pages/index.js")?.content).toBe("// spacious cards");
  });

  it("creates a checkpoint of the real project before overwriting it", async () => {
    await seedOriginalFiles();
    const feedback = { id: "fb-1", sessionId: "real-1", text: "x", status: "new" as const, createdAt: 1 };
    const proposal = await createProposalSession(originalSession, feedback);
    await batchWriteSessionFiles(proposal.id, [{ path: "pages/index.js", content: "// new", updatedBy: "agent" }]);

    await acceptProposal(proposal);

    const checkpoints = await listCheckpoints("real-1");
    expect(checkpoints.length).toBe(1);
    expect(checkpoints[0].files.find((f) => f.path === "pages/index.js")?.content).toBe("// original home page");
  });

  it("never writes to any session other than proposalOf", async () => {
    await batchWriteSessionFiles("other-session", [{ path: "unrelated.js", content: "leave me alone", updatedBy: "agent" }]);
    await seedOriginalFiles();
    const feedback = { id: "fb-1", sessionId: "real-1", text: "x", status: "new" as const, createdAt: 1 };
    const proposal = await createProposalSession(originalSession, feedback);
    await acceptProposal(proposal);

    const other = await listSessionFiles("other-session");
    expect(other[0].content).toBe("leave me alone");
  });
});

describe("archiveProposal (reject)", () => {
  it("marks the proposal session archived and never touches the real session's files", async () => {
    await seedOriginalFiles();
    const feedback = { id: "fb-1", sessionId: "real-1", text: "x", status: "new" as const, createdAt: 1 };
    const proposal = await createProposalSession(originalSession, feedback);
    await batchWriteSessionFiles(proposal.id, [{ path: "pages/index.js", content: "// rejected attempt", updatedBy: "agent" }]);

    await archiveProposal(proposal);

    const stored = fake.store.get(`sessions/${proposal.id}`) as { archived?: boolean };
    expect(stored.archived).toBe(true);

    const realFiles = await listSessionFiles("real-1");
    expect(realFiles.find((f) => f.path === "pages/index.js")?.content).toBe("// original home page");
  });
});
