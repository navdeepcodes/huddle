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

  describe("process management commands - short-circuited, jsh has none of these (Phase 40)", () => {
    it("short-circuits pkill", () => {
      expect(normalizeShellCommand('pkill -f "next"').shortCircuitMessage).toBeDefined();
    });

    it("short-circuits lsof piped to kill", () => {
      expect(normalizeShellCommand("lsof -ti:3001 | xargs kill -9").shortCircuitMessage).toBeDefined();
    });

    it("short-circuits pgrep and killall", () => {
      expect(normalizeShellCommand("pgrep node").shortCircuitMessage).toBeDefined();
      expect(normalizeShellCommand("killall node").shortCircuitMessage).toBeDefined();
    });

    it("short-circuits ps aux / ps -ef", () => {
      expect(normalizeShellCommand("ps aux | grep next").shortCircuitMessage).toBeDefined();
      expect(normalizeShellCommand("ps -ef | grep node").shortCircuitMessage).toBeDefined();
    });

    it("short-circuits kill $(...) command substitution", () => {
      expect(normalizeShellCommand("kill $(cat server.pid)").shortCircuitMessage).toBeDefined();
      expect(normalizeShellCommand("kill -9 $(cat server.pid)").shortCircuitMessage).toBeDefined();
    });

    it("does not short-circuit an unrelated command that merely contains the word 'kill' as part of something else", () => {
      expect(normalizeShellCommand("npm run build").shortCircuitMessage).toBeUndefined();
    });
  });
});
