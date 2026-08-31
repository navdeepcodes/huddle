import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Phase 39: scaffold_nextjs_project through executeTool - same mocking
 * pattern as executeToolImages.test.ts. Proves the tool writes exactly
 * the deterministic scaffold files via batchWriteSessionFiles (never
 * generates them itself) and returns a clear, honest result.
 */
const batchWriteSessionFiles = vi.fn();
vi.mock("@/lib/files/fileStore", () => ({
  batchWriteSessionFiles: (...args: unknown[]) => batchWriteSessionFiles(...args),
  readSessionFile: vi.fn(),
  deleteSessionFile: vi.fn(),
  listSessionDirectory: vi.fn(),
}));

vi.mock("@/lib/runtime/commandRelay", () => ({ dispatchRuntimeCommand: vi.fn() }));
vi.mock("@/lib/preview/viewPreview", () => ({ viewPreview: vi.fn() }));

const { executeTool } = await import("@/lib/agent/executeTool");

function toolCall(name: string, args: Record<string, unknown> = {}) {
  return {
    id: "call-1",
    type: "function" as const,
    function: { name, arguments: JSON.stringify(args) },
  };
}

beforeEach(() => {
  batchWriteSessionFiles.mockReset();
});

describe("executeTool - scaffold_nextjs_project (Phase 39, extended Phase 40)", () => {
  it("writes the seven scaffold files via batchWriteSessionFiles, all attributed to the agent", async () => {
    const result = await executeTool("session-1", toolCall("scaffold_nextjs_project", { projectName: "Ember & Oak", reason: "starting the build" }));

    expect(result.ok).toBe(true);
    expect(batchWriteSessionFiles).toHaveBeenCalledTimes(1);
    const [sessionId, files] = batchWriteSessionFiles.mock.calls[0];
    expect(sessionId).toBe("session-1");
    expect(files.map((f: { path: string }) => f.path).sort()).toEqual(
      ["next.config.mjs", "package.json", "postcss.config.mjs", "pages/_app.js", "styles/globals.css", "lib/utils.js", "lib/ErrorBoundary.js"].sort()
    );
    for (const f of files) expect(f.updatedBy).toBe("agent");
  });

  it("works with no projectName given at all", async () => {
    const result = await executeTool("session-1", toolCall("scaffold_nextjs_project", { reason: "starting the build" }));
    expect(result.ok).toBe(true);
    expect(batchWriteSessionFiles).toHaveBeenCalledTimes(1);
  });

  it("never writes pages/index.js or any component under components/ - that stays the model's own creative work (lib/ is plumbing, not content)", async () => {
    await executeTool("session-1", toolCall("scaffold_nextjs_project", { reason: "starting the build" }));
    const files = batchWriteSessionFiles.mock.calls[0][1] as Array<{ path: string }>;
    expect(files.some((f) => f.path === "pages/index.js")).toBe(false);
    expect(files.some((f) => f.path.startsWith("components/"))).toBe(false);
  });

  it("tells the model to fill in the theme and not rewrite the scaffolded files", async () => {
    const result = await executeTool("session-1", toolCall("scaffold_nextjs_project", { reason: "starting the build" }));
    expect(result.content).toContain("@theme");
    expect(result.content.toLowerCase()).toContain("do not rewrite");
  });
});
