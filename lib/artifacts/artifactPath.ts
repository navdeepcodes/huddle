/**
 * Session-relative storage path for any generated artifact, inside the
 * EXISTING sessionFiles store - no new storage layer. Shared by every
 * artifact type (presentations, images, ...) rather than one path
 * builder per type, since the slugification/uniqueness logic is
 * identical - only the extension differs. The unique suffix (the
 * artifact's own Firestore doc id, cheap and already unique) prevents
 * two artifacts with the same/similar title from silently overwriting
 * each other's file while leaving stale artifact metadata behind.
 */
function slugifyArtifactTitle(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "artifact"
  );
}

export function buildArtifactPath(title: string, uniqueSuffix: string, extension: string): string {
  return `artifacts/${slugifyArtifactTitle(title)}-${uniqueSuffix.slice(0, 8)}.${extension}`;
}

/**
 * Image artifacts specifically need to be embeddable in the generated
 * site itself (a hero image referenced by <img>/next/image), not just
 * downloadable - and Next.js Pages Router only serves files that live
 * under public/ as static assets at the site root. buildArtifactPath's
 * plain `artifacts/...` path is invisible to Next.js's static file
 * serving, so a generated image written there can never actually be
 * used on a page. create_presentation output stays on buildArtifactPath
 * (a deck is a downloadable deliverable, never embedded in the site).
 */
export function buildPublicArtifactPath(title: string, uniqueSuffix: string, extension: string): string {
  return `public/artifacts/${slugifyArtifactTitle(title)}-${uniqueSuffix.slice(0, 8)}.${extension}`;
}

/**
 * Phase 40 §11: ONE canonical description of a public artifact, so the
 * storage path and the browser URL can never disagree again.
 *
 * The confirmed bug this closes: create_image's tool result reported
 * `saved to public/artifacts/foo.jpg` - the STORAGE path - as the only
 * per-call statement of where the image lives. That string is not a
 * valid `src`; Next.js serves `public/` at the site root, so the real
 * URL is `/artifacts/foo.jpg`. A model copying the tool result verbatim
 * got a 404. Separately, prompt.ts said `.png` while the live
 * Cloudflare provider always returns `.jpg` - so two sources disagreed
 * with reality and with each other, and neither was derived from the
 * other. Both now come from this one function.
 */
export interface PublicArtifactLocation {
  /** Where the bytes are stored in the session file tree. */
  path: string;
  /** The URL the generated site must actually use in src/href - never the path above. */
  url: string;
  /** The real MIME type of the bytes, not an assumed one. */
  contentType: string;
}

export function buildPublicArtifactLocation(
  title: string,
  uniqueSuffix: string,
  extension: string,
  contentType: string
): PublicArtifactLocation {
  const path = buildPublicArtifactPath(title, uniqueSuffix, extension);
  return {
    path,
    // Exactly the storage path minus the `public/` prefix Next.js strips
    // when serving - derived, never hand-written, so the two cannot drift.
    url: `/${path.slice("public/".length)}`,
    contentType,
  };
}
