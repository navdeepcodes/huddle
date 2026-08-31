import { describe, expect, it } from "vitest";

import { readImageDimensions } from "@/lib/images/readImageDimensions";

/** A real, minimal, valid 2x1 PNG (base64) - not a hand-rolled fake header, an actual PNG file's bytes. */
const REAL_PNG_2X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGP8z8DwHwMKYBwVAAB2JQMBoJKvUwAAAABJRU5ErkJggg==";

describe("readImageDimensions", () => {
  it("reads real width/height from actual PNG header bytes", () => {
    const bytes = Buffer.from(REAL_PNG_2X1_BASE64, "base64");
    expect(readImageDimensions(bytes, "image/png")).toEqual({ width: 2, height: 1 });
  });

  it("returns null for bytes that aren't a real PNG", () => {
    expect(readImageDimensions(Buffer.from("not a png"), "image/png")).toBeNull();
  });

  it("returns null for a truncated PNG (too short to hold a header)", () => {
    expect(readImageDimensions(Buffer.from([0x89, 0x50, 0x4e, 0x47]), "image/png")).toBeNull();
  });

  it("returns null for an unsupported mime type", () => {
    const bytes = Buffer.from(REAL_PNG_2X1_BASE64, "base64");
    expect(readImageDimensions(bytes, "image/gif")).toBeNull();
  });

  it("returns null for JPEG bytes with no real SOF marker", () => {
    expect(readImageDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), "image/jpeg")).toBeNull();
  });
});
