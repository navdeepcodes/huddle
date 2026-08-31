import { beforeEach, describe, expect, it, vi } from "vitest";

const getVerifiedUid = vi.fn();
vi.mock("@/lib/auth/verifyRequest", () => ({
  getVerifiedUid: (...args: unknown[]) => getVerifiedUid(...args),
}));

const firestoreDocs = new Map<string, Record<string, unknown>>();
function fakeDoc(collection: string, id: string) {
  const key = `${collection}/${id}`;
  return {
    id,
    get: async () => ({ exists: firestoreDocs.has(key), data: () => firestoreDocs.get(key), ref: fakeDoc(collection, id) }),
    update: async (patch: Record<string, unknown>) => {
      firestoreDocs.set(key, { ...(firestoreDocs.get(key) as object), ...patch });
    },
  };
}
const adminDb = { collection: (name: string) => ({ doc: (id: string) => fakeDoc(name, id) }) };
vi.mock("@/lib/firebase/admin", () => ({ adminDb }));

const { POST } = await import("@/app/api/sessions/[sessionId]/world-access/route");

function req(body: unknown) {
  return new Request("http://localhost/api/sessions/s1/world-access", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer fake" },
    body: JSON.stringify(body),
  }) as unknown as import("next/server").NextRequest;
}

beforeEach(() => {
  firestoreDocs.clear();
  getVerifiedUid.mockReset();
});

describe("POST /api/sessions/[sessionId]/world-access - only project owners can launch/unlaunch", () => {
  it("enables world access for the true owner of a real project (hasRealFiles)", async () => {
    getVerifiedUid.mockResolvedValue("owner-1");
    firestoreDocs.set("sessions/s1", { id: "s1", ownerId: "owner-1", memberIds: ["owner-1"], hasRealFiles: true });

    const res = await POST(req({ enabled: true }), { params: Promise.resolve({ sessionId: "s1" }) });
    expect(res.status).toBe(200);
    expect((firestoreDocs.get("sessions/s1") as { worldAccess?: boolean }).worldAccess).toBe(true);
  });

  it("rejects a non-owner collaborator, even though they're a full session member", async () => {
    getVerifiedUid.mockResolvedValue("collaborator-2");
    firestoreDocs.set("sessions/s1", { id: "s1", ownerId: "owner-1", memberIds: ["owner-1", "collaborator-2"], hasRealFiles: true });

    const res = await POST(req({ enabled: true }), { params: Promise.resolve({ sessionId: "s1" }) });
    expect(res.status).toBe(403);
    expect((firestoreDocs.get("sessions/s1") as { worldAccess?: boolean }).worldAccess).toBeUndefined();
  });

  it("rejects an unauthenticated caller", async () => {
    getVerifiedUid.mockResolvedValue(null);
    const res = await POST(req({ enabled: true }), { params: Promise.resolve({ sessionId: "s1" }) });
    expect(res.status).toBe(401);
  });

  it("refuses to enable world access on a quick/legacy session that never had real files written (Session != Project)", async () => {
    getVerifiedUid.mockResolvedValue("owner-1");
    firestoreDocs.set("sessions/s1", { id: "s1", ownerId: "owner-1", memberIds: ["owner-1"] });

    const res = await POST(req({ enabled: true }), { params: Promise.resolve({ sessionId: "s1" }) });
    expect(res.status).toBe(422);
    expect((firestoreDocs.get("sessions/s1") as { worldAccess?: boolean }).worldAccess).toBeUndefined();
  });

  it("allows disabling world access even on a quick session (turning off is never blocked)", async () => {
    getVerifiedUid.mockResolvedValue("owner-1");
    firestoreDocs.set("sessions/s1", { id: "s1", ownerId: "owner-1", memberIds: ["owner-1"], worldAccess: true });

    const res = await POST(req({ enabled: false }), { params: Promise.resolve({ sessionId: "s1" }) });
    expect(res.status).toBe(200);
    expect((firestoreDocs.get("sessions/s1") as { worldAccess?: boolean }).worldAccess).toBe(false);
  });
});
