import { describe, expect, it } from "vitest";
import sharp from "sharp";

import { resizeScreenshotForVision } from "@/lib/preview/screenshotResize";

async function makeDataUrl(width: number, height: number): Promise<string> {
  const buffer = await sharp({
    create: { width, height, channels: 3, background: { r: 100, g: 140, b: 220 } },
  })
    .jpeg({ quality: 90 })
    .toBuffer();
  return `data:image/jpeg;base64,${buffer.toString("base64")}`;
}

describe("resizeScreenshotForVision (Phase 26 section 6/10 item 10)", () => {
  it("resizes a large screenshot down to the max width while preserving aspect ratio", async () => {
    const dataUrl = await makeDataUrl(1440, 900);
    const result = await resizeScreenshotForVision(dataUrl);

    expect(result.width).toBeLessThanOrEqual(960);
    expect(result.width).toBeGreaterThan(0);
    // Aspect ratio preserved within rounding: 1440x900 is 1.6:1.
    expect(result.height / result.width).toBeCloseTo(900 / 1440, 1);
  });

  it("meaningfully reduces byte size for a large screenshot", async () => {
    const dataUrl = await makeDataUrl(1440, 900);
    const result = await resizeScreenshotForVision(dataUrl);

    expect(result.resizedBytes).toBeLessThan(result.originalBytes);
  });

  it("does not upscale or otherwise alter an already-small screenshot", async () => {
    const dataUrl = await makeDataUrl(600, 400);
    const result = await resizeScreenshotForVision(dataUrl);

    expect(result.width).toBe(600);
    expect(result.height).toBe(400);
    expect(result.dataUrl).toBe(dataUrl);
  });

  it("preserves enough resolution for text/layout evaluation - never reduces below a usable floor for a real screenshot-sized input", async () => {
    const dataUrl = await makeDataUrl(1920, 1200);
    const result = await resizeScreenshotForVision(dataUrl);

    // 960px wide is still comfortably enough to read a typical UI's
    // hierarchy/spacing/typography - not reduced to a thumbnail.
    expect(result.width).toBeGreaterThanOrEqual(900);
  });
});
