import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Same shape as tests/runtimeHostAdmin.test.ts's makeFakeAdminDb, extended
 * with tx.update (claimTurnAuthoritative needs to conditionally update a
 * SECOND doc - the orphaned agentTurns doc - inside the same transaction
 * as the claim write, unlike claimRuntimeHost which only ever tx.sets one).
 */
function makeFakeAdminDb() {
  // Keyed by "collection/id" - claimTurnAuthoritative reads/writes TWO
  // different collections (turnClaims and agentTurns) for the SAME
  // sessionId in one transaction, unlike claimRuntimeHost's fake (only
  // ever one collection), so a plain id-only key would let them collide.
  const store = new Map<string, Record<string, unknown>>();

  function docRef(collectionName: string, id: string) {
    const key = `${collectionName}/${id}`;
    return {
      id,
      async get() {
        return { data: () => store.get(key) };
      },
      async update(partial: Record<string, unknown>) {
        store.set(key, { ...(store.get(key) ?? {}), ...partial });
      },
      async set(data: Record<string, unknown>) {
        store.set(key, data);
      },
    };
  }

  return {
    store,
    /** Test-only helper: read a doc by its real "collection/id" address, same shape production code uses. */
    getDoc: (collectionName: string, id: string) => store.get(`${collectionName}/${id}`),
    /** Test-only helper: seed a doc directly, same shape production code writes. */
    setDoc: (collectionName: string, id: string, data: Record<string, unknown>) => store.set(`${collectionName}/${id}`, data),
    adminDb: {
      collection: (collectionName: string) => ({
        doc: (id: string) => docRef(collectionName, id),
      }),
      runTransaction: async (
        fn: (tx: {
          get: (ref: ReturnType<typeof docRef>) => Promise<{ data: () => Record<string, unknown> | undefined }>;
          set: (ref: ReturnType<typeof docRef>, data: Record<string, unknown>) => void;
          update: (ref: ReturnType<typeof docRef>, partial: Record<string, unknown>) => void;
        }) => Promise<unknown>
      ) => {
        const tx = {
          get: (ref: ReturnType<typeof docRef>) => ref.get(),
          set: (ref: ReturnType<typeof docRef>, data: Record<string, unknown>) => {
            void ref.set(data);
          },
          update: (ref: ReturnType<typeof docRef>, partial: Record<string, unknown>) => {
            void ref.update(partial);
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

const {
  claimTurnAuthoritative,
  heartbeatTurnClaim,
  releaseTurnClaim,
  isTurnActiveAuthoritative,
  registerTurn,
  unregisterTurn,
  TurnClaimError,
  TURN_CLAIM_STALE_MS,
} = await import("@/lib/agent/turnRegistry");

beforeEach(() => {
  fake.store.clear();
  vi.useRealTimers();
});

describe("claimTurnAuthoritative", () => {
  it("succeeds on a fresh session with no existing claim", async () => {
    const { turnToken } = await claimTurnAuthoritative("s1");
    expect(turnToken).toBeTypeOf("string");
    expect(fake.getDoc("turnClaims", "s1")).toBeDefined();
  });

  it("rejects a second claim while the first is active and fresh", async () => {
    await claimTurnAuthoritative("s1");
    await expect(claimTurnAuthoritative("s1")).rejects.toBeInstanceOf(TurnClaimError);
  });

  it("a stale active claim (heartbeat older than TURN_CLAIM_STALE_MS) can be reclaimed", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const first = await claimTurnAuthoritative("s1");

      vi.setSystemTime(TURN_CLAIM_STALE_MS + 1);
      const second = await claimTurnAuthoritative("s1");

      expect(second.turnToken).not.toBe(first.turnToken);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a heartbeat exactly at the stale threshold minus one is NOT reclaimable", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      await claimTurnAuthoritative("s1");

      vi.setSystemTime(TURN_CLAIM_STALE_MS - 1);
      await expect(claimTurnAuthoritative("s1")).rejects.toBeInstanceOf(TurnClaimError);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reclaiming a stale claim flips the orphaned agentTurns doc to inactive with claim_expired, in the same transaction", async () => {
    fake.setDoc("agentTurns", "s1", {
      active: true,
      telemetry: { iterations: 5, terminationReason: null },
    });

    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      await claimTurnAuthoritative("s1");

      vi.setSystemTime(TURN_CLAIM_STALE_MS + 1);
      await claimTurnAuthoritative("s1");
    } finally {
      vi.useRealTimers();
    }

    const orphanedTurn = fake.getDoc("agentTurns", "s1");
    expect(orphanedTurn?.active).toBe(false);
    expect((orphanedTurn?.telemetry as { terminationReason?: string })?.terminationReason).toBe("claim_expired");
    // The rest of the pre-existing telemetry is preserved, not clobbered.
    expect((orphanedTurn?.telemetry as { iterations?: number })?.iterations).toBe(5);
  });

  it("does NOT touch the agentTurns doc when there was no prior claim at all (first-ever turn for this session)", async () => {
    fake.setDoc("agentTurns", "s1", { active: false, telemetry: { terminationReason: "done" } });
    await claimTurnAuthoritative("s1");
    // agentTurns doc for "s1" must be untouched - no prior claim existed to be "stale".
    expect(fake.getDoc("agentTurns", "s1")).toEqual({ active: false, telemetry: { terminationReason: "done" } });
  });

  it("does NOT touch the agentTurns doc when the prior claim was already inactive (a normal completed turn)", async () => {
    const { turnToken } = await claimTurnAuthoritative("s1");
    await releaseTurnClaim("s1", turnToken, "done");
    fake.setDoc("agentTurns", "s1", { active: false, telemetry: { terminationReason: "done" } });

    await claimTurnAuthoritative("s1");

    expect(fake.getDoc("agentTurns", "s1")).toEqual({ active: false, telemetry: { terminationReason: "done" } });
  });
});

describe("heartbeatTurnClaim", () => {
  it("succeeds for the current token and bumps heartbeatAt", async () => {
    const { turnToken } = await claimTurnAuthoritative("s1");
    const ok = await heartbeatTurnClaim("s1", turnToken);
    expect(ok).toBe(true);
  });

  it("fails (returns false, never throws) for a superseded token", async () => {
    await claimTurnAuthoritative("s1");
    const ok = await heartbeatTurnClaim("s1", "some-other-token");
    expect(ok).toBe(false);
  });

  it("fails for a session with no claim doc at all", async () => {
    const ok = await heartbeatTurnClaim("nonexistent", "any-token");
    expect(ok).toBe(false);
  });
});

describe("releaseTurnClaim", () => {
  it("marks the claim inactive and records the termination reason", async () => {
    const { turnToken } = await claimTurnAuthoritative("s1");
    const ok = await releaseTurnClaim("s1", turnToken, "done");
    expect(ok).toBe(true);
  });

  it("is a no-op (returns false) for a superseded/orphaned token - never clobbers a newer claim", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const orphaned = await claimTurnAuthoritative("s1");

      vi.setSystemTime(TURN_CLAIM_STALE_MS + 1);
      const fresh = await claimTurnAuthoritative("s1");

      // The orphaned process finally reaches its own finally block, late.
      const releasedLate = await releaseTurnClaim("s1", orphaned.turnToken, "step_budget_exhausted");
      expect(releasedLate).toBe(false);

      // The fresh claim's state must be completely untouched by the late release.
      const stillActive = await heartbeatTurnClaim("s1", fresh.turnToken);
      expect(stillActive).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("isTurnActiveAuthoritative", () => {
  it("trusts the in-memory fast path immediately when true", async () => {
    registerTurn("s-local");
    try {
      // No Firestore claim exists at all for this session - the in-memory
      // check alone must be enough to report active.
      expect(await isTurnActiveAuthoritative("s-local")).toBe(true);
    } finally {
      unregisterTurn("s-local");
    }
  });

  it("falls through to the Firestore claim when the in-memory map says false", async () => {
    await claimTurnAuthoritative("s1");
    expect(await isTurnActiveAuthoritative("s1")).toBe(true);
  });

  it("returns false once the claim is released", async () => {
    const { turnToken } = await claimTurnAuthoritative("s1");
    await releaseTurnClaim("s1", turnToken, "done");
    expect(await isTurnActiveAuthoritative("s1")).toBe(false);
  });

  it("returns false for a stale claim - it's reclaimable, not currently active", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      await claimTurnAuthoritative("s1");
      vi.setSystemTime(TURN_CLAIM_STALE_MS + 1);
      expect(await isTurnActiveAuthoritative("s1")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns false for a session with no claim doc at all", async () => {
    expect(await isTurnActiveAuthoritative("nonexistent")).toBe(false);
  });
});
