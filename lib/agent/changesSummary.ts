import type { TurnMessage } from "@/types/session";

export interface FileChange {
  path: string;
  status: "added" | "modified";
}

/**
 * "This turn" = every log entry after the last real (non-nudge) user
 * message - `log` accumulates across the whole session (see loop.ts),
 * so a turn boundary has to be found, not assumed. `checkpointPaths` is
 * the file set as it stood right before this turn began (the
 * checkpoint loop.ts takes at turn start) - a written path already in
 * that set is a real edit ("~"), one that wasn't is a new file ("+").
 * Passing null (checkpoint not loaded yet) falls back to marking
 * everything "added" rather than guessing "modified".
 */
export function computeCurrentTurnChanges(
  log: TurnMessage[],
  checkpointPaths: Set<string> | null
): FileChange[] {
  let boundary = -1;
  log.forEach((m, i) => {
    if (m.role === "user" && !m.isNudge) boundary = i;
  });
  const currentTurnEntries = boundary >= 0 ? log.slice(boundary) : log;

  const changes = new Map<string, FileChange>();
  for (const m of currentTurnEntries) {
    if (m.role === "tool" && m.toolName === "write_file" && m.ok && m.path) {
      const status: FileChange["status"] = checkpointPaths?.has(m.path) ? "modified" : "added";
      changes.set(m.path, { path: m.path, status });
    }
  }

  return Array.from(changes.values()).sort((a, b) => a.path.localeCompare(b.path));
}
