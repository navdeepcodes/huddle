import { describe, expect, it } from "vitest";

import { buildArtifactPath, buildPublicArtifactPath, buildPublicArtifactLocation } from "@/lib/artifacts/artifactPath";

describe("buildArtifactPath", () => {
  it("slugifies the title into a readable path with the given extension", () => {
    expect(buildArtifactPath("Huddle Pitch Deck", "abc12345", "pptx")).toBe("artifacts/huddle-pitch-deck-abc12345.pptx");
  });

  it("supports a different extension for a different artifact type", () => {
    expect(buildArtifactPath("Hero Image", "abc12345", "png")).toBe("artifacts/hero-image-abc12345.png");
  });

  it("strips punctuation and collapses whitespace", () => {
    expect(buildArtifactPath("Q3 Results!! (Final)", "xyz98765", "pptx")).toBe("artifacts/q3-results-final-xyz98765.pptx");
  });

  it("falls back to a generic name for a title with no usable characters", () => {
    expect(buildArtifactPath("!!!", "abc12345", "png")).toBe("artifacts/artifact-abc12345.png");
  });

  it("produces different paths for the same title with different suffixes, avoiding collisions", () => {
    const a = buildArtifactPath("Same Title", "aaaaaaaa", "png");
    const b = buildArtifactPath("Same Title", "bbbbbbbb", "png");
    expect(a).not.toBe(b);
  });
});

describe("buildPublicArtifactPath", () => {
  it("places the artifact under public/artifacts/ so Next.js serves it as a static file", () => {
    expect(buildPublicArtifactPath("Hero Image", "abc12345", "png")).toBe("public/artifacts/hero-image-abc12345.png");
  });

  it("slugifies and dedupes the same way buildArtifactPath does, just under public/", () => {
    expect(buildPublicArtifactPath("Q3 Results!! (Final)", "xyz98765", "jpg")).toBe("public/artifacts/q3-results-final-xyz98765.jpg");
    const a = buildPublicArtifactPath("Same Title", "aaaaaaaa", "png");
    const b = buildPublicArtifactPath("Same Title", "bbbbbbbb", "png");
    expect(a).not.toBe(b);
  });
});

/**
 * Phase 40 §11: the confirmed correctness bug. create_image's tool
 * result used to report the STORAGE path (`public/artifacts/foo.jpg`)
 * as the only statement of where the image lived - but Next.js serves
 * public/ at the site root, so the real src is `/artifacts/foo.jpg`.
 * A model copying the tool result verbatim got a guaranteed 404.
 * Separately the prompt claimed `.png` while the live provider returns
 * `.jpg`. One function now derives both, so they cannot drift.
 */
describe("buildPublicArtifactLocation", () => {
  it("derives the servable URL from the storage path by stripping exactly the public/ prefix", () => {
    const loc = buildPublicArtifactLocation("Hero Image", "abc12345", "jpg", "image/jpeg");
    expect(loc.path).toBe("public/artifacts/hero-image-abc12345.jpg");
    expect(loc.url).toBe("/artifacts/hero-image-abc12345.jpg");
    expect(loc.contentType).toBe("image/jpeg");
  });

  it("the URL is never the storage path - the exact bug that produced a 404", () => {
    const loc = buildPublicArtifactLocation("Hero", "abc12345", "jpg", "image/jpeg");
    expect(loc.url).not.toBe(loc.path);
    expect(loc.url.startsWith("/artifacts/")).toBe(true);
    expect(loc.url).not.toContain("public/");
  });

  it("reports the REAL extension and MIME type rather than an assumed .png", () => {
    const jpeg = buildPublicArtifactLocation("A", "abc12345", "jpg", "image/jpeg");
    expect(jpeg.url.endsWith(".jpg")).toBe(true);
    expect(jpeg.contentType).toBe("image/jpeg");

    const png = buildPublicArtifactLocation("A", "abc12345", "png", "image/png");
    expect(png.url.endsWith(".png")).toBe(true);
    expect(png.contentType).toBe("image/png");
  });

  it("path and url always describe the same file", () => {
    const loc = buildPublicArtifactLocation("Q3 Results!! (Final)", "xyz98765", "jpg", "image/jpeg");
    expect(`public${loc.url}`).toBe(loc.path);
  });
});
