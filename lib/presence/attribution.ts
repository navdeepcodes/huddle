/**
 * Phase 28 Part 3: the single place "who did this" gets turned into a
 * label - reused by PresenceBar, ActivityFeed, and ChatPanel so "You"/
 * "Teammate"/"Huddle" mean the same thing everywhere instead of three
 * separate ad-hoc computations that could drift (e.g. numbering a
 * teammate differently in the presence bar vs. the activity feed). No
 * profile system - anonymous auth has no display name to show, so
 * numbering is derived purely from a session's own memberIds order
 * (stable: it only ever grows via arrayUnion as people join), never
 * from presence (which can reorder as people go on/offline) and never
 * a raw uid (never shown in the UI).
 */
export function buildTeammateLabels(memberIds: string[], selfUid: string | null | undefined): Map<string, string> {
  const others = memberIds.filter((id) => id !== selfUid);
  const labels = new Map<string, string>();
  others.forEach((uid, i) => {
    labels.set(uid, others.length > 1 ? `Teammate ${i + 1}` : "Teammate");
  });
  return labels;
}

/** `uid` absent/null means the agent, not a human - matches TurnMessage.uid/SessionFile.updatedByUid both being optional for exactly that reason. */
export function labelForUid(
  uid: string | null | undefined,
  selfUid: string | null | undefined,
  teammateLabels: ReadonlyMap<string, string>
): string {
  if (!uid) return "Huddle";
  if (uid === selfUid) return "You";
  return teammateLabels.get(uid) ?? "Teammate";
}
