import type { TurnMessage, TurnTerminationReason } from "@/types/session";

/**
 * Phase 31: nemotron.ts's own doc comment documents the tag but not its
 * exact shape ("a display-layer concern that hasn't been scoped") - live
 * evidence from this phase's own browser verification settled it: the
 * reasoning is everything BEFORE the tag, the real answer is everything
 * AFTER it ("...the app is complete and functional.</think>The minimal
 * personal blog homepage is complete and verified. Here's what was
 * built:..."), not a tag trailing the real content as first assumed.
 * Splitting on the LAST occurrence (not the first) matters too - the
 * reasoning text itself can legitimately contain the literal substring
 * "think" elsewhere, but the model only ever emits the one true
 * terminator. Purely cosmetic: the raw logged message is untouched.
 */
function stripThinkPrefix(content: string | null): string {
  if (!content) return "";
  const idx = content.lastIndexOf("</think>");
  return (idx === -1 ? content : content.slice(idx + "</think>".length)).trim();
}

/**
 * Section 2's requested categories, minus a literal "creating
 * components" (files already carries that - a written path under
 * components/ reads as itself in the UI's detail list without a
 * separate taxonomy). "reading" covers read_file/list_files - the
 * agent's own low-level orientation, kept as its own quiet kind so it
 * can be visually de-emphasized rather than dumped inline with real
 * writes/commands.
 */
export type ActivityKind =
  | "planning"
  | "files"
  | "running_command"
  | "inspecting_preview"
  | "reading"
  | "fixing_error"
  | "completed";

export interface ActivityEntry {
  kind: ActivityKind;
  summary: string;
  /** Individual items folded into this entry (file paths, commands) - what merging consecutive same-kind log entries collapsed. */
  detail: string[];
  ok: boolean;
  at: number;
}

function summarize(kind: ActivityKind, items: string[]): string {
  const n = items.length;
  switch (kind) {
    case "files":
      return n === 1 ? `Wrote ${items[0]}` : `Wrote ${n} files`;
    case "running_command":
      return n === 1 ? `Ran \`${items[0]}\`` : `Ran ${n} commands`;
    case "reading":
      return n === 1 ? `Reviewed ${items[0]}` : `Reviewed ${n} files`;
    case "inspecting_preview":
      return "Checked the live preview";
    case "planning":
      return "Updated the plan";
    case "fixing_error":
      return n === 1 ? `Hit an error: ${items[0]}` : `Hit ${n} errors while working`;
    case "completed":
      return items[0] ?? "Finished";
  }
}

/** Consecutive same-kind entries merge into one, per section 2's "group repetitive low-level operations" - a run of 5 write_file calls in one iteration reads as one "Wrote 5 files" entry, not five. */
function appendOrMerge(entries: ActivityEntry[], kind: ActivityKind, item: string, ok: boolean, at: number): void {
  const last = entries[entries.length - 1];
  if (last && last.kind === kind && last.ok === ok) {
    last.detail.push(item);
    last.summary = summarize(kind, last.detail);
    return;
  }
  entries.push({ kind, summary: summarize(kind, [item]), detail: [item], ok, at });
}

const TERMINATION_LABEL: Partial<Record<NonNullable<TurnTerminationReason>, string>> = {
  done: "Completed",
  blocked: "Stopped - some work is blocked",
  cancelled: "Cancelled",
  provider_error: "Stopped - a provider error occurred",
  truncated_no_action: "Stopped - ran out of response budget",
  internal_error: "Stopped - an internal error occurred",
  step_budget_exhausted: "Stopped - ran out of iteration budget",
};

export function buildActivityFeed(
  log: TurnMessage[],
  turn?: { active: boolean; terminationReason: TurnTerminationReason }
): ActivityEntry[] {
  const entries: ActivityEntry[] = [];

  for (const msg of log) {
    if (msg.role !== "tool") continue;
    const ok = msg.ok ?? true;

    switch (msg.toolName) {
      case "update_progress":
        entries.push({ kind: "planning", summary: summarize("planning", []), detail: [msg.content ?? ""], ok, at: msg.createdAt });
        break;
      case "write_file":
        appendOrMerge(entries, ok ? "files" : "fixing_error", msg.path ?? msg.content ?? "a file", ok, msg.createdAt);
        break;
      case "delete_file":
      case "create_directory":
        appendOrMerge(entries, ok ? "files" : "fixing_error", msg.argsSummary ?? msg.toolName, ok, msg.createdAt);
        break;
      case "read_file":
      case "list_files":
        appendOrMerge(entries, ok ? "reading" : "fixing_error", msg.argsSummary ?? msg.toolName, ok, msg.createdAt);
        break;
      case "run_command":
        appendOrMerge(entries, ok ? "running_command" : "fixing_error", msg.argsSummary ?? "a command", ok, msg.createdAt);
        break;
      case "view_preview":
        entries.push({
          kind: ok ? "inspecting_preview" : "fixing_error",
          summary: ok ? summarize("inspecting_preview", []) : `Preview check failed: ${msg.content ?? ""}`,
          detail: [],
          ok,
          at: msg.createdAt,
        });
        break;
      default:
        break;
    }
  }

  if (turn && !turn.active && entries.length > 0) {
    const label = turn.terminationReason ? TERMINATION_LABEL[turn.terminationReason] : undefined;
    entries.push({
      kind: "completed",
      summary: label ?? "Finished",
      detail: [],
      ok: turn.terminationReason !== "internal_error" && turn.terminationReason !== "provider_error",
      at: Date.now(),
    });
  }

  return entries;
}

