import { beforeEach, describe, expect, it, vi } from "vitest";

const firestoreDocs = new Map<string, Record<string, unknown>>();
const rateLimitStore = new Map<string, Record<string, unknown>>();
let autoIdCounter = 0;

function fakeDoc(collection: string, id: string) {
  const key = `${collection}/${id}`;
  return {
    id,
    get: async () => ({ exists: firestoreDocs.has(key), data: () => firestoreDocs.get(key) }),
    set: async (data: Record<string, unknown>) => {
      firestoreDocs.set(key, data);
    },
  };
}

const adminDb = {
  collection: (name: string) => ({
    doc: (id?: string) => fakeDoc(name, id ?? `auto-${autoIdCounter++}`),
    where: (field: string, _op: string, value: unknown) => ({
      async get() {
        const prefix = `${name}/`;
        const docs = Array.from(firestoreDocs.entries())
          .filter(([key, data]) => key.startsWith(prefix) && data[field] === value)
          .map(([key, data]) => ({ data: () => data, id: key.slice(prefix.length) }));
        return { docs };
      },
    }),
  }),
  runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      async get(ref: { id: string }) {
        return { data: () => rateLimitStore.get(ref.id) };
      },
      set(ref: { id: string }, data: Record<string, unknown>) {
        rateLimitStore.set(ref.id, data);
      },
      update(ref: { id: string }, patch: Record<string, unknown>) {
        rateLimitStore.set(ref.id, { ...(rateLimitStore.get(ref.id) ?? {}), ...patch });
      },
    };
    return fn(tx);
  },
};
vi.mock("@/lib/firebase/admin", () => ({ adminDb }));

const { GET: getFiles } = await import("@/app/api/public/projects/[sessionId]/files/route");
const { POST: postFeedback } = await import("@/app/api/public/projects/[sessionId]/feedback/route");
const { GET: getStatus } = await import("@/app/api/public/projects/[sessionId]/feedback/[feedbackId]/status/route");

function get(url: string) {
  return new Request(url) as unknown as import("next/server").NextRequest;
}
function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  }) as unknown as import("next/server").NextRequest;
}

beforeEach(() => {
  firestoreDocs.clear();
  rateLimitStore.clear();
  autoIdCounter = 0;
});

