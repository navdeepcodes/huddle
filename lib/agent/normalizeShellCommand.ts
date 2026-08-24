/**
 * Two mechanical, evidence-backed time-wastes observed live, repeatedly,
 * across every benchmark run: the sandboxed shell (jsh) has no `sleep`,
 * and its `head`/`tail` don't accept the old BSD-style `-N` shorthand
 * (only `-n N`). Both failures cost a full model round-trip for zero
 * information - the model tries the command, gets exit 127 / "No such
 * file or directory", and has to re-strategize. Neither needs the
 * model's own judgment to fix: `sleep` is never actually needed
 * anymore (run_command/view_preview already wait for real readiness -
 * see Phase 17), and the head/tail flag is a pure syntax normalization,
 * not a semantic change.
 */

export interface NormalizedCommand {
  command: string;
  /** Set when the command should be answered immediately without ever reaching the shell. */
  shortCircuitMessage?: string;
}

const BARE_SLEEP_RE = /^\s*sleep\s+\d+(\.\d+)?\s*;?\s*$/;
const OLD_STYLE_HEAD_TAIL_RE = /\b(head|tail)\s+-(\d+)\b/g;

export function normalizeShellCommand(command: string): NormalizedCommand {
  if (BARE_SLEEP_RE.test(command)) {
    return {
      command,
      shortCircuitMessage:
        "Skipped - this shell has no sleep, and you don't need one: run_command(background) and view_preview already wait for real readiness on their own before responding.",
    };
  }

  return { command: command.replace(OLD_STYLE_HEAD_TAIL_RE, (_m, cmd, n) => `${cmd} -n ${n}`) };
}
