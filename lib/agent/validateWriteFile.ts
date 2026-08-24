/**
 * Server-side validation for write_file tool-call arguments, applied
 * BEFORE anything reaches fileStore/Firestore.
 *
 * Root cause this exists to close (confirmed live, 2026-08-19): the
 * previous code did `String(args.path)` unconditionally. A model
 * response can be syntactically valid JSON that simply omits `path`
 * (or `content`) - JSON.parse succeeds, `args.path` is `undefined`,
 * and `String(undefined)` silently becomes the literal path
 * "undefined". Every malformed call in a batch then collided on that
 * SAME Firestore doc, so only the last one survived - real component
 * files (Header, Hero, Marquee, ...) vanished with no error anywhere.
 *
 * The model's tool call is untrusted input, same as any other
 * external input - this validates it the same way a request body at
 * an API boundary would be validated, never guessing or inventing a
 * value for what's missing.
 */

export interface WriteFileArgs {
  path: string;
  content: string;
}

export interface WriteFileValidationError {
  ok: false;
  error: "INVALID_TOOL_ARGUMENTS";
  field: "path" | "content";
  message: string;
}

export type WriteFileValidationResult =
  | { ok: true; value: WriteFileArgs }
  | WriteFileValidationError;

function invalid(field: "path" | "content", message: string): WriteFileValidationError {
  return { ok: false, error: "INVALID_TOOL_ARGUMENTS", field, message };
}

/**
 * Rejects (does not normalize away) anything that looks like an
 * attempt to escape the session's own flat file namespace - empty,
 * absolute, or containing a `..` segment. A small deterministic check,
 * not a filesystem-permissions subsystem: this store has no real
 * directories to escape, but the WebContainer runtime these paths are
 * later synced into does, so a path that would misbehave there must
 * never reach persistence here either.
 */
function validatePath(rawPath: unknown): { ok: true; path: string } | WriteFileValidationError {
  if (typeof rawPath !== "string") {
    return invalid("path", "write_file requires a non-empty path string.");
  }

  // Normalize a leading "./" (a common, harmless model habit) before
  // validating - this is normalization of an already-well-formed
  // relative path, not an attempt to rescue a missing/malformed one.
  const path = rawPath.trim().replace(/^\.\/+/, "");

  if (path.length === 0) {
    return invalid("path", "write_file requires a non-empty path string.");
  }

  if (path.startsWith("/")) {
    return invalid("path", `"${rawPath}" is an absolute path - paths must be relative to the session root.`);
  }

  if (path.split("/").some((segment) => segment === "..")) {
    return invalid("path", `"${rawPath}" contains a ".." segment, which would escape the session root.`);
  }

  return { ok: true, path };
}

export function validateWriteFileArgs(args: unknown): WriteFileValidationResult {
  if (typeof args !== "object" || args === null) {
    return invalid("path", "write_file arguments were not a JSON object.");
  }

  const record = args as Record<string, unknown>;

  const pathResult = validatePath(record.path);
  if (!pathResult.ok) return pathResult;

  if (typeof record.content !== "string") {
    return invalid("content", "write_file requires its content argument to be a string.");
  }

  return { ok: true, value: { path: pathResult.path, content: record.content } };
}