describe("GET /api/public/projects/[sessionId]/files - no auth required, gated purely on worldAccess", () => {
  it("serves files for a world-access-enabled project with no Authorization header at all", async () => {
    firestoreDocs.set("sessions/s1", { id: "s1", name: "Huddle Weather", worldAccess: true, ownerId: "o1", memberIds: ["o1"] });
    firestoreDocs.set("sessionFiles/s1_a.js", { sessionId: "s1", path: "a.js", content: "hi" });

    const res = await getFiles(get("http://localhost/api/public/projects/s1/files"), { params: Promise.resolve({ sessionId: "s1" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("Huddle Weather");
    expect(body.files).toEqual([{ path: "a.js", content: "hi", encoding: "utf8" }]);
  });

  it("404s for a private project (worldAccess absent) - never leaks that the project exists vs. is just off", async () => {
    firestoreDocs.set("sessions/s1", { id: "s1", name: "Private", ownerId: "o1", memberIds: ["o1"] });
    const res = await getFiles(get("http://localhost/api/public/projects/s1/files"), { params: Promise.resolve({ sessionId: "s1" }) });
    expect(res.status).toBe(404);
  });

  it("404s for a project with worldAccess explicitly turned back off", async () => {
    firestoreDocs.set("sessions/s1", { id: "s1", worldAccess: false, ownerId: "o1", memberIds: ["o1"] });
    const res = await getFiles(get("http://localhost/api/public/projects/s1/files"), { params: Promise.resolve({ sessionId: "s1" }) });
    expect(res.status).toBe(404);
  });

  it("404s for a nonexistent sessionId rather than throwing", async () => {
    const res = await getFiles(get("http://localhost/api/public/projects/nope/files"), { params: Promise.resolve({ sessionId: "nope" }) });
    expect(res.status).toBe(404);
  });

  it("never returns memberIds/ownerId/chat data - only name, description, files", async () => {
    firestoreDocs.set("sessions/s1", { id: "s1", name: "N", worldAccess: true, ownerId: "secret-owner", memberIds: ["secret-owner", "secret-collab"] });
    const res = await getFiles(get("http://localhost/api/public/projects/s1/files"), { params: Promise.resolve({ sessionId: "s1" }) });
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["description", "files", "name"]);
  });
});

describe("POST /api/public/projects/[sessionId]/feedback - free, no auth, never touches the agent", () => {
  it("accepts feedback with no Authorization header", async () => {
    firestoreDocs.set("sessions/s1", { id: "s1", worldAccess: true });
    const res = await postFeedback(post("http://localhost/api/public/projects/s1/feedback", { text: "cards are cramped" }), {
      params: Promise.resolve({ sessionId: "s1" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBeTruthy();
  });

  it("404s for a project without world access", async () => {
    firestoreDocs.set("sessions/s1", { id: "s1" });
    const res = await postFeedback(post("http://localhost/api/public/projects/s1/feedback", { text: "hi" }), {
      params: Promise.resolve({ sessionId: "s1" }),
    });
    expect(res.status).toBe(404);
  });

  it("rejects empty/whitespace-only text", async () => {
    firestoreDocs.set("sessions/s1", { id: "s1", worldAccess: true });
    const res = await postFeedback(post("http://localhost/api/public/projects/s1/feedback", { text: "   " }), {
      params: Promise.resolve({ sessionId: "s1" }),
    });
    expect(res.status).toBe(400);
  });

  it("rate-limits repeated submissions from the same ip to the same project", async () => {
    firestoreDocs.set("sessions/s1", { id: "s1", worldAccess: true });
    const headers = { "x-forwarded-for": "1.2.3.4" };
    let lastStatus = 0;
    for (let i = 0; i < 6; i++) {
      const res = await postFeedback(post("http://localhost/api/public/projects/s1/feedback", { text: `suggestion ${i}` }, headers), {
        params: Promise.resolve({ sessionId: "s1" }),
      });
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
  });

  it("issues a notifyToken only when notifyMe is explicitly requested", async () => {
    firestoreDocs.set("sessions/s1", { id: "s1", worldAccess: true });
    const withNotify = await postFeedback(post("http://localhost/api/public/projects/s1/feedback", { text: "hi", notifyMe: true }), {
      params: Promise.resolve({ sessionId: "s1" }),
    });
    const withoutNotify = await postFeedback(post("http://localhost/api/public/projects/s1/feedback", { text: "hi" }), {
      params: Promise.resolve({ sessionId: "s1" }),
    });
    expect((await withNotify.json()).notifyToken).toBeTruthy();
    expect((await withoutNotify.json()).notifyToken).toBeNull();
  });
});

describe("GET /api/public/projects/[sessionId]/feedback/[feedbackId]/status - the no-account notify-me callback", () => {
  it("returns status only when the exact token matches", async () => {
    firestoreDocs.set("sessions/s1", { id: "s1", worldAccess: true });
    const created = await postFeedback(post("http://localhost/api/public/projects/s1/feedback", { text: "hi", notifyMe: true }), {
      params: Promise.resolve({ sessionId: "s1" }),
    });
    const { id, notifyToken } = await created.json();

    const res = await getStatus(get(`http://localhost/api/public/projects/s1/feedback/${id}/status?token=${notifyToken}`), {
      params: Promise.resolve({ sessionId: "s1", feedbackId: id }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("new");
  });

  it("404s with a wrong token - a stranger can't enumerate another visitor's feedback status", async () => {
    firestoreDocs.set("sessions/s1", { id: "s1", worldAccess: true });
    const created = await postFeedback(post("http://localhost/api/public/projects/s1/feedback", { text: "hi", notifyMe: true }), {
      params: Promise.resolve({ sessionId: "s1" }),
    });
    const { id } = await created.json();

    const res = await getStatus(get(`http://localhost/api/public/projects/s1/feedback/${id}/status?token=wrong-token`), {
      params: Promise.resolve({ sessionId: "s1", feedbackId: id }),
    });
    expect(res.status).toBe(404);
  });
});
