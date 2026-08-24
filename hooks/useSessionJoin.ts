"use client";

import { useEffect, useState } from "react";

import { authedFetch } from "@/lib/firebase/authedFetch";

export type SessionJoinStatus = "joining" | "joined" | "not_found" | "error";

/**
 * Phase 27 Part A: MUST resolve before any session-scoped Firestore
 * listener attaches (useSessionDoc/useSessionFiles/useAgentTurn/
 * useRuntimeHost all read collections gated on memberIds - see
 * joinSession.ts's own doc comment). Both this call and those onSnapshot
 * subscriptions wait on the same ensureSignedIn() promise, but a
 * Firestore listener attach is a synchronous local SDK call while this
 * needs a real HTTP round trip - without an explicit gate, the
 * listeners would race ahead and get a permission-denied error (which
 * Firestore's SDK does not auto-retry) before membership exists. The
 * fix is structural (mount the workspace only once this resolves), not
 * a raw try/catch. See app/session/[sessionId]/page.tsx's call site.
 */
export function useSessionJoin(sessionId: string): SessionJoinStatus {
  const [status, setStatus] = useState<SessionJoinStatus>("joining");

  useEffect(() => {
    let cancelled = false;

    authedFetch(`/api/sessions/${sessionId}/join`, { method: "POST" })
      .then((res) => {
        if (cancelled) return;
        if (res.status === 404) return setStatus("not_found");
        if (!res.ok) return setStatus("error");
        setStatus("joined");
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  return status;
}
