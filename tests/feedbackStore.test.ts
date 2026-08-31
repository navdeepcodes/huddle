import { beforeEach, describe, expect, it, vi } from "vitest";

/** Same shape as tests/fileStore.test.ts's fake, extended with set() and auto-id doc() for createFeedback's `adminDb.collection(...).doc()` (no id) call. */
function makeFakeAdminDb() {
  const store = new Map<string, Record<string, unknown>>();
  let autoIdCounter = 0;

  function docRef(id: string) {
    return {
      id,
      async get() {
        return { exists: store.has(id), data: () => store.get(id) };
      },
      async set(data: Record<string, unknown>) {
        store.set(id, data);
      },
      async update(patch: Record<string, unknown>) {
        store.set(id, { ...(store.get(id) ?? {}), ...patch });
      },
    };
  }

  const collection = () => ({
    doc: (id?: string) => docRef(id ?? `auto-${autoIdCounter++}`),
    where: (field: string, _op: string, value: unknown) => ({
      async get() {
        const docs = Array.from(store.entries())
          .filter(([, data]) => data[field] === value)
          .map(([id, data]) => ({ data: () => data, id }));
        return { docs };
      },
    }),
  });

  return { store, adminDb: { collection } };
}

const fake = makeFakeAdminDb();
vi.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return fake.adminDb;
  },
}));

const { createFeedback, listFeedback, getFeedback, updateFeedbackStatus } = await import("@/lib/feedback/feedbackStore");

beforeEach(() => {
  fake.store.clear();
});

describe("feedbackStore", () => {
  it("creates feedback with status 'new' and trims the text", async () => {
    const f = await createFeedback("s1", "  the cards are cramped  ");
    expect(f.sessionId).toBe("s1");
    expect(f.text).toBe("the cards are cramped");
    expect(f.status).toBe("new");
  });

  it("bounds feedback text to 2000 characters", async () => {
    const f = await createFeedback("s1", "x".repeat(5000));
    expect(f.text.length).toBe(2000);
  });

  it("lists only the requesting session's feedback, newest first", async () => {
    await createFeedback("s1", "first");
    await new Promise((r) => setTimeout(r, 2));
    await createFeedback("s1", "second");
    await createFeedback("s2", "unrelated");

    const list = await listFeedback("s1");
    expect(list.map((f) => f.text)).toEqual(["second", "first"]);
  });

  it("getFeedback returns null for a feedbackId that belongs to a different session (cross-session isolation)", async () => {
    const f = await createFeedback("s1", "hello");
    expect(await getFeedback("s2", f.id)).toBeNull();
    expect(await getFeedback("s1", f.id)).not.toBeNull();
  });

  it("updateFeedbackStatus transitions status and optionally records the proposal session id", async () => {
    const f = await createFeedback("s1", "hello");
    await updateFeedbackStatus(f.id, "trying", "proposal-1");
    const updated = await getFeedback("s1", f.id);
    expect(updated?.status).toBe("trying");
    expect(updated?.proposalSessionId).toBe("proposal-1");
  });

  it("stores an optional notifyToken and viewport when provided", async () => {
    const f = await createFeedback("s1", "hello", { width: 390, height: 844 }, "tok-123");
    expect(f.viewport).toEqual({ width: 390, height: 844 });
    expect(f.notifyToken).toBe("tok-123");
  });
});
