import { describe, expect, it } from "vitest";

import { extractImageDataUrl } from "@/lib/images/providers/geminiImage";
import { AgentProviderError } from "@/lib/agent/provider";

const REAL_PNG_2X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGP8z8DwHwMKYBwVAAB2JQMBoJKvUwAAAABJRU5ErkJggg==";

describe("extractImageDataUrl (Phase 36 - response-shape uncertainty guard)", () => {
  it("extracts from message.images[0].image_url.url", () => {
    const result = extractImageDataUrl({ images: [{ image_url: { url: `data:image/png;base64,${REAL_PNG_2X1_BASE64}` } }] });
    expect(result.mimeType).toBe("image/png");
    expect(result.base64).toBe(REAL_PNG_2X1_BASE64);
  });

  it("extracts from a content array with an image_url part", () => {
    const result = extractImageDataUrl({
      content: [
        { type: "text", text: "here you go" },
        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${REAL_PNG_2X1_BASE64}` } },
      ],
    });
    expect(result.mimeType).toBe("image/jpeg");
  });

  it("extracts from a plain data: URI as the string content", () => {
    const result = extractImageDataUrl({ content: `data:image/png;base64,${REAL_PNG_2X1_BASE64}` });
    expect(result.base64).toBe(REAL_PNG_2X1_BASE64);
  });

  it("throws a clear malformed_response error rather than fabricating data when nothing matches", () => {
    expect(() => extractImageDataUrl({ content: "Sorry, I can't do that." })).toThrow(AgentProviderError);
    try {
      extractImageDataUrl({ content: "no image here" });
    } catch (error) {
      expect(error).toBeInstanceOf(AgentProviderError);
      expect((error as AgentProviderError).kind).toBe("malformed_response");
      expect((error as AgentProviderError).retryable).toBe(false);
    }
  });

  it("throws on a data URI with no actual base64 payload", () => {
    expect(() => extractImageDataUrl({ content: "data:image/png;base64," })).toThrow(AgentProviderError);
  });

  it("throws when the message is undefined entirely", () => {
    expect(() => extractImageDataUrl(undefined)).toThrow(AgentProviderError);
  });
});
