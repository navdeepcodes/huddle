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
/**
 * Phase 40 §5: whether a command has reached a state the waiting caller
 * should stop waiting on. Extracted so the realtime listener and the
 * timeout reconciliation apply the IDENTICAL rule - previously the
 * listener owned this logic privately, so a reconciliation path had no
 * way to agree with it.
 *
 * "started" ends the wait only for a background command: the caller
 * doesn't want to block on a dev server's whole lifetime, but a
 * foreground command or a capture must wait for a real terminal state.
 */
export function isTerminalForCaller(data: RuntimeCommand): boolean {
  const isBackgroundRunCommand =
    data.kind === "run_command" && (data.payload as RunCommandPayload).background === true;

  return (
    data.status === "done" ||
    data.status === "error" ||
    (data.status === "started" && isBackgroundRunCommand)
  );
}

/**
 * Phase 40 §5: the fix for a real, asymmetric gap. The CLIENT half of
 * this bridge already reconciles missed snapshots (pollForMissedCommands,
 * added after Firestore was observed silently dropping the snapshot for a
 * freshly-created doc). The SERVER half had no counterpart - it trusted
 * onSnapshot plus a timeout, and on timeout resolved a synthetic in-memory
 * error WITHOUT writing anything back. That left the doc `pending`
 * forever, which meant the client's own 5s reconcile poll would later pick
 * it up and execute a command the server had already abandoned and
 * reported as failed. Orphaned execution was a designed-in outcome.
 *
 * On timeout this now does one transactional read-and-decide:
 *   - already terminal -> return the REAL result (the snapshot was simply
 *     missed; nothing was actually lost, and no spurious failure is
 *     reported to the agent)
 *   - still pending -> write a terminal `error` status, which removes it
 *     from the client's `status == "pending"` query and therefore makes
 *     later orphan execution impossible
 *
 * Deliberately a single transaction rather than another listener or retry
 * loop - one command, one lifecycle, one terminal state.
 */
async function reconcileOnTimeout(
  ref: FirebaseFirestore.DocumentReference,
  fallback: RuntimeCommand,
  timeoutMs: number
): Promise<RuntimeCommand> {
  const abandonedMessage = `Timed out waiting ${timeoutMs / 1000}s for the runtime to respond. The workspace may not be open in any browser tab.`;

  try {
    return await adminDb.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.data() as RuntimeCommand | undefined;

      if (data && isTerminalForCaller(data)) return data;

      const abandoned: RuntimeCommand = {
        ...(data ?? fallback),
        status: "error",
        errorMessage: abandonedMessage,
        completedAt: Date.now(),
      };
      tx.set(ref, abandoned);
      return abandoned;
    });
  } catch {
    // A failed reconciliation must never be worse than the old
    // behavior: still report the timeout to the caller rather than
    // hanging. The doc may remain pending in this rare case, exactly as
    // it always did before.
    return { ...fallback, status: "error", errorMessage: abandonedMessage, completedAt: Date.now() };
  }
}

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
      // Phase 40 §5: reconcile before reporting failure - the snapshot
      // may simply have been missed, in which case the real result is
      // returned instead of a spurious timeout.
      void reconcileOnTimeout(ref, command, timeoutMs).then(resolve);
    }, timeoutMs);

    const unsubscribe = ref.onSnapshot((snap) => {
      const data = snap.data() as RuntimeCommand | undefined;
      if (!data) return;
      if (!isTerminalForCaller(data) || settled) return;

      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(data);
    });
  });
}
