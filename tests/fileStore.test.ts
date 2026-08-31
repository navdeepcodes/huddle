import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Minimal in-memory stand-in for the slice of the Admin Firestore SDK
 * fileStore.ts actually uses: doc get/delete, a where(sessionId==)
 * query, and a batch with set+commit. Same shape/intent as
 * tests/runtimeHostAdmin.test.ts's fake - one shared Map keyed by doc
 * id, no real network, no real consistency model to worry about.
 */
function makeFakeAdminDb() {
  const store = new Map<string, Record<string, unknown>>();

  function docRef(id: string) {
    return {
      id,
      async get() {
        return { exists: store.has(id), data: () => store.get(id) };
      },
      async delete() {
        store.delete(id);
      },
    };
  }

  const collection = () => ({
    doc: (id: string) => docRef(id),
    where: (field: string, _op: string, value: unknown) => ({
      async get() {
        const docs = Array.from(store.entries())
          .filter(([, data]) => data[field] === value)
          .map(([id, data]) => ({ data: () => data, id }));
        return { docs };
      },
    }),
  });

  const batch = () => {
    const pending: Array<{ ref: ReturnType<typeof docRef>; data: Record<string, unknown>; op: "set" | "update" | "delete" }> = [];
    return {
      set(ref: ReturnType<typeof docRef>, data: Record<string, unknown>) {
        pending.push({ ref, data, op: "set" });
      },
      // Real Firestore's update() only touches the given fields (and
      // throws on a missing doc, which this simplified fake doesn't
      // reproduce - not exercised by anything below that asserts on
      // the "sessions" side of the shared store, only sessionFiles).
      update(ref: ReturnType<typeof docRef>, data: Record<string, unknown>) {
        pending.push({ ref, data, op: "update" });
      },
      delete(ref: ReturnType<typeof docRef>) {
        pending.push({ ref, data: {}, op: "delete" });
      },
      async commit() {
        for (const { ref, data, op } of pending) {
          if (op === "delete") store.delete(ref.id);
          else if (op === "update") store.set(ref.id, { ...(store.get(ref.id) ?? {}), ...data });
          else store.set(ref.id, data);
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

const {
  listSessionDirectory,
  listSessionFiles,
  batchWriteSessionFiles,
  readSessionFile,
  deleteSessionFile,
  deleteSessionFiles,
} = await import("@/lib/files/fileStore");

beforeEach(() => {
  fake.store.clear();
});

describe("listSessionDirectory - root path normalization (Phase 15 regression)", () => {
  const write = () =>
    batchWriteSessionFiles("s1", [
      { path: "package.json", content: "{}", updatedBy: "agent" },
      { path: "components/Foo.js", content: "// foo", updatedBy: "agent" },
    ]);

  it("lists the root correctly for the literal empty string", async () => {
    await write();
    const listing = await listSessionDirectory("s1", "");
    expect(listing.files).toEqual(["package.json"]);
    expect(listing.directories).toEqual(["components"]);
  });

  it("treats '/' as the session root, not a literal path segment", async () => {
    await write();
    const listing = await listSessionDirectory("s1", "/");
    expect(listing.files).toEqual(["package.json"]);
    expect(listing.directories).toEqual(["components"]);
  });

  it("treats '.' as the session root", async () => {
    await write();
    const listing = await listSessionDirectory("s1", ".");
    expect(listing.files).toEqual(["package.json"]);
    expect(listing.directories).toEqual(["components"]);
  });

  it("treats './' as the session root", async () => {
    await write();
    const listing = await listSessionDirectory("s1", "./");
    expect(listing.files).toEqual(["package.json"]);
    expect(listing.directories).toEqual(["components"]);
  });

  it("does not treat a real directory literally named 'root' as the session root", async () => {
    await batchWriteSessionFiles("s1", [
      { path: "root/index.js", content: "// real subdir named root", updatedBy: "agent" },
    ]);
    const listing = await listSessionDirectory("s1", "root");
    expect(listing.files).toEqual(["index.js"]);
    expect(listing.directories).toEqual([]);
  });

  it("still lists a real, non-root subdirectory correctly (with or without a trailing slash)", async () => {
    await write();
    const withoutSlash = await listSessionDirectory("s1", "components");
    const withSlash = await listSessionDirectory("s1", "components/");
    expect(withoutSlash.files).toEqual(["Foo.js"]);
    expect(withSlash.files).toEqual(["Foo.js"]);
  });
});

describe("Phase 15 Phase 4 required regression scenarios", () => {
  it("1 & 2. files written in one turn are visible on the very first list_files-equivalent call of a later turn", async () => {
    // Simulates turn 1 writing files, then turn 2 starting fresh and
    // immediately listing the root - no special turn-boundary state,
    // just two calls against the same session id in sequence.
    await batchWriteSessionFiles("turn-session", [
      { path: "package.json", content: "{}", updatedBy: "agent" },
    ]);

    const firstCallOfContinuationTurn = await listSessionDirectory("turn-session", "");
    expect(firstCallOfContinuationTurn.files).toEqual(["package.json"]);
  });

  it("3. nested directories are visible", async () => {
    await batchWriteSessionFiles("s1", [
      { path: "components/ui/Button.js", content: "", updatedBy: "agent" },
      { path: "pages/index.js", content: "", updatedBy: "agent" },
    ]);
    const root = await listSessionDirectory("s1", "");
    expect(root.directories.sort()).toEqual(["components", "pages"]);

    const nested = await listSessionDirectory("s1", "components");
    expect(nested.directories).toEqual(["ui"]);

    const deeplyNested = await listSessionDirectory("s1", "components/ui");
    expect(deeplyNested.files).toEqual(["Button.js"]);
  });

  it("4. newly-written files are visible immediately after the write resolves, no delay needed", async () => {
    await batchWriteSessionFiles("s1", [{ path: "a.js", content: "", updatedBy: "agent" }]);
    expect((await listSessionDirectory("s1", "")).files).toEqual(["a.js"]);

    await batchWriteSessionFiles("s1", [{ path: "b.js", content: "", updatedBy: "agent" }]);
    expect((await listSessionDirectory("s1", "")).files.sort()).toEqual(["a.js", "b.js"]);
  });

  it("5. different sessions cannot leak files into each other", async () => {
    await batchWriteSessionFiles("session-aeren", [
      { path: "data/products.js", content: "// sneakers", updatedBy: "agent" },
    ]);
    await batchWriteSessionFiles("session-form01", [
      { path: "data/articles.js", content: "// architecture magazine", updatedBy: "agent" },
    ]);

    const aeren = await listSessionDirectory("session-aeren", "");
    const form01 = await listSessionDirectory("session-form01", "");

    expect(aeren.directories).toEqual(["data"]);
    expect(form01.directories).toEqual(["data"]);

    const aerenFile = await readSessionFile("session-aeren", "data/products.js");
    const form01File = await readSessionFile("session-form01", "data/articles.js");
    expect(aerenFile?.content).toBe("// sneakers");
    expect(form01File?.content).toBe("// architecture magazine");

    // Cross-session reads must miss - session-aeren's file id is never
    // reachable from session-form01's id namespace.
    expect(await readSessionFile("session-form01", "data/products.js")).toBeNull();
  });
});

describe("listSessionFiles / readSessionFile / deleteSessionFile - sanity (unchanged behavior)", () => {
  it("listSessionFiles returns every file for a session regardless of nesting", async () => {
    await batchWriteSessionFiles("s1", [
      { path: "a.js", content: "1", updatedBy: "agent" },
      { path: "x/y/z.js", content: "2", updatedBy: "agent" },
    ]);
    const all = await listSessionFiles("s1");
    expect(all.map((f) => f.path).sort()).toEqual(["a.js", "x/y/z.js"]);
  });

  it("deleteSessionFile removes exactly the targeted file", async () => {
    await batchWriteSessionFiles("s1", [
      { path: "keep.js", content: "", updatedBy: "agent" },
      { path: "remove.js", content: "", updatedBy: "agent" },
    ]);
    await deleteSessionFile("s1", "remove.js");
    const remaining = await listSessionFiles("s1");
    expect(remaining.map((f) => f.path)).toEqual(["keep.js"]);
  });
});

describe("Phase 31: file mutations bump the owning session's updatedAt (dashboard 'last activity')", () => {
  it("batchWriteSessionFiles updates the session doc's updatedAt in the same batch", async () => {
    fake.store.set("s-activity", { id: "s-activity", updatedAt: 1 });
    await batchWriteSessionFiles("s-activity", [{ path: "a.js", content: "", updatedBy: "agent" }]);
    expect((fake.store.get("s-activity") as { updatedAt: number }).updatedAt).toBeGreaterThan(1);
  });

  it("deleteSessionFiles also bumps the session doc's updatedAt", async () => {
    fake.store.set("s-activity-2", { id: "s-activity-2", updatedAt: 1 });
    await batchWriteSessionFiles("s-activity-2", [{ path: "a.js", content: "", updatedBy: "agent" }]);
    fake.store.set("s-activity-2", { id: "s-activity-2", updatedAt: 1 });
    await deleteSessionFiles("s-activity-2", ["a.js"]);
    expect((fake.store.get("s-activity-2") as { updatedAt: number }).updatedAt).toBeGreaterThan(1);
  });
});

describe("Phase 37: hasRealFiles - the sole 'is this a Project' signal", () => {
  it("sets hasRealFiles true when a real (non-artifact) path is written", async () => {
    fake.store.set("s-real", { id: "s-real", updatedAt: 1 });
    await batchWriteSessionFiles("s-real", [{ path: "components/Header.js", content: "", updatedBy: "agent" }]);
    expect((fake.store.get("s-real") as { hasRealFiles?: boolean }).hasRealFiles).toBe(true);
  });

  it("does NOT set hasRealFiles when only an artifact path is written", async () => {
    fake.store.set("s-artifact", { id: "s-artifact", updatedAt: 1 });
    await batchWriteSessionFiles("s-artifact", [{ path: "artifacts/hero-abc123.png", content: "", updatedBy: "agent", encoding: "base64" }]);
    expect((fake.store.get("s-artifact") as { hasRealFiles?: boolean }).hasRealFiles).toBeUndefined();
  });

  it("sets hasRealFiles true when a batch mixes an artifact and a real file", async () => {
    fake.store.set("s-mixed", { id: "s-mixed", updatedAt: 1 });
    await batchWriteSessionFiles("s-mixed", [
      { path: "artifacts/hero-abc123.png", content: "", updatedBy: "agent", encoding: "base64" },
      { path: "pages/index.js", content: "", updatedBy: "agent" },
    ]);
    expect((fake.store.get("s-mixed") as { hasRealFiles?: boolean }).hasRealFiles).toBe(true);
  });

  it("stays true (one-way) even if a later batch only writes an artifact", async () => {
    fake.store.set("s-oneway", { id: "s-oneway", updatedAt: 1, hasRealFiles: true });
    await batchWriteSessionFiles("s-oneway", [{ path: "artifacts/deck-abc123.pptx", content: "", updatedBy: "agent", encoding: "base64" }]);
    expect((fake.store.get("s-oneway") as { hasRealFiles?: boolean }).hasRealFiles).toBe(true);
  });
});
