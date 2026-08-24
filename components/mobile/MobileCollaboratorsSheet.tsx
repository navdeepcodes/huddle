"use client";

import { useEffect, useState } from "react";

import { auth } from "@/lib/firebase/client";
import { buildTeammateLabels } from "@/lib/presence/attribution";
import { BottomSheet } from "@/components/mobile/BottomSheet";

import type { Session, SessionPresence } from "@/types/session";

interface Props {
  open: boolean;
  onClose: () => void;
  session: Session | null;
  presence: SessionPresence[];
}

const AWAY_THRESHOLD_MS = 16_000;

type Status = "online" | "away" | "offline";

const STATUS_DOT: Record<Status, string> = { online: "bg-success", away: "bg-warning", offline: "bg-border-strong" };
const STATUS_LABEL: Record<Status, string> = { online: "Active now", away: "Away", offline: "Offline" };

/**
 * Phase 32: "lightweight multiplayer information" per the brief - the
 * same real, heartbeat-backed presence data desktop's PresenceBar
 * already computes (never invented), just laid out as touch-sized
 * sheet rows instead of a hover popover (hover has no equivalent on
 * touch). Not a recreation of the desktop collaboration workspace -
 * this is read-only "who's here," nothing more.
 */
export function MobileCollaboratorsSheet({ open, onClose, session, presence }: Props) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => setNow(Date.now()), AWAY_THRESHOLD_MS / 4);
    return () => clearInterval(id);
  }, [open]);

  const memberIds = session?.memberIds ?? [];
  const selfUid = auth.currentUser?.uid;
  const teammateLabels = buildTeammateLabels(memberIds, selfUid);

  const latestByUid = new Map<string, SessionPresence>();
  for (const p of presence) {
    const existing = latestByUid.get(p.uid);
    if (!existing || p.heartbeatAt > existing.heartbeatAt) latestByUid.set(p.uid, p);
  }

  function statusFor(uid: string): Status {
    const p = latestByUid.get(uid);
    if (!p) return "offline";
    return now - p.heartbeatAt > AWAY_THRESHOLD_MS ? "away" : "online";
  }

  return (
    <BottomSheet open={open} onClose={onClose} title="Collaborators">
      <div className="pb-2">
        {memberIds.length === 0 ? (
          <p className="px-1 py-3 text-sm text-fg-subtle">No one else has this project open.</p>
        ) : (
          memberIds.map((uid) => {
            const isSelf = uid === selfUid;
            const label = isSelf ? "You" : (teammateLabels.get(uid) ?? "Teammate");
            const status = isSelf ? "online" : statusFor(uid);
            const p = latestByUid.get(uid);
            return (
              <div key={uid} className="flex items-center justify-between gap-3 rounded-xl px-1 py-3">
                <span className="flex items-center gap-2.5 text-sm text-fg">
                  <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[status]}`} />
                  {label}
                </span>
                <span className="text-xs text-fg-subtle">{isSelf || !p ? STATUS_LABEL[status] : formatLastActive(now - p.heartbeatAt)}</span>
              </div>
            );
          })
        )}
      </div>
    </BottomSheet>
  );
}

function formatLastActive(ms: number): string {
  if (ms < 5_000) return "Active now";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  return `${minutes}m ago`;
}
