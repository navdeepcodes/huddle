import "server-only";

import OpenAI from "openai";

import { AgentProviderError, classifyAgentProviderFailure } from "@/lib/agent/provider";
import { readImageDimensions } from "@/lib/images/readImageDimensions";

import type { EditImageRequest, GenerateImageRequest, GeneratedImage, ImageProvider } from "@/lib/images/imageProvider";

/**
 * Phase 36: the hosted image creator - Google's Gemini image model via
 * the SAME already-proven OpenAI-compatible endpoint geminiVision.ts
 * already uses in production for vision analysis (same base URL, same
 * OpenAI SDK client, same AgentProviderError/classifyAgentProviderFailure
 * error shape). Not a second HTTP client or a new provider pattern.
 *
 * Model name confirmed live against the real API (2026-08-25):
 * gemini-2.5-flash-image was deprecated/shut down 2026-08-17 - using it
 * would fail outright. gemini-3.1-flash-image is the current model;
 * confirmed correct (not just assumed) because a real request against it
 * returned 429 quota-exceeded rather than 404 model-not-found, which
 * only happens for a model/endpoint combination the API actually
 * recognizes and routes. That same live check found this API key's
 * project has a hard 0 free-tier quota for every image-capable model in
 * the family (not "used up" - `limit: 0` in the quota violation detail)
 * - an account-level billing/tier setting only the project owner can
 * change, not something this code can work around.
 *
 * Zero retries on the provider call (maxRetries: 0) - STEP 19's own
 * instruction: a failed image request can cost real money, so retrying
 * blindly on a non-transient failure isn't safe the way it is for a
 * free text completion.
 */
const IMAGE_TIMEOUT_MS = 60_000;
const MODEL = process.env.GEMINI_IMAGE_MODEL || "gemini-3.1-flash-image";

function requireClient(): OpenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new AgentProviderError("gemini-image", "auth", "Image generation is unavailable - no GEMINI_API_KEY configured.", false);
  }
  return new OpenAI({ apiKey, baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/" });
}

/**
 * The exact field the Gemini OpenAI-compatible layer uses for image
 * OUTPUT isn't pinned down by a real successful response this session
 * (every live attempt hit the account's 0-quota wall before returning
 * one - see the module doc comment) - published examples disagree with
 * each other. Rather than trust one unverified guess, this checks every
 * plausible shape and fails loudly (a clear malformed_response error,
 * never a fabricated empty image) if none match - exactly this phase's
 * own "never create a successful artifact from output you can't parse"
 * rule.
 */
export function extractImageDataUrl(message: unknown): { base64: string; mimeType: string } {
  const msg = message as Record<string, unknown> | undefined;
  const candidates: Array<string | undefined> = [];

  const images = msg?.images as Array<{ image_url?: { url?: string } }> | undefined;
  if (Array.isArray(images)) {
    for (const img of images) if (img?.image_url?.url) candidates.push(img.image_url.url);
  }

  const content = msg?.content;
  if (Array.isArray(content)) {
    for (const part of content as Array<Record<string, unknown>>) {
      const url = (part.image_url as { url?: string } | undefined)?.url;
      if (url) candidates.push(url);
    }
  } else if (typeof content === "string" && content.startsWith("data:image/")) {
    candidates.push(content);
  }

  const dataUrl = candidates.find((c) => c?.startsWith("data:"));
  if (!dataUrl) {
    throw new AgentProviderError("gemini-image", "malformed_response", "The model didn't return image data in a recognized format.", false);
  }

  const match = dataUrl.match(/^data:([\w/+-]+);base64,(.+)$/);
  if (!match) {
    throw new AgentProviderError("gemini-image", "malformed_response", "The returned image wasn't valid base64 image data.", false);
  }
  return { mimeType: match[1], base64: match[2] };
}

async function callGemini(messages: OpenAI.Chat.ChatCompletionMessageParam[]): Promise<GeneratedImage> {
  try {
    // Gemini's OpenAI-compatible layer accepts "image" as a modalities value -
    // a real, documented extension beyond the OpenAI SDK's own stricter
    // "text" | "audio" type, hence the cast.
    const params = {
      model: MODEL,
      messages,
      modalities: ["image", "text"],
    } as unknown as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming;
    const completion = await requireClient().chat.completions.create(params, { timeout: IMAGE_TIMEOUT_MS, maxRetries: 0 });

    const { base64, mimeType } = extractImageDataUrl(completion.choices[0]?.message);
    const bytes = Buffer.from(base64, "base64");
    const dimensions = readImageDimensions(bytes, mimeType);
    if (!dimensions) {
      throw new AgentProviderError("gemini-image", "malformed_response", "Couldn't determine the generated image's dimensions.", false);
    }

    return { base64, mimeType, width: dimensions.width, height: dimensions.height };
  } catch (error) {
    if (error instanceof AgentProviderError) throw error;
    const { kind, retryable } = classifyAgentProviderFailure(error);
    throw new AgentProviderError("gemini-image", kind, error instanceof Error ? error.message : String(error), retryable, error);
  }
}

export const geminiImageProvider: ImageProvider = {
  id: "gemini-image",

  async generateImage({ prompt, aspectRatio }: GenerateImageRequest): Promise<GeneratedImage> {
    const instruction = aspectRatio ? `${prompt}\n\n(Aspect ratio: ${aspectRatio})` : prompt;
    return callGemini([{ role: "user", content: instruction }]);
  },

  async editImage({ instruction, sourceBase64, sourceMimeType }: EditImageRequest): Promise<GeneratedImage> {
    return callGemini([
      {
        role: "user",
        content: [
          { type: "text", text: instruction },
          { type: "image_url", image_url: { url: `data:${sourceMimeType};base64,${sourceBase64}` } },
        ],
      },
    ]);
  },
};
