import { vi } from "vitest";

// "server-only" throws unconditionally when required outside Next's own
// bundler (which aliases it to a no-op in server contexts) - real,
// intentional behavior for the app, but it means any genuinely
// server-only module (Firestore Admin, etc.) can't be imported directly
// in a plain Node test runner without this stub.
vi.mock("server-only", () => ({}));
