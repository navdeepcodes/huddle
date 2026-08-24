import { describe, expect, it, vi, beforeEach } from "vitest";

/** Phase 28 Part 2: "stale users disappear after a bounded timeout" - PRESENCE_STALE_MS's own filtering, previously untested. */
const docs: Array<{ data: () => unknown }> = [];
const adminDb = {
  collection: () => ({
    where: () => ({ get: async () => ({ docs }) }),
    doc: () => ({ set: vi.fn(), delete: vi.fn() }),
  }),
};
vi.mock("@/lib/firebase/admin", () => ({ adminDb }));

const { listActivePresence, PRESENCE_STALE_MS } = await import("@/lib/presence/presenceStore");

function entry(uid: string, ageMs: number) {
  return { data: () => ({ sessionId: "s1", uid, tabId: `${uid}-tab`, heartbeatAt: Date.now() - ageMs }) };
}

beforeEach(() => {
  docs.length = 0;
});

describe("listActivePresence (Phase 28 Part 2)", () => {
  it("includes an entry heartbeated well within the stale window", async () => {
    docs.push(entry("fresh", 1_000));
    const result = await listActivePresence("s1");
    expect(result.map((p) => p.uid)).toEqual(["fresh"]);
  });

  it("excludes an entry whose last heartbeat is past PRESENCE_STALE_MS", async () => {
    docs.push(entry("stale", PRESENCE_STALE_MS + 5_000));
    const result = await listActivePresence("s1");
    expect(result).toEqual([]);
  });

  it("filters a mix correctly - stale users disappear, fresh ones don't", async () => {
    docs.push(entry("fresh", 500), entry("stale", PRESENCE_STALE_MS * 2));
    const result = await listActivePresence("s1");
    expect(result.map((p) => p.uid)).toEqual(["fresh"]);
  });
});
