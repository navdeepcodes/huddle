import { describe, expect, it } from "vitest";

import { processWriteFileBatch } from "@/lib/agent/processWriteFileBatch";

function call(id: string, args: Record<string, unknown> | string) {
  return { id, argumentsJson: typeof args === "string" ? args : JSON.stringify(args) };
}

describe("processWriteFileBatch", () => {
  it("persists multiple valid writes in one batch, each reported ok", () => {
    const result = processWriteFileBatch([
      call("1", { path: "a.txt", content: "A" }),
      call("2", { path: "b.txt", content: "B" }),
      call("3", { path: "c.txt", content: "C" }),
    ]);

    expect(result.toWrite).toEqual(
      expect.arrayContaining([
        { path: "a.txt", content: "A" },
        { path: "b.txt", content: "B" },
        { path: "c.txt", content: "C" },
      ])
    );
    expect(result.toWrite).toHaveLength(3);
    expect(result.results.every((r) => r.ok)).toBe(true);
  });

  it("a malformed call does not block valid calls in the same batch (partial failure)", () => {
    const result = processWriteFileBatch([
      call("A", { path: "a.txt", content: "A" }),
      call("B", { content: "no path here" }), // malformed: missing path
      call("C", { path: "c.txt", content: "C" }),
      call("D", { path: "d.txt", content: "D" }),
    ]);

    expect(result.toWrite).toEqual(
      expect.arrayContaining([
        { path: "a.txt", content: "A" },
        { path: "c.txt", content: "C" },
        { path: "d.txt", content: "D" },
      ])
    );
    expect(result.toWrite).toHaveLength(3);

    expect(result.results.find((r) => r.id === "A")?.ok).toBe(true);
    expect(result.results.find((r) => r.id === "B")?.ok).toBe(false);
    expect(result.results.find((r) => r.id === "C")?.ok).toBe(true);
    expect(result.results.find((r) => r.id === "D")?.ok).toBe(true);

    // The failure must be clearly reported, not a generic message.
    const bResult = result.results.find((r) => r.id === "B");
    expect(bResult?.message).toContain("INVALID_TOOL_ARGUMENTS");
  });

  it("duplicate paths in one batch: the last call wins and is written, earlier ones are reported as duplicate (not silently dropped, not an error)", () => {
    const result = processWriteFileBatch([
      call("1", { path: "src/App.tsx", content: "draft 1" }),
      call("2", { path: "src/App.tsx", content: "draft 2 - final" }),
    ]);

    expect(result.toWrite).toEqual([{ path: "src/App.tsx", content: "draft 2 - final" }]);

    const first = result.results.find((r) => r.id === "1");
    const second = result.results.find((r) => r.id === "2");

    expect(second?.ok).toBe(true);
    expect(second?.message).toContain("Wrote");

    expect(first?.ok).toBe(true); // not an error - the model's intent for this path did land
    expect(first?.message.toLowerCase()).toContain("superseded");
  });

  it("malformed JSON arguments (truncated mid-string) are rejected without throwing", () => {
    const result = processWriteFileBatch([
      call("1", { path: "a.txt", content: "A" }),
      call("2", '{"path": "big.txt", "content": "some very long unterminated string'), // truncated JSON
    ]);

    expect(result.toWrite).toEqual([{ path: "a.txt", content: "A" }]);
    expect(result.results.find((r) => r.id === "2")?.ok).toBe(false);
  });

  it("never throws, however malformed the input", () => {
    expect(() =>
      processWriteFileBatch([
        call("1", "not json at all {{{"),
        call("2", "null"),
        call("3", "[1,2,3]"),
        call("4", { path: "/etc/passwd", content: "x" }),
        call("5", { path: "../../escape", content: "x" }),
      ])
    ).not.toThrow();
  });

  it("returns exactly one result per input call, in the same order", () => {
    const calls = [call("x", { path: "a", content: "1" }), call("y", { content: "no path" }), call("z", { path: "b", content: "2" })];
    const result = processWriteFileBatch(calls);
    expect(result.results.map((r) => r.id)).toEqual(["x", "y", "z"]);
  });

  /**
   * Reproduces the exact live failure (2026-08-19): a real DeepSeek
   * response batched 12+ write_file calls for a component tree, and
   * several of them were missing `path`. Every such call used to
   * collide on the literal doc "undefined", so only the LAST malformed
   * call's content survived - 11 real component files silently
   * vanished with zero error anywhere in the turn.
   */
  it("integration: a 12-call batch with several missing paths loses nothing valid and creates no undefined file", () => {
    const calls = [
      call("c1", { path: "src/App.tsx", content: "app" }),
      call("c2", { path: "src/components/Header.tsx", content: "header" }),
      call("c3", { path: "src/components/Hero.tsx", content: "hero" }),
      call("c4", { content: "marquee - missing path" }), // malformed
      call("c5", { path: "src/components/Collections.tsx", content: "collections" }),
      call("c6", { content: "shop - missing path" }), // malformed
      call("c7", { path: "src/components/Craft.tsx", content: "craft" }),
      call("c8", { path: "src/components/Quote.tsx", content: "quote" }),
      call("c9", { path: "src/components/Press.tsx", content: "press" }),
      call("c10", { content: "newsletter - missing path" }), // malformed
      call("c11", { path: "src/components/Footer.tsx", content: "footer" }),
      call("c12", { path: "src/components/CartDrawer.tsx", content: "cart" }),
    ];

    const result = processWriteFileBatch(calls);

    // No "undefined" path anywhere.
    expect(result.toWrite.some((f) => f.path === "undefined")).toBe(false);
    expect(result.toWrite.some((f) => f.path.includes("undefined"))).toBe(false);

    // All 9 valid files persisted, exactly as authored.
    expect(result.toWrite).toHaveLength(9);
    expect(result.toWrite).toEqual(
      expect.arrayContaining([
        { path: "src/App.tsx", content: "app" },
        { path: "src/components/Header.tsx", content: "header" },
        { path: "src/components/Hero.tsx", content: "hero" },
        { path: "src/components/Collections.tsx", content: "collections" },
        { path: "src/components/Craft.tsx", content: "craft" },
        { path: "src/components/Quote.tsx", content: "quote" },
        { path: "src/components/Press.tsx", content: "press" },
        { path: "src/components/Footer.tsx", content: "footer" },
        { path: "src/components/CartDrawer.tsx", content: "cart" },
      ])
    );

    // No valid file's content was overwritten by a malformed call's content.
    for (const f of result.toWrite) {
      expect(f.content).not.toContain("missing path");
    }

    // The 3 malformed calls are each clearly, individually reported as failures.
    const malformedIds = ["c4", "c6", "c10"];
    for (const id of malformedIds) {
      const r = result.results.find((res) => res.id === id);
      expect(r?.ok).toBe(false);
      expect(r?.message).toContain("INVALID_TOOL_ARGUMENTS");
    }

    // The 9 valid calls are each reported ok.
    const validIds = calls.map((c) => c.id).filter((id) => !malformedIds.includes(id));
    for (const id of validIds) {
      expect(result.results.find((r) => r.id === id)?.ok).toBe(true);
    }

    // Every call got a result - nothing was dropped or crashed the batch.
    expect(result.results).toHaveLength(12);
  });
});
