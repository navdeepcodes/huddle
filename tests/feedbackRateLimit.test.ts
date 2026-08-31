import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function makeFakeAdminDb() {
  const store = new Map<string, Record<string, unknown>>();

  function docRef(id: string) {
    return { id };
  }

  const collection = () => ({
    doc: (id: string) => docRef(id),
  });

  const runTransaction = async (fn: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      async get(ref: { id: string }) {
        return { data: () => store.get(ref.id) };
      },
      set(ref: { id: string }, data: Record<string, unknown>) {
        store.set(ref.id, data);
      },
      update(ref: { id: string }, patch: Record<string, unknown>) {
        store.set(ref.id, { ...(store.get(ref.id) ?? {}), ...patch });
      },
    };
    return fn(tx);
  };

  return { store, adminDb: { collection, runTransaction } };
}

const fake = makeFakeAdminDb();
vi.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return fake.adminDb;
  },
}));

const { checkFeedbackRateLimit, getClientIp } = await import("@/lib/feedback/rateLimit");

beforeEach(() => {
  fake.store.clear();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("checkFeedbackRateLimit", () => {
  it("allows the first several submissions from the same (session, ip) pair", async () => {
    for (let i = 0; i < 5; i++) {
      expect(await checkFeedbackRateLimit("s1", "1.2.3.4")).toBe(true);
    }
  });

  it("blocks the 6th submission within the same window", async () => {
    for (let i = 0; i < 5; i++) await checkFeedbackRateLimit("s1", "1.2.3.4");
    expect(await checkFeedbackRateLimit("s1", "1.2.3.4")).toBe(false);
  });

  it("does not let a blocked ip affect a different session or a different ip", async () => {
    for (let i = 0; i < 5; i++) await checkFeedbackRateLimit("s1", "1.2.3.4");
    expect(await checkFeedbackRateLimit("s2", "1.2.3.4")).toBe(true);
    expect(await checkFeedbackRateLimit("s1", "5.6.7.8")).toBe(true);
  });

  it("resets once the window has elapsed", async () => {
    for (let i = 0; i < 5; i++) await checkFeedbackRateLimit("s1", "1.2.3.4");
    expect(await checkFeedbackRateLimit("s1", "1.2.3.4")).toBe(false);

    vi.advanceTimersByTime(11 * 60_000);
    expect(await checkFeedbackRateLimit("s1", "1.2.3.4")).toBe(true);
  });
});

describe("getClientIp", () => {
  it("reads the first entry of x-forwarded-for", () => {
    const req = new Request("http://localhost", { headers: { "x-forwarded-for": "9.9.9.9, 10.0.0.1" } });
    expect(getClientIp(req)).toBe("9.9.9.9");
  });

  it("falls back to 'unknown' when the header is absent (e.g. local dev)", () => {
    const req = new Request("http://localhost");
    expect(getClientIp(req)).toBe("unknown");
  });
});
