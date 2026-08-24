"use client";

import { useEffect, useState } from "react";

import { auth } from "@/lib/firebase/client";
import { buildTeammateLabels } from "@/lib/presence/attribution";

import type { Session, SessionPresence } from "@/types/session";

/** Twice the heartbeat interval (usePresence.ts's HEARTBEAT_INTERVAL_MS) - one missed beat reads as "away," not yet "offline." listActivePresence already drops anything past PRESENCE_STALE_MS server-side, so a shown entry is never truly stale, only slower than usual. */
const AWAY_THRESHOLD_MS = 16_000;
const MAX_VISIBLE_OTHERS = 2;

type Status = "online" | "away" | "offline";

const STATUS_DOT: Record<Status, string> = {
  online: "bg-success",
  away: "bg-warning",
  offline: "bg-fg-subtle",
};
const STATUS_LABEL: Record<Status, string> = {
  online: "Online",
  away: "Away",
  offline: "Offline",
};

/**
 * Section 9 foundation, Phase 27 Part J, Phase 28 Part 3: who currently
 * has this project open - real presence (heartbeat-backed,
 * listActivePresence already filters to only-recently-heartbeated
 * entries server-side), not invented. No user-profile system exists
 * (anonymous auth only, deliberately out of scope), so identity is
 * reduced to what's actually derivable: is this me, and a stable
 * per-session "Teammate N" label from buildTeammateLabels - never a
 * raw uid, never an invented display name. "Offline" here means a
 * session member with NO active presence entry at all (not shown as a
 * dot in the collapsed row, only in the popover, since the collapsed
 * row's whole point is "who's here right now"). Subtle by design (a
 * row of dots, not a roster) - a hover popover carries anything more
 * than that.
 */
export function PresenceBar({ session, presence }: { session: Session | null; presence: SessionPresence[] }) {
  const [open, setOpen] = useState(false);
  // React's purity rule bars calling Date.now() during render (see this
  // component's own history) - `now` is real component state instead,
  // ticked on the same cadence as the underlying heartbeat so the
  // online/away distinction stays reasonably fresh without needing its
  // own precise timer.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), AWAY_THRESHOLD_MS / 4);
    return () => clearInterval(id);
  }, []);

  const memberIds = session?.memberIds ?? [];
  if (memberIds.length === 0) return null;

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

  const iAmPresent = selfUid ? latestByUid.has(selfUid) : false;
  const others = memberIds.filter((id) => id !== selfUid);
  const visibleOthers = others.filter((uid) => latestByUid.has(uid)).slice(0, MAX_VISIBLE_OTHERS);
  const overflowCount = others.filter((uid) => latestByUid.has(uid)).length - visibleOthers.length;

  if (!iAmPresent && others.every((uid) => !latestByUid.has(uid))) return null;

  return (
    <div className="relative" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-xs text-fg-subtle"
        aria-label="Who's here"
      >
        {iAmPresent && (
          <span className="flex items-center gap-1">
            <span className="h-1.5 w-1.5 rounded-full bg-success" />
            You
          </span>
        )}
        {visibleOthers.map((uid) => (
          <span key={uid} className="flex items-center gap-1">
            <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[statusFor(uid)]}`} />
            {teammateLabels.get(uid)}
          </span>
        ))}
        {overflowCount > 0 && <span className="text-fg-subtle">+{overflowCount}</span>}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-20 mt-1 w-52 rounded-lg border border-border bg-bg-overlay p-1.5 shadow-lg">
          {iAmPresent && <PresenceRow label="You" status="online" lastActiveMs={0} />}
          {others.map((uid) => {
            const p = latestByUid.get(uid);
            const status = statusFor(uid);
            return (
              <PresenceRow
                key={uid}
                label={teammateLabels.get(uid) ?? "Teammate"}
                status={status}
                lastActiveMs={p ? now - p.heartbeatAt : null}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function PresenceRow({ label, status, lastActiveMs }: { label: string; status: Status; lastActiveMs: number | null }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded px-1.5 py-1 text-xs">
      <span className="flex items-center gap-1.5 text-fg">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[status]}`} />
        {label}
      </span>
      <span className="text-fg-subtle">{lastActiveMs === null ? STATUS_LABEL[status] : formatLastActive(lastActiveMs)}</span>
    </div>
  );
}

function formatLastActive(ms: number): string {
  if (ms < 5_000) return "Active now";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  return `${minutes}m ago`;
}
