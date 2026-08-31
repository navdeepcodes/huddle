import { describe, expect, it } from "vitest";

import { validateEditImageInput, validateGenerateImageInput } from "@/lib/images/schema";

describe("validateGenerateImageInput", () => {
  it("accepts a well-formed request", () => {
    const result = validateGenerateImageInput({ prompt: "a cinematic sunset over a futuristic city" });
    expect(result.ok).toBe(true);
  });

  it("rejects a missing prompt", () => {
    expect(validateGenerateImageInput({}).ok).toBe(false);
  });

  it("rejects an empty prompt", () => {
    expect(validateGenerateImageInput({ prompt: "   " }).ok).toBe(false);
  });

  it("rejects an excessively long prompt", () => {
    expect(validateGenerateImageInput({ prompt: "x".repeat(2000) }).ok).toBe(false);
  });

  it("rejects an invalid aspect ratio", () => {
    const result = validateGenerateImageInput({ prompt: "a cat", aspectRatio: "5:37" });
    expect(result.ok).toBe(false);
  });

  it("accepts a valid aspect ratio", () => {
    const result = validateGenerateImageInput({ prompt: "a cat", aspectRatio: "16:9" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.aspectRatio).toBe("16:9");
  });

  it("derives a title from the prompt when none is given", () => {
    const result = validateGenerateImageInput({ prompt: "a cozy reading nook" });
    if (result.ok) expect(result.title.length).toBeGreaterThan(0);
  });

  it("rejects a non-object payload", () => {
    expect(validateGenerateImageInput(null).ok).toBe(false);
    expect(validateGenerateImageInput("nope").ok).toBe(false);
  });
});

describe("validateEditImageInput", () => {
  it("accepts a well-formed edit request", () => {
    const result = validateEditImageInput({ sourceArtifactId: "abc123", instruction: "make it warmer" });
    expect(result.ok).toBe(true);
  });

  it("rejects a missing sourceArtifactId", () => {
    expect(validateEditImageInput({ instruction: "make it warmer" }).ok).toBe(false);
  });

  it("rejects a missing instruction", () => {
    expect(validateEditImageInput({ sourceArtifactId: "abc123" }).ok).toBe(false);
  });

  it("rejects an excessively long instruction", () => {
    const result = validateEditImageInput({ sourceArtifactId: "abc123", instruction: "y".repeat(1000) });
    expect(result.ok).toBe(false);
  });

  it("defaults the title when none is given", () => {
    const result = validateEditImageInput({ sourceArtifactId: "abc123", instruction: "make it warmer" });
    if (result.ok) expect(result.title).toBe("Edited image");
  });
});
