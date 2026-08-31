import { describe, expect, it } from "vitest";

import { validateWriteFileArgs, validateWriteFileCallArgs } from "@/lib/agent/validateWriteFile";

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

/**
 * Phase 39 (Batch 1 follow-up): validateWriteFileCallArgs is the new
 * call-level entry point - it wraps the exact same single-file
 * validator above (unchanged) for the legacy `path`/`content` shape,
 * and adds the new `files` array shape for genuinely batching several
 * files into one call.
 */
describe("validateWriteFileCallArgs", () => {
  it("accepts the legacy single-file shape, wrapped as a one-element files array", () => {
    const result = validateWriteFileCallArgs({ path: "src/App.tsx", content: "export default function App() {}" });
    expect(result).toEqual({ ok: true, files: [{ path: "src/App.tsx", content: "export default function App() {}" }] });
  });

  it("accepts a multi-file 'files' array and validates every entry with the same rules as the single-file shape", () => {
    const result = validateWriteFileCallArgs({
      reason: "batch",
      files: [
        { path: "components/Header.js", content: "header" },
        { path: "components/Hero.js", content: "hero" },
      ],
    });
    expect(result).toEqual({
      ok: true,
      files: [
        { path: "components/Header.js", content: "header" },
        { path: "components/Hero.js", content: "hero" },
      ],
    });
  });

  it("normalizes a leading ./ within a files array entry, same as the single-file shape", () => {
    const result = validateWriteFileCallArgs({ files: [{ path: "./src/App.tsx", content: "x" }] });
    expect(result).toEqual({ ok: true, files: [{ path: "src/App.tsx", content: "x" }] });
  });

  it("rejects the whole call when 'files' is present but not an array, and not parseable as one either", () => {
    const result = validateWriteFileCallArgs({ files: "not an array" });
    expect(result.ok).toBe(false);
  });

  /**
   * Live-confirmed (2026-08-26, the first real build under this
   * feature): a model can double-encode `files` - emitting a JSON
   * array serialized AGAIN into a string (`"files": "[{...}]"`)
   * instead of a real array. Rather than reject a correctly-intended
   * call over a common tool-calling serialization quirk, this is
   * parsed defensively and treated as if the model had sent a real
   * array.
   */
  it("recovers a double-encoded 'files' string (a JSON array serialized as a string) instead of rejecting it", () => {
    const result = validateWriteFileCallArgs({
      files: JSON.stringify([
        { path: "components/Header.js", content: "header" },
        { path: "components/Hero.js", content: "hero" },
      ]),
    });
    expect(result).toEqual({
      ok: true,
      files: [
        { path: "components/Header.js", content: "header" },
        { path: "components/Hero.js", content: "hero" },
      ],
    });
  });

  it("still validates each entry's path/content normally after recovering a double-encoded files string", () => {
    const result = validateWriteFileCallArgs({
      files: JSON.stringify([{ path: "/etc/passwd", content: "x" }]),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("absolute");
  });

  it("rejects an empty files array with a clear, actionable message", () => {
    const result = validateWriteFileCallArgs({ files: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("at least one file");
  });

  it("rejects the WHOLE call when any one entry in files is invalid - not a partial acceptance", () => {
    const result = validateWriteFileCallArgs({
      files: [{ path: "a.js", content: "A" }, { path: "", content: "bad path" }, { path: "c.js", content: "C" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe("path");
  });

  it("rejects an absolute path or a .. traversal inside a files array entry, same as the single-file shape", () => {
    const abs = validateWriteFileCallArgs({ files: [{ path: "/etc/passwd", content: "x" }] });
    expect(abs.ok).toBe(false);
    const traversal = validateWriteFileCallArgs({ files: [{ path: "../escape", content: "x" }] });
    expect(traversal.ok).toBe(false);
  });

  it("falls through to a clear error when neither 'path'/'content' nor 'files' is present", () => {
    const result = validateWriteFileCallArgs({ reason: "nothing to write" });
    expect(result.ok).toBe(false);
  });

  it("rejects arguments that aren't an object at all", () => {
    expect(validateWriteFileCallArgs("not an object").ok).toBe(false);
    expect(validateWriteFileCallArgs(null).ok).toBe(false);
    expect(validateWriteFileCallArgs(42).ok).toBe(false);
  });
});
