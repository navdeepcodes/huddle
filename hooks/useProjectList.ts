"use client";

import { useEffect, useState } from "react";

import { authedFetch } from "@/lib/firebase/authedFetch";

import type { Session } from "@/types/session";

/**
 * Phase 32: extracted from app/page.tsx (the desktop dashboard) so the
 * mobile Home screen shares the exact same fetch/create/archive logic
 * instead of a second implementation - same reasoning as
 * useHuddleComposer.ts for the conversation side. `projects` is `null`
 * while loading (distinct from a genuinely empty `[]`), matching the
 * existing FileExplorer/useSessionFiles convention for telling
 * "hasn't loaded yet" apart from "genuinely empty" so the caller can
 * show a real loading state instead of a false-empty flash.
 */
export function useProjectList() {
  const [projects, setProjects] = useState<Session[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    authedFetch("/api/sessions")
      .then((res) => (res.ok ? res.json() : { sessions: [] }))
      .then(({ sessions }) => {
        if (!cancelled) setProjects(sessions);
      })
      .catch(() => {
        if (!cancelled) setProjects([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function createProject(message: string): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
    const res = await authedFetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, error: body.error ?? "Couldn't start the session." };
    }
    const session = await res.json();
    return { ok: true, id: session.id };
  }

  async function archiveProject(id: string): Promise<boolean> {
    const res = await authedFetch(`/api/sessions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: true }),
    });
    if (res.ok) setProjects((prev) => prev?.filter((p) => p.id !== id) ?? prev);
    return res.ok;
  }

  return { projects, createProject, archiveProject };
}
