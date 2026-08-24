import { describe, expect, it } from "vitest";
import { stripAnsi } from "@/lib/agent/stripAnsi";

const ESC = String.fromCharCode(27);

describe("stripAnsi (Phase 25)", () => {
  it("removes ANSI cursor-control/color escape sequences", () => {
    const raw = ESC + "[1G" + ESC + "[0K" + "hello" + ESC + "[32m" + "world" + ESC + "[0m";
    expect(stripAnsi(raw)).toBe("helloworld");
  });

  it("collapses a carriage-return spinner redraw down to the final content", () => {
    expect(stripAnsi("a\rb\rc\rd\n")).toBe("d\n");
  });

  it("leaves plain text with real newlines untouched", () => {
    const text = "exit code: 0\nadded 9 packages in 17s\n";
    expect(stripAnsi(text)).toBe(text);
  });

  it("does not touch a normal \\r\\n line ending (not a redraw)", () => {
    expect(stripAnsi("line one\r\nline two\r\n")).toBe("line one\r\nline two\r\n");
  });

  it("handles a real observed npm spinner transcript (frames separated by ANSI cursor-reset codes, ending \\r\\n) - strips all the escape codes, dramatically shortening the noisy part", () => {
    const frame = ESC + "[1G" + ESC + "[0K";
    const raw = frame + "\\" + frame + "|" + frame + "/" + frame + "\r\nadded 9 packages in 17s\r\n";
    const result = stripAnsi(raw);
    expect(result).toBe("\\|/\r\nadded 9 packages in 17s\r\n");
    expect(result.length).toBeLessThan(raw.length / 2);
  });
});
