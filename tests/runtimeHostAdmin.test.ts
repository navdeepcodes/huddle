import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Minimal in-memory stand-in for the slice of the Admin Firestore SDK
 * runtimeHostAdmin.ts actually uses - one doc store, get/update, and a
 * runTransaction that runs its callback against the same store
 * (sufficient for these sequential-call tests; no real concurrent-
 * transaction retry semantics needed here).
 */
function makeFakeAdminDb() {
  const store = new Map<string, Record<string, unknown>>();

  function docRef(id: string) {
    return {
      async get() {
        return { data: () => store.get(id) };
      },
      async update(partial: Record<string, unknown>) {
        store.set(id, { ...(store.get(id) ?? {}), ...partial });
      },
      async set(data: Record<string, unknown>) {
        store.set(id, data);
      },
    };
  }

  return {
    store,
    adminDb: {
      collection: () => ({
        doc: (id: string) => docRef(id),
      }),
      runTransaction: async (fn: (tx: { get: (ref: ReturnType<typeof docRef>) => Promise<{ data: () => Record<string, unknown> | undefined }>; set: (ref: ReturnType<typeof docRef>, data: Record<string, unknown>) => void }) => Promise<unknown>) => {
        const tx = {
          get: (ref: ReturnType<typeof docRef>) => ref.get(),
          set: (ref: ReturnType<typeof docRef>, data: Record<string, unknown>) => {
            void ref.set(data);
          },
        };
        return fn(tx);
      },
    },
  };
}

const fake = makeFakeAdminDb();

vi.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return fake.adminDb;
  },
}));

const { claimRuntimeHost, heartbeatRuntimeHost, reportRuntimeHostState, RuntimeHostClaimError, RUNTIME_HOST_STALE_MS } =
  await import("@/lib/runtime/runtimeHostAdmin");

beforeEach(() => {
  fake.store.clear();
  vi.useRealTimers();
});

describe("claimRuntimeHost", () => {
  it("succeeds on a fresh session with no existing host doc", async () => {
    const host = await claimRuntimeHost("s1", "tabA");
    expect(host.ownerTabId).toBe("tabA");
    expect(host.state).toBe("starting");
  });

  it("rejects a different tab while the current owner's heartbeat is fresh", async () => {
    await claimRuntimeHost("s1", "tabA");
    await expect(claimRuntimeHost("s1", "tabB")).rejects.toBeInstanceOf(RuntimeHostClaimError);
  });

  it("allows the SAME tab to reclaim (idempotent re-run)", async () => {
    await claimRuntimeHost("s1", "tabA");
    const host = await claimRuntimeHost("s1", "tabA");
    expect(host.ownerTabId).toBe("tabA");
  });

  it("regression: two concurrent claims with the SAME tabId (React Strict Mode's double-invoke) both succeed, regardless of which commits first", async () => {
    // Before the useRuntimeHost fix, Strict Mode's two effect invocations
    // minted two DIFFERENT tabIds for what is the same logical tab, so one
    // invocation's claim could win while the other got a genuine 409 and
    // both abandoned. Once both invocations share one stable tabId (the
    // fix), this is exactly the same-tab-reclaim path above, just fired
    // concurrently instead of sequentially - neither call may reject.
    const [hostA, hostB] = await Promise.all([
      claimRuntimeHost("s1", "tabA"),
      claimRuntimeHost("s1", "tabA"),
    ]);
    expect(hostA.ownerTabId).toBe("tabA");
    expect(hostB.ownerTabId).toBe("tabA");
  });

  it("a genuinely different tab is still rejected even when racing the same claim window", async () => {
    await expect(
      Promise.all([claimRuntimeHost("s1", "tabA"), claimRuntimeHost("s1", "tabB")])
    ).rejects.toBeInstanceOf(RuntimeHostClaimError);
  });

  it("a stale runtime (heartbeat older than RUNTIME_HOST_STALE_MS) can be reclaimed by a different tab", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      await claimRuntimeHost("s1", "tabA");

      vi.setSystemTime(RUNTIME_HOST_STALE_MS + 1);
      const host = await claimRuntimeHost("s1", "tabB");

      expect(host.ownerTabId).toBe("tabB");
      expect(host.state).toBe("starting");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("heartbeatRuntimeHost", () => {
  it("succeeds for the current owner and bumps heartbeatAt", async () => {
    await claimRuntimeHost("s1", "tabA");
    const ok = await heartbeatRuntimeHost("s1", "tabA");
    expect(ok).toBe(true);
    expect(fake.store.get("s1")?.heartbeatAt).toBeTypeOf("number");
  });

  it("fails silently (returns false, doesn't throw) for a non-owner tab", async () => {
    await claimRuntimeHost("s1", "tabA");
    const ok = await heartbeatRuntimeHost("s1", "tabB");
    expect(ok).toBe(false);
  });

  it("fails for a session with no host doc at all", async () => {
    const ok = await heartbeatRuntimeHost("nonexistent", "tabA");
    expect(ok).toBe(false);
  });
});

describe("reportRuntimeHostState", () => {
  it("updates state and extras for the current owner", async () => {
    await claimRuntimeHost("s1", "tabA");
    const ok = await reportRuntimeHostState("s1", "tabA", "running", { port: 5173, previewUrl: "https://x" });
    expect(ok).toBe(true);
    expect(fake.store.get("s1")).toMatchObject({ state: "running", port: 5173, previewUrl: "https://x" });
  });

  it("a report from a stale/superseded tabId is rejected, not silently accepted", async () => {
    await claimRuntimeHost("s1", "tabA");
    const ok = await reportRuntimeHostState("s1", "tabGhost", "installing");
    expect(ok).toBe(false);
    expect(fake.store.get("s1")?.state).toBe("starting"); // unchanged
  });
});
