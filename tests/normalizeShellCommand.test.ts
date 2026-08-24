import { describe, expect, it } from "vitest";

import { normalizeShellCommand } from "@/lib/agent/normalizeShellCommand";

describe("normalizeShellCommand", () => {
  it("short-circuits a bare sleep call instead of dispatching it", () => {
    const result = normalizeShellCommand("sleep 5");
    expect(result.shortCircuitMessage).toBeDefined();
  });

  it("short-circuits sleep with a decimal and trailing semicolon", () => {
    expect(normalizeShellCommand("sleep 2.5;").shortCircuitMessage).toBeDefined();
    expect(normalizeShellCommand("  sleep 10  ").shortCircuitMessage).toBeDefined();
  });

  it("does not short-circuit a compound command containing sleep", () => {
    const result = normalizeShellCommand("sleep 5 && npm run build");
    expect(result.shortCircuitMessage).toBeUndefined();
    expect(result.command).toBe("sleep 5 && npm run build");
  });

  it("rewrites old BSD-style head -N to head -n N", () => {
    expect(normalizeShellCommand("head -50 out.log").command).toBe("head -n 50 out.log");
  });

  it("rewrites old BSD-style tail -N to tail -n N", () => {
    expect(normalizeShellCommand("tail -100 out.log").command).toBe("tail -n 100 out.log");
  });

  it("leaves an already-correct head -n N command untouched", () => {
    expect(normalizeShellCommand("head -n 50 out.log").command).toBe("head -n 50 out.log");
  });

  it("leaves unrelated commands untouched", () => {
    expect(normalizeShellCommand("npm install").command).toBe("npm install");
    expect(normalizeShellCommand("curl -s http://localhost:3000/").command).toBe("curl -s http://localhost:3000/");
  });
});
