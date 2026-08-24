import { validateWriteFileArgs } from "@/lib/agent/validateWriteFile";

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
 */

export interface RawWriteFileCall {
  id: string;
  argumentsJson: string;
}

export interface WriteFileCallResult {
  id: string;
  ok: boolean;
  message: string;
}

export interface ProcessedWriteFileBatch {
  /** Deduplicated, validated files to actually persist - safe to hand straight to batchWriteSessionFiles. */
  toWrite: Array<{ path: string; content: string }>;
  /** One result per input call, same order as the input array. */
  results: WriteFileCallResult[];
}

export function processWriteFileBatch(calls: RawWriteFileCall[]): ProcessedWriteFileBatch {
  type Outcome =
    | { kind: "malformed_json" }
    | { kind: "invalid"; field: string; message: string }
    | { kind: "duplicate"; path: string }
    | { kind: "written"; path: string };

  const outcomes: Outcome[] = new Array(calls.length);
  const candidates: Array<{ index: number; path: string; content: string }> = [];

  calls.forEach((call, i) => {
    let parsedArgs: unknown;
    try {
      parsedArgs = JSON.parse(call.argumentsJson || "{}");
    } catch {
      outcomes[i] = { kind: "malformed_json" };
      return;
    }

    const validation = validateWriteFileArgs(parsedArgs);
    if (!validation.ok) {
      outcomes[i] = { kind: "invalid", field: validation.field, message: validation.message };
      return;
    }

    candidates.push({ index: i, path: validation.value.path, content: validation.value.content });
  });

  // Duplicate paths within one batch: the LAST call for a given path
  // wins (preserves "the final intended write," per the required
  // behavior) - made explicit and reported rather than left to
  // Firestore's own silent last-write-wins ordering.
  const lastIndexForPath = new Map<string, number>();
  for (const c of candidates) lastIndexForPath.set(c.path, c.index);

  const toWrite = new Map<string, string>();
  for (const c of candidates) {
    if (lastIndexForPath.get(c.path) === c.index) {
      outcomes[c.index] = { kind: "written", path: c.path };
      toWrite.set(c.path, c.content);
    } else {
      outcomes[c.index] = { kind: "duplicate", path: c.path };
    }
  }

  const results: WriteFileCallResult[] = calls.map((call, i) => {
    const outcome = outcomes[i];
    switch (outcome.kind) {
      case "written":
        return { id: call.id, ok: true, message: `Wrote ${outcome.path}.` };
      case "duplicate":
        return {
          id: call.id,
          ok: true,
          message: `Superseded by a later write_file call to the same path ("${outcome.path}") in this same step - that call's content is what was actually persisted.`,
        };
      case "invalid":
        return {
          id: call.id,
          ok: false,
          message: `INVALID_TOOL_ARGUMENTS (${outcome.field}): ${outcome.message}`,
        };
      case "malformed_json":
        return {
          id: call.id,
          ok: false,
          message:
            "This write_file call's arguments were incomplete (likely cut off by a response-length limit) - retry it as its own call.",
        };
    }
  });

  return {
    toWrite: Array.from(toWrite, ([path, content]) => ({ path, content })),
    results,
  };
}
