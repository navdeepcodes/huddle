import "server-only";

import { adminDb } from "@/lib/firebase/admin";

import type {
  CapturePreviewPayload,
  RunCommandPayload,
  RuntimeCommand,
  RuntimeCommandKind,
} from "@/types/session";

/**
 * The server-side half of the runtime bridge: the agent loop runs on
 * the server, but the WebContainer only exists in the host browser
 * tab's memory. A run_command/capture_preview request is written here
 * as a pending doc; the host tab (subscribed client-side, see
 * lib/runtime/runtimeSession.ts) picks it up, executes it locally
 * against its own WebContainer instance, and reports the result
 * through POST /api/sessions/[id]/runtime-commands/[commandId]/complete.
 *
 * Chosen over a dedicated WebSocket bridge server for v1: this reuses
 * Firestore (already the coordination layer for everything else)
 * instead of standing up a new server process - matches "simple,
 * atomic/batched persistence is sufficient for v1," applied to command
 * dispatch instead of file writes. If per-command latency ever proves
 * to be the actual bottleneck, that's a real, measured reason to
 * revisit it - not a guess made now.
 */
export async function dispatchRuntimeCommand(
  sessionId: string,
  kind: RuntimeCommandKind,
  payload: RunCommandPayload | CapturePreviewPayload,
  timeoutMs: number
): Promise<RuntimeCommand> {
  const ref = adminDb.collection("runtimeCommands").doc();
  const command: RuntimeCommand = {
    id: ref.id,
    sessionId,
    kind,
    // Firestore rejects an explicit `undefined` field value outright
    // (confirmed live: a tool call omitting `cwd`/`viewport` crashed the
    // whole turn here, reported misleadingly as "step_budget_exhausted"
    // since the throw happened outside the loop's own try/catch) -
    // round-tripping through JSON drops undefined keys the same way an
    // omitted-key payload would, without the caller needing to build a
    // conditional spread for every optional field.
    payload: JSON.parse(JSON.stringify(payload)),
    status: "pending",
    createdAt: Date.now(),
    completedAt: null,
  };
  await ref.set(command);

  return new Promise<RuntimeCommand>((resolve) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      unsubscribe();
      resolve({
        ...command,
        status: "error",
        errorMessage: `Timed out waiting ${timeoutMs / 1000}s for the runtime to respond. The workspace may not be open in any browser tab.`,
        completedAt: Date.now(),
      });
    }, timeoutMs);

    const unsubscribe = ref.onSnapshot((snap) => {
      const data = snap.data() as RuntimeCommand | undefined;
      if (!data) return;

      // "started" only ends the wait for a background command (the
      // caller doesn't want to block on a dev server's whole lifetime)
      // - foreground commands and captures wait for a real terminal
      // state.
      const isBackgroundRunCommand =
        data.kind === "run_command" &&
        (data.payload as RunCommandPayload).background === true;

      const terminal =
        data.status === "done" ||
        data.status === "error" ||
        (data.status === "started" && isBackgroundRunCommand);

      if (!terminal || settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(data);
    });
  });
}
