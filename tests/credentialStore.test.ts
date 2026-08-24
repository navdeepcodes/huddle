import { describe, expect, it, vi, beforeEach } from "vitest";

/** Phase 29: fake Firestore, same one-collection-map pattern as other Admin-SDK-backed tests in this suite. */
const docs = new Map<string, Record<string, unknown>>();
const adminDb = {
  collection: (name: string) => ({
    doc: (id: string) => ({
      get: async () => ({ exists: docs.has(`${name}/${id}`), data: () => docs.get(`${name}/${id}`) }),
      set: async (value: Record<string, unknown>) => {
        docs.set(`${name}/${id}`, value);
      },
      delete: async () => {
        docs.delete(`${name}/${id}`);
      },
    }),
  }),
};
vi.mock("@/lib/firebase/admin", () => ({ adminDb }));

beforeEach(() => {
  docs.clear();
  process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString("base64");
});

const { getCredentialStatus, setCredential, deleteCredential, resolveCredential } = await import(
  "@/lib/credentials/credentialStore"
);

describe("credentialStore (Phase 29 Part 9/13)", () => {
  it("reports not configured for a user who never set a key", async () => {
    expect(await getCredentialStatus("user-a", "nemotron")).toBe(false);
  });

  it("reports configured after setCredential, and resolveCredential returns the exact raw key back", async () => {
    await setCredential("user-a", "nemotron", "nvapi-user-a-real-key");
    expect(await getCredentialStatus("user-a", "nemotron")).toBe(true);
    expect(await resolveCredential("user-a", "nemotron")).toBe("nvapi-user-a-real-key");
  });

  it("never stores the raw key value anywhere in the Firestore document", async () => {
    await setCredential("user-a", "nemotron", "nvapi-plaintext-marker-xyz");
    const stored = docs.get("userCredentials/user-a_nemotron");
    expect(JSON.stringify(stored)).not.toContain("nvapi-plaintext-marker-xyz");
  });

  it("deleteCredential removes it - status and resolve both reflect the removal", async () => {
    await setCredential("user-a", "nemotron", "nvapi-user-a-real-key");
    await deleteCredential("user-a", "nemotron");
    expect(await getCredentialStatus("user-a", "nemotron")).toBe(false);
    expect(await resolveCredential("user-a", "nemotron")).toBeNull();
  });

  it("Phase 29 Part 9 (CRITICAL): two users' credentials are stored independently - setting/deleting one never touches the other", async () => {
    await setCredential("user-a", "nemotron", "nvapi-KEY-A");
    await setCredential("user-b", "nemotron", "nvapi-KEY-B");

    expect(await resolveCredential("user-a", "nemotron")).toBe("nvapi-KEY-A");
    expect(await resolveCredential("user-b", "nemotron")).toBe("nvapi-KEY-B");

    await deleteCredential("user-a", "nemotron");
    expect(await resolveCredential("user-a", "nemotron")).toBeNull();
    expect(await resolveCredential("user-b", "nemotron")).toBe("nvapi-KEY-B"); // untouched

    await setCredential("user-a", "nemotron", "nvapi-KEY-A-REPLACED");
    expect(await resolveCredential("user-a", "nemotron")).toBe("nvapi-KEY-A-REPLACED");
    expect(await resolveCredential("user-b", "nemotron")).toBe("nvapi-KEY-B"); // still untouched
  });

  it("resolveCredential for a user with no configured key returns null, not the platform key or an error", async () => {
    expect(await resolveCredential("user-with-nothing-configured", "nemotron")).toBeNull();
  });
});
