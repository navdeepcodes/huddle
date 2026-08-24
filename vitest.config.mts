import { defineConfig } from "vitest/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));

// Next.js loads .env.local automatically; vitest doesn't. Several
// modules under test (runtimeSession.ts) transitively import
// lib/firebase/client.ts, which reads NEXT_PUBLIC_FIREBASE_* at
// import time - without this, Firebase client init throws
// "auth/invalid-api-key" before any test body even runs.
const envPath = path.resolve(dirname, ".env.local");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    process.env[key] ??= value;
  }
}

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(dirname, "."),
    },
  },
  test: {
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
  },
});
