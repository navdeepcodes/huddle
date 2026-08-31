/**
 * Mechanical, evidence-backed time-wastes observed live, repeatedly,
 * across every benchmark run: the sandboxed shell (jsh) has no `sleep`,
 * and its `head`/`tail` don't accept the old BSD-style `-N` shorthand
 * (only `-n N`). Both failures cost a full model round-trip for zero
 * information - the model tries the command, gets exit 127 / "No such
 * file or directory", and has to re-strategize. Neither needs the
 * model's own judgment to fix: `sleep` is never actually needed
 * anymore (run_command/view_preview already wait for real readiness -
 * see Phase 17), and the head/tail flag is a pure syntax normalization,
 * not a semantic change.
 *
 * Phase 40: same shape, new evidence (2026-08-25, the Marginalia
 * build) - after editing next.config.mjs, the agent tried `pkill -f
 * "next"` then `lsof -ti:3001 | xargs kill -9` to stop the stale dev
 * server before restarting it. jsh has neither binary - two more
 * round-trips burned on "command not found" before it gave up trying
 * to kill anything and just started a new background dev server
 * (which is, in fact, the actual correct move here - see prompt.ts's
 * "Restarting the dev server after a config change" guidance).
 * Short-circuited the same way `sleep` already was, so the model never
 * spends a call discovering this shell can't do process management at
 * all.
 */

export interface NormalizedCommand {
  command: string;
  /** Set when the command should be answered immediately without ever reaching the shell. */
  shortCircuitMessage?: string;
}

const BARE_SLEEP_RE = /^\s*sleep\s+\d+(\.\d+)?\s*;?\s*$/;
const OLD_STYLE_HEAD_TAIL_RE = /\b(head|tail)\s+-(\d+)\b/g;
const PROCESS_MANAGEMENT_RE = /\b(pkill|lsof|pgrep|killall)\b|\bkill\s+(-9\s+)?\$|\bps\s+(aux|-ef)\b/;

export function normalizeShellCommand(command: string): NormalizedCommand {
  if (BARE_SLEEP_RE.test(command)) {
    return {
      command,
      shortCircuitMessage:
        "Skipped - this shell has no sleep, and you don't need one: run_command(background) and view_preview already wait for real readiness on their own before responding.",
    };
  }

  if (PROCESS_MANAGEMENT_RE.test(command)) {
    return {
      command,
      shortCircuitMessage:
        "Skipped - this shell (jsh) has no pkill/lsof/pgrep/killall/ps, and there's no way to find or stop a running process by name or port here. You don't need to: if you're restarting the dev server after a config change, just run_command(background: true) the same \"npm run dev\" again - it picks its own free port and the runtime notices and switches to it automatically.",
    };
  }

  return { command: command.replace(OLD_STYLE_HEAD_TAIL_RE, (_m, cmd, n) => `${cmd} -n ${n}`) };
}
