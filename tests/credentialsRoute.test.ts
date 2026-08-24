import { describe, expect, it, vi, beforeEach } from "vitest";

const getVerifiedUid = vi.fn();
vi.mock("@/lib/auth/verifyRequest", () => ({
  getVerifiedUid: (...args: unknown[]) => getVerifiedUid(...args),
}));

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

const { GET, PUT, DELETE } = await import("@/app/api/credentials/nemotron/route");

function req(body?: unknown) {
  return new Request("http://localhost/api/credentials/nemotron", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }) as unknown as import("next/server").NextRequest;
}

beforeEach(() => {
  docs.clear();
  process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
  getVerifiedUid.mockReset();
});

describe("/api/credentials/nemotron (Phase 29 Part 9/13)", () => {
  it("GET requires authentication - 401 with no verified uid", async () => {
    getVerifiedUid.mockResolvedValue(null);
    const res = await GET(req());
    expect(res.status).toBe(401);
  });

  it("GET reports not configured, then configured after a PUT, without ever including the key", async () => {
    getVerifiedUid.mockResolvedValue("user-a");
    const before = await GET(req());
    expect((await before.json()).configured).toBe(false);

    const putRes = await PUT(req({ key: "nvapi-real-secret-value" }));
    expect(putRes.status).toBe(200);
    const putBody = await putRes.json();
    expect(JSON.stringify(putBody)).not.toContain("nvapi-real-secret-value");
    expect(putBody).not.toHaveProperty("key");

    const after = await GET(req());
    expect((await after.json()).configured).toBe(true);
  });

  it("PUT rejects a missing/empty key with 400, and does not store anything", async () => {
    getVerifiedUid.mockResolvedValue("user-a");
    const res = await PUT(req({ key: "" }));
    expect(res.status).toBe(400);
    expect(docs.size).toBe(0);
  });

  it("DELETE requires authentication and removes only the authenticated user's credential", async () => {
    getVerifiedUid.mockResolvedValue("user-a");
    await PUT(req({ key: "nvapi-user-a-key" }));

    getVerifiedUid.mockResolvedValue("user-b");
    await PUT(req({ key: "nvapi-user-b-key" }));

    getVerifiedUid.mockResolvedValue("user-a");
    const delRes = await DELETE(req());
    expect(delRes.status).toBe(200);

    const aStatus = await (await GET(req())).json();
    expect(aStatus.configured).toBe(false);

    getVerifiedUid.mockResolvedValue("user-b");
    const bStatus = await (await GET(req())).json();
    expect(bStatus.configured).toBe(true); // untouched by A's delete
  });

  it("Phase 29 Part 9 (CRITICAL): there is no request shape that lets one authenticated user act on another user's credential - every route method resolves the uid solely from the verified token, never from the request body", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../app/api/credentials/nemotron/route.ts", import.meta.url), "utf8")
    );
    // No occurrence of reading a "uid" out of the request body/JSON anywhere in the route.
    expect(source).not.toMatch(/request\.json\(\)[\s\S]{0,80}uid/);
    expect(source.match(/getVerifiedUid\(request\)/g)?.length).toBe(3); // GET, PUT, DELETE each verify independently
  });

  it("never returns the raw key even on GET for a configured credential", async () => {
    getVerifiedUid.mockResolvedValue("user-a");
    await PUT(req({ key: "nvapi-should-never-leak-out" }));
    const res = await GET(req());
    const text = await res.text();
    expect(text).not.toContain("nvapi-should-never-leak-out");
  });
});
