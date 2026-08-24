import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Phase 26 section 10 item 1: proves the request this provider builds
 * actually carries the image (as an image_url content block, the same
 * shape the rest of this codebase's vision call already used) and the
 * prompt text - without needing a real Ollama/Qwen model running. Mocks
 * the openai SDK itself (no existing precedent for this in the
 * codebase - the other provider files were only ever tested indirectly
 * through providerRecovery.test.ts's fake providers - so this is the
 * first direct provider-file test, deliberately narrow).
 */
const create = vi.fn();

vi.mock("openai", () => ({
  default: class FakeOpenAI {
    chat = { completions: { create } };
  },
}));

const { qwenVisionProvider } = await import("@/lib/preview/providers/qwenVision");
const { AgentProviderError } = await import("@/lib/agent/provider");

beforeEach(() => {
  create.mockReset();
});

describe("qwenVisionProvider (Phase 26)", () => {
  it("1. sends the screenshot as an image_url content block alongside the prompt text", async () => {
    create.mockResolvedValue({ choices: [{ message: { content: "ISSUES:\n- none" } }] });

    await qwenVisionProvider.analyze("data:image/jpeg;base64,abc123", "evaluate this screenshot");

    expect(create).toHaveBeenCalledTimes(1);
    const request = create.mock.calls[0][0];
    expect(request.messages[0].content).toEqual([
      { type: "text", text: "evaluate this screenshot" },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,abc123" } },
    ]);
  });

  it("returns the model's text critique on success", async () => {
    create.mockResolvedValue({ choices: [{ message: { content: "ISSUES:\n- hero text is low contrast" } }] });

    const critique = await qwenVisionProvider.analyze("data:image/jpeg;base64,x", "prompt");

    expect(critique).toBe("ISSUES:\n- hero text is low contrast");
  });

  it("throws a retryable AgentProviderError on a connection failure", async () => {
    create.mockRejectedValue(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:11434"), {}));

    await expect(qwenVisionProvider.analyze("data:image/jpeg;base64,x", "prompt")).rejects.toMatchObject({
      provider: "local-qwen",
      retryable: true,
    });
  });

  it("throws when the model returns no text at all, rather than silently succeeding with empty content", async () => {
    create.mockResolvedValue({ choices: [{ message: { content: "" } }] });

    await expect(qwenVisionProvider.analyze("data:image/jpeg;base64,x", "prompt")).rejects.toBeInstanceOf(
      AgentProviderError
    );
  });

  it("uses the configured model name from the environment default, not a different hardcoded one", async () => {
    create.mockResolvedValue({ choices: [{ message: { content: "ok" } }] });
    await qwenVisionProvider.analyze("data:image/jpeg;base64,x", "prompt");
    const request = create.mock.calls[0][0];
    expect(request.model).toBe(process.env.OLLAMA_VISION_MODEL || "qwen2.5vl-16k:latest");
  });
});