export type UnifiedFeedItem =
  | { type: "activity"; entry: ActivityEntry }
  | { type: "message"; role: "user" | "assistant"; content: string; uid?: string; at: number };

/**
 * Phase 31: activity and chat used to be two independently-filtered
 * views over the same turn.log (buildActivityFeed keeps tool entries
 * only, ChatPanel kept user/assistant prose only) - stacked as two
 * separate panels, which read as two disconnected surfaces for one
 * teammate. This walks the log ONCE and keeps everything in its real
 * chronological position, so "wrote 3 files" and the sentence that
 * prompted it sit next to each other exactly as they happened, the
 * same shape Cursor/Copilot Chat use for interleaving tool activity
 * with conversation. Consecutive same-kind tool entries still merge
 * (appendToUnified below) - but a chat message in between now correctly
 * breaks that merge, which is more accurate than buildActivityFeed's
 * tool-only pass could ever be (a user interjecting mid-batch no longer
 * gets silently absorbed into "wrote 6 files" as if it interrupted
 * nothing).
 */
export function buildUnifiedFeed(
  log: TurnMessage[],
  turn?: { active: boolean; terminationReason: TurnTerminationReason }
): UnifiedFeedItem[] {
  const items: UnifiedFeedItem[] = [];

  function pushActivity(kind: ActivityKind, item: string, ok: boolean, at: number): void {
    const last = items[items.length - 1];
    if (last?.type === "activity" && last.entry.kind === kind && last.entry.ok === ok) {
      last.entry.detail.push(item);
      last.entry.summary = summarize(kind, last.entry.detail);
      return;
    }
    items.push({ type: "activity", entry: { kind, summary: summarize(kind, [item]), detail: [item], ok, at } });
  }

  for (const msg of log) {
    if (msg.role === "user") {
      if (!msg.isNudge) items.push({ type: "message", role: "user", content: msg.content ?? "", uid: msg.uid, at: msg.createdAt });
      continue;
    }
    if (msg.role === "assistant") {
      const content = stripThinkPrefix(msg.content);
      if (content) items.push({ type: "message", role: "assistant", content, at: msg.createdAt });
      continue;
    }

    const ok = msg.ok ?? true;
    switch (msg.toolName) {
      case "update_progress":
        items.push({
          type: "activity",
          entry: { kind: "planning", summary: summarize("planning", []), detail: [msg.content ?? ""], ok, at: msg.createdAt },
        });
        break;
      case "write_file":
        pushActivity(ok ? "files" : "fixing_error", msg.path ?? msg.content ?? "a file", ok, msg.createdAt);
        break;
      case "delete_file":
      case "create_directory":
        pushActivity(ok ? "files" : "fixing_error", msg.argsSummary ?? msg.toolName, ok, msg.createdAt);
        break;
      case "read_file":
      case "list_files":
        pushActivity(ok ? "reading" : "fixing_error", msg.argsSummary ?? msg.toolName, ok, msg.createdAt);
        break;
      case "run_command":
        pushActivity(ok ? "running_command" : "fixing_error", msg.argsSummary ?? "a command", ok, msg.createdAt);
        break;
      case "view_preview":
        items.push({
          type: "activity",
          entry: {
            kind: ok ? "inspecting_preview" : "fixing_error",
            summary: ok ? summarize("inspecting_preview", []) : `Preview check failed: ${msg.content ?? ""}`,
            detail: [],
            ok,
            at: msg.createdAt,
          },
        });
        break;
      default:
        break;
    }
  }

  if (turn && !turn.active && items.some((i) => i.type === "activity")) {
    const label = turn.terminationReason ? TERMINATION_LABEL[turn.terminationReason] : undefined;
    items.push({
      type: "activity",
      entry: {
        kind: "completed",
        summary: label ?? "Finished",
        detail: [],
        ok: turn.terminationReason !== "internal_error" && turn.terminationReason !== "provider_error",
        at: Date.now(),
      },
    });
  }

  return items;
}
