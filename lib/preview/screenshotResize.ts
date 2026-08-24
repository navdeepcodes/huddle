import "server-only";

import sharp from "sharp";

/**
 * Phase 26: the capture itself (lib/preview/captureScript.ts, frozen
 * this phase - client-side WebContainer capture infrastructure) already
 * shoots at scale:1 and JPEG@0.85 rather than a naive retina PNG (see
 * that file's own doc comment - a retina PNG blew past Firestore's 1MiB
 * document limit). This is a second, independent resize step, applied
 * server-side right before a screenshot is handed to EITHER vision
 * provider - not to fit a storage limit again, but because a vision
 * model doesn't need 1440px of width to judge layout/spacing/hierarchy,
 * and a smaller image means less to encode into visual tokens (cost and
 * latency, especially for local inference - see qwenVision.ts's own
 * measured-latency doc comment).
 */
const MAX_WIDTH = 960;
const JPEG_QUALITY = 78;

export interface ResizedScreenshot {
  dataUrl: string;
  width: number;
  height: number;
  originalBytes: number;
  resizedBytes: number;
}

function dataUrlToBuffer(dataUrl: string): Buffer {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return Buffer.from(base64, "base64");
}

/**
 * No-ops (returns the original untouched, just with byte counts filled
 * in) when the image is already at or under MAX_WIDTH - never upscales,
 * and never risks making a small/simple capture worse.
 */
export async function resizeScreenshotForVision(dataUrl: string): Promise<ResizedScreenshot> {
  const original = dataUrlToBuffer(dataUrl);
  const metadata = await sharp(original).metadata();
  const originalWidth = metadata.width ?? MAX_WIDTH;
  const originalHeight = metadata.height ?? 0;

  if (originalWidth <= MAX_WIDTH) {
    return {
      dataUrl,
      width: originalWidth,
      height: originalHeight,
      originalBytes: original.length,
      resizedBytes: original.length,
    };
  }

  const resized = sharp(original).resize({ width: MAX_WIDTH });
  const buffer = await resized.jpeg({ quality: JPEG_QUALITY }).toBuffer();
  const resizedMetadata = await sharp(buffer).metadata();

  return {
    dataUrl: `data:image/jpeg;base64,${buffer.toString("base64")}`,
    width: resizedMetadata.width ?? MAX_WIDTH,
    height: resizedMetadata.height ?? Math.round((originalHeight / originalWidth) * MAX_WIDTH),
    originalBytes: original.length,
    resizedBytes: buffer.length,
  };
}
