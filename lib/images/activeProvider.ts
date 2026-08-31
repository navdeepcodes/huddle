import "server-only";

import { cloudflareImageProvider } from "@/lib/images/providers/cloudflareImage";
import { geminiImageProvider } from "@/lib/images/providers/geminiImage";

import type { ImageProvider } from "@/lib/images/imageProvider";

/**
 * Phase 36 STEP 4: "the agent should not know implementation details...
 * this keeps the model replaceable." One env var picks the backend -
 * `create_image`/`edit_image` only ever import this, never a specific
 * provider file directly, so switching backends later (a cheaper API,
 * a different free tier, self-hosted) is a config change, not a code
 * change. Defaults to Cloudflare Workers AI (free tier, no billing
 * account) - Gemini stays fully implemented and selectable via
 * IMAGE_PROVIDER=gemini once/if its account-level quota gate is
 * resolved.
 */
const PROVIDERS: Record<string, ImageProvider> = {
  cloudflare: cloudflareImageProvider,
  gemini: geminiImageProvider,
};

export const activeImageProvider: ImageProvider = PROVIDERS[process.env.IMAGE_PROVIDER ?? "cloudflare"] ?? cloudflareImageProvider;
