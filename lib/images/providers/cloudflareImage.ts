import "server-only";

import { AgentProviderError, classifyAgentProviderFailure } from "@/lib/agent/provider";
import { readImageDimensions } from "@/lib/images/readImageDimensions";

import type { EditImageRequest, GenerateImageRequest, GeneratedImage, ImageProvider } from "@/lib/images/imageProvider";

/**
 * Phase 36 (revised): genuinely free image backend - Cloudflare Workers
 * AI's free tier (10,000 neurons/day, no billing account, no card).
 * Chosen after confirming live that Gemini's free tier has a hard
 * `limit: 0` for image models on this project, and that enabling
 * billing on a Gemini project REMOVES its free tier entirely rather
 * than unlocking a $0 path within it - not a fixable code problem.
 *
 * Both the request/response shape below were confirmed against the
 * REAL API before writing this (same discipline as pptxgenjs/Gemini):
 * generateImage (flux-1-schnell) returned a real, valid JPEG on the
 * first live call - `{result: {image: "<base64 jpeg>"}}`. editImage
 * (stable-diffusion-v1-5-img2img, a Beta model) failed 3/3 real
 * attempts with "Capacity temporarily exceeded" (HTTP 429) - a real,
 * observed reliability gap, not a guess. It's still implemented
 * (correct request shape, honest error surfacing) since the failure
 * looked like shared-pool capacity rather than a hard wall, but this
 * should be treated as less proven than generation until it's seen a
 * real success - see the Phase 36 report's own honesty about this.
 */
const TIMEOUT_MS = 60_000;
const GENERATE_MODEL = "@cf/black-forest-labs/flux-1-schnell";
const EDIT_MODEL = "@cf/runwayml/stable-diffusion-v1-5-img2img";

function requireCredentials(): { accountId: string; apiToken: string } {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) {
    throw new AgentProviderError("cloudflare-image", "auth", "Image generation is unavailable - no Cloudflare credentials configured.", false);
  }
  return { accountId, apiToken };
}

/** Exported for direct unit testing against real-shaped Response objects (JSON-wrapped and raw-binary), without a network mock. */
export async function parseImageResponse(response: Response): Promise<{ base64: string; mimeType: string }> {
  const contentType = response.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    const json = await response.json();
    const image = json?.result?.image;
    if (typeof image !== "string" || !image) {
      throw new AgentProviderError("cloudflare-image", "malformed_response", "The model didn't return image data.", false);
    }
    // Confirmed live: flux-1-schnell's JSON-wrapped image is a JPEG, regardless of the JSON content-type wrapper itself.
    return { base64: image, mimeType: "image/jpeg" };
  }

  if (contentType.startsWith("image/")) {
    const buf = Buffer.from(await response.arrayBuffer());
    return { base64: buf.toString("base64"), mimeType: contentType.split(";")[0].trim() };
  }

  throw new AgentProviderError("cloudflare-image", "malformed_response", "Unexpected response format from the image provider.", false);
}

async function callWorkersAI(model: string, body: Record<string, unknown>): Promise<GeneratedImage> {
  const { accountId, apiToken } = requireCredentials();
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;

  let response: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    const { kind, retryable } = classifyAgentProviderFailure(error);
    throw new AgentProviderError("cloudflare-image", kind, error instanceof Error ? error.message : String(error), retryable, error);
  }

  if (!response.ok) {
    let message = `Request failed with status ${response.status}.`;
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const json = await response.json().catch(() => null);
      const apiMessage = json?.errors?.[0]?.message;
      if (apiMessage) message = apiMessage;
    }
    const kind = response.status === 429 ? "rate_limited" : response.status === 401 || response.status === 403 ? "auth" : "unknown";
    throw new AgentProviderError("cloudflare-image", kind, message, response.status === 429);
  }

  const { base64, mimeType } = await parseImageResponse(response);
  const bytes = Buffer.from(base64, "base64");
  const dimensions = readImageDimensions(bytes, mimeType);
  if (!dimensions) {
    throw new AgentProviderError("cloudflare-image", "malformed_response", "Couldn't determine the generated image's dimensions.", false);
  }

  return { base64, mimeType, width: dimensions.width, height: dimensions.height };
}

export const cloudflareImageProvider: ImageProvider = {
  id: "cloudflare-image",

  async generateImage({ prompt, aspectRatio }: GenerateImageRequest): Promise<GeneratedImage> {
    // flux-1-schnell's documented schema is prompt/seed/steps only, no explicit aspect-ratio
    // parameter - folded into the prompt itself as a soft hint rather than assumed unsupported.
    const finalPrompt = aspectRatio ? `${prompt} (aspect ratio ${aspectRatio})` : prompt;
    return callWorkersAI(GENERATE_MODEL, { prompt: finalPrompt });
  },

  async editImage({ instruction, sourceBase64 }: EditImageRequest): Promise<GeneratedImage> {
    // img2img wants a full description of the DESIRED result, not a diff instruction like
    // Gemini's - the tool-level instruction is passed through as-is; this is a real semantic
    // difference between providers that the prompt guidance should account for.
    return callWorkersAI(EDIT_MODEL, { prompt: instruction, image_b64: sourceBase64, strength: 0.7 });
  },
};
