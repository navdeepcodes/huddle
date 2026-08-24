import { buildActivityFeed, type ActivityKind } from "@/lib/agent/activityFeed";

import type { AgentTurn } from "@/types/session";

/**
 * Phase 30: the ONE place "what is Huddle doing right now" gets turned
 * into a premium, user-safe status - reused by WorkspaceHeader,
 * ChatPanel's compact indicator, and the activity timeline's live row,
 * so they can never drift into three different phrasings of the same
 * moment. Built entirely from buildActivityFeed's already-safe,
 * already-structured entries (never raw tool-call payloads, never
 * assistant `content`/reasoning text) - this file adds presentation,
 * not a new data source.
 */
export type AgentStatus = "idle" | "planning" | "writing" | "running" | "inspecting" | "fixing" | "completed" | "blocked";

export interface AgentStatusInfo {
  status: AgentStatus;
  /** Short, human-facing headline - "Huddle is building", "Huddle finished". */
  label: string;
  /** Optional second line - "Writing files · 6 files", "24 files changed". Never raw model reasoning. */
  detail: string | null;
  active: boolean;
}

const KIND_TO_STATUS: Record<ActivityKind, AgentStatus> = {
  planning: "planning",
  files: "writing",
  running_command: "running",
  inspecting_preview: "inspecting",
  reading: "planning", // low-level orientation, same bucket as planning for status purposes - activityFeed still shows it as its own row
  fixing_error: "fixing",
  completed: "completed",
};

const WORKING_LABEL: Record<AgentStatus, string> = {
  idle: "Ready",
  planning: "Huddle is planning",
  writing: "Huddle is building",
  running: "Huddle is building",
  inspecting: "Huddle is checking its work",
  fixing: "Huddle is fixing an issue",
  completed: "Huddle finished",
  blocked: "Huddle needs input",
};

export function deriveAgentStatus(turn: AgentTurn | null): AgentStatusInfo {
  if (!turn) {
    return { status: "idle", label: WORKING_LABEL.idle, detail: null, active: false };
  }

  const entries = buildActivityFeed(turn.log, { active: turn.active, terminationReason: turn.telemetry.terminationReason });
  const last = entries.at(-1);

  if (!turn.active) {
    if (!last) return { status: "idle", label: WORKING_LABEL.idle, detail: null, active: false };
    const status: AgentStatus = turn.telemetry.terminationReason === "blocked" ? "blocked" : "completed";
    return { status, label: WORKING_LABEL[status], detail: last.summary, active: false };
  }

  if (!last) {
    return { status: "planning", label: WORKING_LABEL.planning, detail: null, active: true };
  }

  const status = KIND_TO_STATUS[last.kind];
  return { status, label: WORKING_LABEL[status], detail: last.summary, active: true };
}
