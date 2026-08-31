import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Phase 36: create_image/edit_image through executeTool, with the
 * image provider and Firestore-backed stores mocked - same pattern as
 * executeTool.test.ts's view_preview tests. Never hits the real
 * network/API; the one real-provider check lives in
 * scripts/smokeTestGeminiImage.mjs, run manually, separate from this
 * suite.
 */
const generateImage = vi.fn();
const editImage = vi.fn();
vi.mock("@/lib/images/activeProvider", () => ({
  activeImageProvider: {
    id: "test-image-provider",
    generateImage: (...args: unknown[]) => generateImage(...args),
    editImage: (...args: unknown[]) => editImage(...args),
  },
}));

const createArtifact = vi.fn();
const markArtifactReady = vi.fn();
const markArtifactFailed = vi.fn();
const getArtifact = vi.fn();
vi.mock("@/lib/artifacts/artifactStore", () => ({
  createArtifact: (...args: unknown[]) => createArtifact(...args),
  markArtifactReady: (...args: unknown[]) => markArtifactReady(...args),
  markArtifactFailed: (...args: unknown[]) => markArtifactFailed(...args),
  getArtifact: (...args: unknown[]) => getArtifact(...args),
}));

const batchWriteSessionFiles = vi.fn();
const readSessionFile = vi.fn();
vi.mock("@/lib/files/fileStore", () => ({
  batchWriteSessionFiles: (...args: unknown[]) => batchWriteSessionFiles(...args),
  readSessionFile: (...args: unknown[]) => readSessionFile(...args),
  deleteSessionFile: vi.fn(),
  listSessionDirectory: vi.fn(),
}));

vi.mock("@/lib/runtime/commandRelay", () => ({ dispatchRuntimeCommand: vi.fn() }));
vi.mock("@/lib/preview/viewPreview", () => ({ viewPreview: vi.fn() }));

const { executeTool } = await import("@/lib/agent/executeTool");
const { AgentProviderError } = await import("@/lib/agent/provider");

function toolCall(name: string, args: Record<string, unknown> = {}) {
  return { id: "call-1", type: "function" as const, function: { name, arguments: JSON.stringify(args) } };
}

beforeEach(() => {
  generateImage.mockReset();
  editImage.mockReset();
  createArtifact.mockReset().mockResolvedValue({ id: "artifact-1", sessionId: "s1", type: "image", status: "generating" });
  markArtifactReady.mockReset();
  markArtifactFailed.mockReset();
  getArtifact.mockReset();
  batchWriteSessionFiles.mockReset();
  readSessionFile.mockReset();
});

describe("executeTool - create_image", () => {
  it("rejects an invalid request without calling the provider at all", async () => {
    const result = await executeTool("s1", toolCall("create_image", {}));
    expect(result.ok).toBe(false);
    expect(generateImage).not.toHaveBeenCalled();
    expect(createArtifact).not.toHaveBeenCalled();
  });

  it("creates a real artifact on success, with real dimensions in the result", async () => {
    generateImage.mockResolvedValue({ base64: "abc", mimeType: "image/png", width: 1536, height: 1024 });

    const result = await executeTool("s1", toolCall("create_image", { prompt: "a hero image for Huddle", reason: "x" }));

    expect(result.ok).toBe(true);
    expect(result.content).toContain("1536×1024");
    expect(createArtifact).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "s1", type: "image" }));
    expect(batchWriteSessionFiles).toHaveBeenCalledOnce();
    expect(markArtifactReady).toHaveBeenCalledWith("artifact-1", expect.objectContaining({ width: 1536, height: 1024 }), expect.any(String));
  });

  it("marks the artifact failed and reports honestly when the provider fails - never a fake success", async () => {
    generateImage.mockRejectedValue(new AgentProviderError("gemini-image", "rate_limited", "quota exceeded", true));

    const result = await executeTool("s1", toolCall("create_image", { prompt: "a hero image", reason: "x" }));

    expect(result.ok).toBe(false);
    expect(result.content).toMatch(/rate-limited|quota/i);
    expect(markArtifactFailed).toHaveBeenCalledWith("artifact-1", expect.any(String));
    expect(batchWriteSessionFiles).not.toHaveBeenCalled();
  });

  it("reports a clear, honest message when the provider is unconfigured", async () => {
    generateImage.mockRejectedValue(new AgentProviderError("gemini-image", "auth", "No GEMINI_API_KEY configured.", false));

    const result = await executeTool("s1", toolCall("create_image", { prompt: "a hero image", reason: "x" }));

    expect(result.ok).toBe(false);
    expect(result.content).toMatch(/unavailable/i);
  });
});

describe("executeTool - edit_image", () => {
  it("rejects when the source artifact doesn't exist in this project", async () => {
    getArtifact.mockResolvedValue(null);
    const result = await executeTool("s1", toolCall("edit_image", { sourceArtifactId: "nope", instruction: "warmer", reason: "x" }));
    expect(result.ok).toBe(false);
    expect(editImage).not.toHaveBeenCalled();
  });

  it("rejects when the source artifact exists but isn't an image", async () => {
    getArtifact.mockResolvedValue({ id: "p1", type: "presentation", status: "ready", path: "artifacts/x.pptx" });
    const result = await executeTool("s1", toolCall("edit_image", { sourceArtifactId: "p1", instruction: "warmer", reason: "x" }));
    expect(result.ok).toBe(false);
  });

  it("rejects when the source image isn't ready yet", async () => {
    getArtifact.mockResolvedValue({ id: "img1", type: "image", status: "generating", path: "artifacts/x.png" });
    const result = await executeTool("s1", toolCall("edit_image", { sourceArtifactId: "img1", instruction: "warmer", reason: "x" }));
    expect(result.ok).toBe(false);
  });

  it("creates a NEW artifact on success and never touches the original", async () => {
    getArtifact.mockResolvedValue({ id: "img1", type: "image", status: "ready", path: "artifacts/original-img1.png" });
    readSessionFile.mockResolvedValue({ content: "sourcebytes", encoding: "base64" });
    editImage.mockResolvedValue({ base64: "editedbytes", mimeType: "image/png", width: 1024, height: 1024 });

    const result = await executeTool("s1", toolCall("edit_image", { sourceArtifactId: "img1", instruction: "make it warmer", reason: "x" }));

    expect(result.ok).toBe(true);
    expect(result.content).toContain("original image is unchanged");
    // A new artifact record is created for the edit - the source is never re-written.
    expect(createArtifact).toHaveBeenCalledOnce();
    const writtenPaths = batchWriteSessionFiles.mock.calls[0][1].map((f: { path: string }) => f.path);
    expect(writtenPaths).not.toContain("artifacts/original-img1.png");
  });

  it("reports failure honestly and preserves the original when the provider fails", async () => {
    getArtifact.mockResolvedValue({ id: "img1", type: "image", status: "ready", path: "artifacts/original-img1.png" });
    readSessionFile.mockResolvedValue({ content: "sourcebytes", encoding: "base64" });
    editImage.mockRejectedValue(new AgentProviderError("gemini-image", "timeout", "took too long", true));

    const result = await executeTool("s1", toolCall("edit_image", { sourceArtifactId: "img1", instruction: "warmer", reason: "x" }));

    expect(result.ok).toBe(false);
    expect(result.content).toContain("original image is unchanged");
    expect(batchWriteSessionFiles).not.toHaveBeenCalled();
  });
});
