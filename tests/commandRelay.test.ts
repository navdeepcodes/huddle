import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 40 §5: the server half of the runtime bridge used to trust
 * onSnapshot + a timeout, and on timeout resolved a synthetic error
 * WITHOUT writing anything back - leaving the doc `pending` forever.
 * Because the client's reconcile poll queries exactly `status ==
 * "pending"`, it would later pick up and execute a command the server
 * had already abandoned and reported as failed. These pin the fix:
 * reconcile before failing, and always leave a terminal state.
 */
type Doc = Record<string, unknown>;

function makeFakeAdminDb() {
  const store = new Map<string, Doc>();
  let autoId = 0;
  /** Snapshot callbacks registered per doc id, so a test can simulate a delivered - or deliberately missed - snapshot. */
  const listeners = new Map<string, Array<(snap: { data: () => Doc | undefined }) => void>>();

  function docRef(collection: string, id: string) {
    const key = `${collection}/${id}`;
    return {
      id,
      _key: key,
      async get() {
        return { exists: store.has(key), data: () => store.get(key) };
      },
      async set(data: Doc) {
        store.set(key, data);
      },
      async update(patch: Doc) {
        store.set(key, { ...(store.get(key) ?? {}), ...patch });
      },
      onSnapshot(cb: (snap: { data: () => Doc | undefined }) => void) {
        const arr = listeners.get(key) ?? [];
        arr.push(cb);
        listeners.set(key, arr);
        return () => {
          listeners.set(key, (listeners.get(key) ?? []).filter((f) => f !== cb));
        };
      },
    };
  }

  return {
    store,
    /** Simulate the realtime channel delivering the current doc state. Not calling this simulates a DROPPED snapshot. */
    deliverSnapshot(collection: string, id: string) {
      const key = `${collection}/${id}`;
      for (const cb of listeners.get(key) ?? []) cb({ data: () => store.get(key) });
    },
    getDoc: (collection: string, id: string) => store.get(`${collection}/${id}`),
    setDoc: (collection: string, id: string, data: Doc) => store.set(`${collection}/${id}`, data),
    lastId: () => `auto-${autoId - 1}`,
    adminDb: {
      collection: (name: string) => ({
        doc: (id?: string) => docRef(name, id ?? `auto-${autoId++}`),
      }),
      runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          get: (ref: ReturnType<typeof docRef>) => ref.get(),
          set: (ref: ReturnType<typeof docRef>, data: Doc) => {
            void ref.set(data);
          },
          update: (ref: ReturnType<typeof docRef>, data: Doc) => {
            void ref.update(data);
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

const { dispatchRuntimeCommand, isTerminalForCaller } = await import("@/lib/runtime/commandRelay");

beforeEach(() => {
  fake.store.clear();
});

describe("isTerminalForCaller", () => {
  const base = { id: "c1", sessionId: "s1", payload: {}, createdAt: 0, completedAt: null };

  it("treats done and error as terminal for every kind", () => {
    expect(isTerminalForCaller({ ...base, kind: "run_command", status: "done" } as never)).toBe(true);
    expect(isTerminalForCaller({ ...base, kind: "capture_preview", status: "error" } as never)).toBe(true);
  });

  it("treats 'started' as terminal ONLY for a background run_command", () => {
    expect(
      isTerminalForCaller({ ...base, kind: "run_command", payload: { background: true }, status: "started" } as never)
    ).toBe(true);
    expect(
      isTerminalForCaller({ ...base, kind: "run_command", payload: { background: false }, status: "started" } as never)
    ).toBe(false);
    expect(isTerminalForCaller({ ...base, kind: "capture_preview", status: "started" } as never)).toBe(false);
  });

  it("never treats pending as terminal", () => {
    expect(isTerminalForCaller({ ...base, kind: "run_command", status: "pending" } as never)).toBe(false);
  });
});

describe("dispatchRuntimeCommand - reconciliation (Phase 40 §5)", () => {
  it("A. resolves normally when the snapshot arrives", async () => {
    const promise = dispatchRuntimeCommand("s1", "run_command", { command: "ls" } as never, 10_000);
    await Promise.resolve();

    const id = Array.from(fake.store.keys())[0].split("/")[1];
    fake.setDoc("runtimeCommands", id, {
      ...(fake.getDoc("runtimeCommands", id) as Doc),
      status: "done",
      result: { exitCode: 0, output: "ok" },
    });
    fake.deliverSnapshot("runtimeCommands", id);

    const result = await promise;
    expect(result.status).toBe("done");
  });

  it("B. snapshot MISSED but the command actually completed - reconciliation returns the real result, not a spurious timeout", async () => {
    vi.useFakeTimers();
    try {
      const promise = dispatchRuntimeCommand("s1", "run_command", { command: "ls" } as never, 1_000);
      await Promise.resolve();

      const id = Array.from(fake.store.keys())[0].split("/")[1];
      // The command genuinely finished - but the snapshot is never delivered.
      fake.setDoc("runtimeCommands", id, {
        ...(fake.getDoc("runtimeCommands", id) as Doc),
        status: "done",
        result: { exitCode: 0, output: "real output" },
      });

      await vi.advanceTimersByTimeAsync(1_100);
      const result = await promise;

      expect(result.status).toBe("done");
      expect((result.result as { output: string }).output).toBe("real output");
      expect(result.errorMessage).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("C+D. snapshot missed AND still pending - a terminal error state is WRITTEN, not just returned", async () => {
    vi.useFakeTimers();
    try {
      const promise = dispatchRuntimeCommand("s1", "run_command", { command: "ls" } as never, 1_000);
      await Promise.resolve();
      const id = Array.from(fake.store.keys())[0].split("/")[1];

      await vi.advanceTimersByTimeAsync(1_100);
      const result = await promise;

      expect(result.status).toBe("error");
      expect(result.errorMessage).toContain("Timed out");

      // The critical half: the DOC is terminal too, not left pending.
      const persisted = fake.getDoc("runtimeCommands", id) as Doc;
      expect(persisted.status).toBe("error");
      expect(persisted.completedAt).toBeTypeOf("number");
    } finally {
      vi.useRealTimers();
    }
  });

  it("E. an abandoned command can no longer be picked up by the client's pending query", async () => {
    vi.useFakeTimers();
    try {
      const promise = dispatchRuntimeCommand("s1", "run_command", { command: "ls" } as never, 1_000);
      await Promise.resolve();
      const id = Array.from(fake.store.keys())[0].split("/")[1];

      await vi.advanceTimersByTimeAsync(1_100);
      await promise;

      // The client subscribes/polls with `where status == "pending"`.
      // A terminal status is exactly what removes it from that query,
      // which is what makes orphaned execution impossible.
      const persisted = fake.getDoc("runtimeCommands", id) as Doc;
      expect(persisted.status).not.toBe("pending");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a background run_command resolves on 'started' without waiting for done", async () => {
    const promise = dispatchRuntimeCommand(
      "s1",
      "run_command",
      { command: "npm run dev", background: true } as never,
      10_000
    );
    await Promise.resolve();

    const id = Array.from(fake.store.keys())[0].split("/")[1];
    fake.setDoc("runtimeCommands", id, {
      ...(fake.getDoc("runtimeCommands", id) as Doc),
      status: "started",
      result: { status: "ready", port: 3000 },
    });
    fake.deliverSnapshot("runtimeCommands", id);

    const result = await promise;
    expect(result.status).toBe("started");
  });
});
