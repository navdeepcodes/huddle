import { describe, expect, it } from "vitest";

import { validateWriteFileArgs } from "@/lib/agent/validateWriteFile";

describe("validateWriteFileArgs", () => {
  it("accepts a valid path and content", () => {
    const result = validateWriteFileArgs({ path: "src/App.tsx", content: "export default function App() {}" });
    expect(result).toEqual({ ok: true, value: { path: "src/App.tsx", content: "export default function App() {}" } });
  });

  it("rejects a missing path (key not present)", () => {
    const result = validateWriteFileArgs({ content: "hello" });
    expect(result).toEqual({
      ok: false,
      error: "INVALID_TOOL_ARGUMENTS",
      field: "path",
      message: expect.stringContaining("non-empty path"),
    });
  });

  it("rejects path explicitly set to undefined", () => {
    const result = validateWriteFileArgs({ path: undefined, content: "hello" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe("path");
  });

  it("never produces the literal string \"undefined\" as a path", () => {
    const result = validateWriteFileArgs({ content: "hello" });
    expect(result.ok).toBe(false);
    // The original bug: String(undefined) === "undefined", accepted as a real path.
    if (result.ok) expect((result.value as { path: string }).path).not.toBe("undefined");
  });

  it("rejects an empty string path", () => {
    const result = validateWriteFileArgs({ path: "", content: "hello" });
    expect(result).toEqual({
      ok: false,
      error: "INVALID_TOOL_ARGUMENTS",
      field: "path",
      message: expect.stringContaining("non-empty path"),
    });
  });

  it("rejects a whitespace-only path", () => {
    const result = validateWriteFileArgs({ path: "   ", content: "hello" });
    expect(result.ok).toBe(false);
  });

  it("rejects a non-string path (wrong type)", () => {
    const result = validateWriteFileArgs({ path: 42, content: "hello" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe("path");
  });

  it("rejects missing content (key not present)", () => {
    const result = validateWriteFileArgs({ path: "src/App.tsx" });
    expect(result).toEqual({
      ok: false,
      error: "INVALID_TOOL_ARGUMENTS",
      field: "content",
      message: expect.stringContaining("content"),
    });
  });

  it("rejects content explicitly set to undefined", () => {
    const result = validateWriteFileArgs({ path: "src/App.tsx", content: undefined });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe("content");
  });

  it("rejects a non-string content (wrong type)", () => {
    const result = validateWriteFileArgs({ path: "src/App.tsx", content: { not: "a string" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe("content");
  });

  it("accepts an empty string as content (a deliberately empty file is valid)", () => {
    const result = validateWriteFileArgs({ path: "src/.gitkeep", content: "" });
    expect(result).toEqual({ ok: true, value: { path: "src/.gitkeep", content: "" } });
  });

  it("rejects arguments that aren't an object at all", () => {
    expect(validateWriteFileArgs("not an object").ok).toBe(false);
    expect(validateWriteFileArgs(null).ok).toBe(false);
    expect(validateWriteFileArgs(42).ok).toBe(false);
    expect(validateWriteFileArgs(["path", "content"]).ok).toBe(false);
  });

  it("rejects an absolute path", () => {
    const result = validateWriteFileArgs({ path: "/etc/passwd", content: "x" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.field).toBe("path");
      expect(result.message).toContain("absolute");
    }
  });

  it("rejects a path containing a .. traversal segment", () => {
    const result = validateWriteFileArgs({ path: "src/../../etc/passwd", content: "x" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.field).toBe("path");
      expect(result.message).toContain("..");
    }
  });

  it("rejects a bare .. path", () => {
    const result = validateWriteFileArgs({ path: "..", content: "x" });
    expect(result.ok).toBe(false);
  });

  it("normalizes a harmless leading ./ instead of rejecting it", () => {
    const result = validateWriteFileArgs({ path: "./src/App.tsx", content: "x" });
    expect(result).toEqual({ ok: true, value: { path: "src/App.tsx", content: "x" } });
  });
});
