import { validateWriteFileCallArgs } from "@/lib/agent/validateWriteFile";

/**
 * Pure decision logic for one step's write_file batch - extracted from
 * lib/agent/loop.ts so it's testable without Firestore/DeepSeek. Given
 * the raw tool calls, decides exactly what should be persisted and what
 * each call's own tool-result message should say. The loop is
 * responsible only for the actual Firestore write and telemetry/log
 * bookkeeping around this.
 *
 * Never throws: every call, however malformed, resolves to one result
 * entry. That's what keeps one bad model-generated call from taking
 * down the rest of the batch or the turn itself.
 *
 * Phase 39 (Batch 1 follow-up): a single input call can now describe
 * MULTIPLE files (see validateWriteFileCallArgs) - the OpenAI-shaped
 * `messages` array still needs exactly one tool-result per tool_call_id
 * (a hard API requirement), so `results` stays one entry per INPUT
 * call, but each entry now also carries a `files` list (one outcome
 * per file within that call) so the caller can still log one row per
 * file for change-visibility UI, same as before this existed.
 */

export interface RawWriteFileCall {
  id: string;
  argumentsJson: string;
}

export interface WriteFileFileOutcome {
  path: string;
  /** True if this specific file actually won the dedup and was persisted; false means it was superseded by a later write to the same path in this same step - NOT an error, the model's intent was still honored, just by a different call. */
  written: boolean;
}

export interface WriteFileCallResult {
  id: string;
  /** False only for a structurally invalid call (malformed JSON, or failed validation) - a call whose files were all superseded is still `ok: true` (well-formed, correctly processed, just not the final write for those paths). */
  ok: boolean;
  /** The one provider-facing tool-result message for this call's tool_call_id. */
  message: string;
  /** One entry per file this call described (in the order given) - empty only when the whole call was malformed JSON or failed structural validation before any file could be identified. */
  files: WriteFileFileOutcome[];
}

export interface ProcessedWriteFileBatch {
  /** Deduplicated, validated files to actually persist - safe to hand straight to batchWriteSessionFiles. */
  toWrite: Array<{ path: string; content: string }>;
  /** One result per input call, same order as the input array. */
  results: WriteFileCallResult[];
}

export function processWriteFileBatch(calls: RawWriteFileCall[]): ProcessedWriteFileBatch {
  type CallOutcome =
    | { kind: "malformed_json" }
    | { kind: "invalid"; field: string; message: string }
    | { kind: "files"; files: Array<{ path: string; content: string }> };

  const callOutcomes: CallOutcome[] = new Array(calls.length);

  calls.forEach((call, i) => {
    let parsedArgs: unknown;
    try {
      parsedArgs = JSON.parse(call.argumentsJson || "{}");
    } catch {
      callOutcomes[i] = { kind: "malformed_json" };
      return;
    }

    const validation = validateWriteFileCallArgs(parsedArgs);
    if (!validation.ok) {
      callOutcomes[i] = { kind: "invalid", field: validation.field, message: validation.message };
      return;
    }

    callOutcomes[i] = { kind: "files", files: validation.files };
  });

  // Duplicate paths across the WHOLE step (not just within one call):
  // the LAST write anywhere in this step wins (preserves "the final
  // intended write," per the required behavior) - made explicit and
  // reported rather than left to Firestore's own silent last-write-wins
  // ordering. Flattened candidates carry back-references so we can
  // reconstruct per-call, per-file outcomes afterward.
  type Candidate = { callIndex: number; fileIndex: number; path: string; content: string };
  const candidates: Candidate[] = [];
  callOutcomes.forEach((outcome, callIndex) => {
    if (outcome.kind !== "files") return;
    outcome.files.forEach((f, fileIndex) => candidates.push({ callIndex, fileIndex, path: f.path, content: f.content }));
  });

  const lastIndexForPath = new Map<string, number>(); // path -> index into `candidates`
  candidates.forEach((c, idx) => lastIndexForPath.set(c.path, idx));

  const toWrite = new Map<string, string>();
  // path -> "written" | "duplicate", keyed per (callIndex, fileIndex) for exact reconstruction.
  const fileStatus = new Map<string, "written" | "duplicate">();
  candidates.forEach((c, idx) => {
    const key = `${c.callIndex}:${c.fileIndex}`;
    if (lastIndexForPath.get(c.path) === idx) {
      fileStatus.set(key, "written");
      toWrite.set(c.path, c.content);
    } else {
      fileStatus.set(key, "duplicate");
    }
  });

  const results: WriteFileCallResult[] = calls.map((call, callIndex) => {
    const outcome = callOutcomes[callIndex];

    if (outcome.kind === "malformed_json") {
      return {
        id: call.id,
        ok: false,
        message: "This write_file call's arguments were incomplete (likely cut off by a response-length limit) - retry it as its own call.",
        files: [],
      };
    }
    if (outcome.kind === "invalid") {
      return {
        id: call.id,
        ok: false,
        message: `INVALID_TOOL_ARGUMENTS (${outcome.field}): ${outcome.message}`,
        files: [],
      };
    }

    const files: WriteFileFileOutcome[] = outcome.files.map((f, fileIndex) => ({
      path: f.path,
      written: fileStatus.get(`${callIndex}:${fileIndex}`) === "written",
    }));
    const written = files.filter((f) => f.written);
    const superseded = files.filter((f) => !f.written);

    let message: string;
    if (files.length === 1) {
      // Exact original wording for the single-file case - no behavior
      // change for the overwhelmingly common shape.
      message =
        written.length === 1
          ? `Wrote ${written[0].path}.`
          : `Superseded by a later write_file call to the same path ("${superseded[0].path}") in this same step - that call's content is what was actually persisted.`;
    } else {
      const parts: string[] = [];
      if (written.length > 0) parts.push(`Wrote ${written.length} file(s): ${written.map((f) => f.path).join(", ")}.`);
      if (superseded.length > 0) {
        parts.push(
          `${superseded.length} file(s) in this same call were superseded by a later write_file call to the same path in this same step: ${superseded.map((f) => f.path).join(", ")} - that later call's content is what was actually persisted.`
        );
      }
      message = parts.join(" ");
    }

    // Structurally valid call - superseded files are an expected,
    // non-error outcome (see WriteFileCallResult.ok's own doc comment),
    // not a reason to mark the call itself failed.
    return { id: call.id, ok: true, message, files };
  });

  return {
    toWrite: Array.from(toWrite, ([path, content]) => ({ path, content })),
    results,
  };
}
