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

export type WriteFileCallValidationResult =
  | { ok: true; files: WriteFileArgs[] }
  | WriteFileValidationError;

/**
 * Phase 39 (Batch 1 follow-up, "file explosion" fix): a single
 * write_file CALL can now describe one file (the original `path`/
 * `content` shortcut, unchanged and still fully valid) or several
 * (`files: [{path, content}, ...]`). Root cause this exists to close:
 * live evidence across every build tonight showed the model reliably
 * writing exactly one file per turn even with `parallel_tool_calls:
 * true` already enabled at the provider layer and explicit prompt
 * guidance to batch - the model simply never emits more than one
 * `write_file` tool_call in a single response. A model producing one
 * larger JSON payload (several files inside ONE call's arguments) is
 * a much more ordinary capability than emitting several parallel
 * function calls, so this reframes "batch your writes" as a schema
 * affordance instead of relying on provider-native parallel tool
 * calls the model isn't using.
 *
 * Deliberately whole-call-or-nothing, same discipline as the original
 * single-file validator: a `files` array with even one malformed entry
 * rejects the WHOLE call (not a partial batch) - a model that gets
 * this wrong needs a clear, unambiguous signal to retry the call
 * correctly, not a confusing mix of some-files-written/some-not from
 * one tool_call_id.
 */
export function validateWriteFileCallArgs(args: unknown): WriteFileCallValidationResult {
  if (typeof args !== "object" || args === null) {
    return invalid("path", "write_file arguments were not a JSON object.");
  }

  const record = args as Record<string, unknown>;

  if (record.files !== undefined) {
    let filesValue = record.files;
    // Live-confirmed model quirk (2026-08-26, first real build under this
    // feature): a model can double-encode a nested argument - emitting
    // `"files": "[{...}, {...}]"` (a JSON array serialized AGAIN into a
    // string) instead of a real array. Parsed defensively here rather
    // than rejected outright, since this is a well-understood, common
    // tool-calling quirk (not a sign the model's intent was wrong) and
    // costs a full wasted round-trip to recover from otherwise. Only
    // ever a fallback - a genuine array (the normal case) never reaches
    // this branch.
    if (typeof filesValue === "string") {
      try {
        const parsed = JSON.parse(filesValue);
        if (Array.isArray(parsed)) filesValue = parsed;
      } catch {
        // Not valid JSON either - falls through to the "not an array" rejection below, unchanged.
      }
    }

    if (!Array.isArray(filesValue)) {
      return invalid("path", "write_file's 'files' argument, if present, must be an array of {path, content} objects.");
    }
    if (filesValue.length === 0) {
      return invalid("path", "write_file's 'files' array must contain at least one file - omit 'files' entirely and use 'path'/'content' for a single file instead.");
    }

    const files: WriteFileArgs[] = [];
    for (const entry of filesValue) {
      const single = validateWriteFileArgs(entry);
      if (!single.ok) return single;
      files.push(single.value);
    }
    return { ok: true, files };
  }

  // No 'files' array - fall back to the original single-file shape,
  // unchanged behavior (including its exact error messages/fields).
  const single = validateWriteFileArgs(record);
  if (!single.ok) return single;
  return { ok: true, files: [single.value] };
}
