import { describe, expect, it } from "vitest";

import { parseImageResponse } from "@/lib/images/providers/cloudflareImage";
import { AgentProviderError } from "@/lib/agent/provider";

const REAL_JPEG_BASE64_PREFIX = "/9j/4AAQSkZJRgABAQAA";

describe("parseImageResponse (Phase 36 - Cloudflare Workers AI, confirmed shapes)", () => {
  it("parses the real, confirmed JSON-wrapped-base64 shape (flux-1-schnell)", async () => {
    const response = new Response(JSON.stringify({ result: { image: REAL_JPEG_BASE64_PREFIX }, success: true }), {
      headers: { "content-type": "application/json" },
    });
    const result = await parseImageResponse(response);
    expect(result.base64).toBe(REAL_JPEG_BASE64_PREFIX);
    expect(result.mimeType).toBe("image/jpeg");
  });

  it("parses a raw binary image response by content-type", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const response = new Response(bytes, { headers: { "content-type": "image/png" } });
    const result = await parseImageResponse(response);
    expect(result.mimeType).toBe("image/png");
    expect(Buffer.from(result.base64, "base64")).toEqual(Buffer.from(bytes));
  });

  it("throws malformed_response when JSON has no result.image field", async () => {
    const response = new Response(JSON.stringify({ result: {}, success: true }), {
      headers: { "content-type": "application/json" },
    });
    await expect(parseImageResponse(response)).rejects.toThrow(AgentProviderError);
  });

  it("throws malformed_response for an unrecognized content-type", async () => {
    const response = new Response("not an image", { headers: { "content-type": "text/plain" } });
    await expect(parseImageResponse(response)).rejects.toThrow(AgentProviderError);
  });
});
