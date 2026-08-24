"use client";

import { useEffect, useRef, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";

import { db, subscribeWhenSignedIn } from "@/lib/firebase/client";
import { authedFetch } from "@/lib/firebase/authedFetch";
import { RuntimeSession } from "@/lib/runtime/runtimeSession";

import type { RuntimeHost } from "@/types/session";

const HEARTBEAT_INTERVAL_MS = 8_000;

/**
 * This is the tab that claims and drives the WebContainer (see the
 * approved architecture's "one host per session" invariant). Claim +
 * boot start concurrently with the sessionFiles subscription inside
 * RuntimeSession.start() - see that file's own doc comment for the
 * parallel-boot mechanism. Every other open tab for the same session
 * reads the runtimeHost doc below and shows the same state read-only -
 * it DOES periodically retry the claim itself (Phase 27, see run()'s
 * own doc comment), but only ever succeeds once the current owner's
 * heartbeat has actually gone stale, so in practice this never results
 * in two tabs both driving a live WebContainer at once.
 *
 * Root cause fix #1 (2026-08-19): this effect used to guard against
 * re-running with a `useRef(false)` "started" flag that persists
 * across React's effect lifecycle. Confirmed live that this guard,
 * combined with React Strict Mode's dev-mode mount -> cleanup ->
 * remount double-invoke, PERMANENTLY broke every session: the first
 * invocation's `run()` got its own `stopped` flag flipped true by its
 * own synthetic cleanup before its first `await` resolved, and the
 * second, surviving invocation saw the ref already `true` and never
 * even tried. Fixed by letting the effect run in full on every real
 * invocation, relying on the cleanup-scoped `stopped` flag (checked
 * after every await below) to make an abandoned invocation's
 * continuation a safe no-op.
 *
 * Root cause fix #2 (2026-08-20): fix #1 uncovered a second, distinct
 * bug in the SAME double-invoke sequence. `tabId` used to be minted
 * fresh (`crypto.randomUUID()`) inside the effect body, so Strict
 * Mode's two invocations got two DIFFERENT, unrelated ids - even
 * though they represent the exact same logical browser tab. Confirmed
 * live (2/2 trials): invocation A's claim (issued first) reliably wins
 * the server-side race and commits before A's own `stopped` flag (set
 * by its synthetic cleanup) causes it to abandon without ever calling
 * session.start(); invocation B then gets a genuine 409 (different
 * tabId, A's heartbeat still fresh) and abandons too - so NEITHER
 * invocation ever calls WebContainer.boot(). The server's ownership
 * semantics were never the problem (claimRuntimeHost already has a
 * tested, correct "same tabId reclaims instantly" path - see
 * tests/runtimeHostAdmin.test.ts); the client just never gave it a
 * stable enough identity to use that path. `tabId` now lives in a
 * `useRef`, which - unlike a value created inside the effect body - is
 * tied to the component INSTANCE, not the invocation, so it survives
 * Strict Mode's synthetic double-invoke unchanged. Both invocations
 * now claim with the SAME id: A's claim (or B's, whichever commits
 * first) succeeds, the other's claim ALSO succeeds via the same-tab
 * path (never a 409), and exactly one of them - the one whose own
 * `stopped` is still false - proceeds to call session.start(). A
 * genuinely different browser tab still gets a fresh, distinct ref and
 * is still correctly rejected while this tab's heartbeat is alive.
 */
export function useRuntimeHost(sessionId: string): RuntimeHost | null {
  const [host, setHost] = useState<RuntimeHost | null>(null);
  const tabIdRef = useRef<string | null>(null);
  if (tabIdRef.current === null) tabIdRef.current = crypto.randomUUID();

  useEffect(() => {
    return subscribeWhenSignedIn(() =>
      onSnapshot(doc(db, "runtimeHost", sessionId), (snap) => {
        setHost(snap.exists() ? (snap.data() as RuntimeHost) : null);
      })
    );
  }, [sessionId]);

  useEffect(() => {
    const tabId = tabIdRef.current as string;
    let session: RuntimeSession | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let stopped = false;

    async function report(
      state: RuntimeHost["state"],
      extra?: {
        port?: number | null;
        previewUrl?: string | null;
        errorMessage?: string | null;
        startupTelemetry?: RuntimeHost["startupTelemetry"];
      }
    ) {
      await authedFetch(`/api/sessions/${sessionId}/runtime-host/report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tabId, state, ...extra }),
      });
    }

    const callbacks = {
      onStateChange: (state: RuntimeHost["state"], extra?: Parameters<typeof report>[1]) => {
        void report(state, extra);
      },
      onPreviewUrl: (url: string) => {
        void report("running", { previewUrl: url });
      },
    };

    /**
     * Phase 27 Part F/K: the original version attempted claim exactly
     * once and gave up forever on failure - a real, audit-found gap.
     * "USER B must NOT lose the project merely because A's browser tab
     * disappeared" requires SOME tab to eventually pick up ownership
     * automatically once A's heartbeat goes stale
     * (RUNTIME_HOST_STALE_MS, runtimeHostAdmin.ts), not only on a
     * manual reload. Retries at the same cadence as the heartbeat
     * itself - cheap (one Admin-SDK read, occasionally a write), and a
     * retry can only ever succeed once the current owner's heartbeat
     * has actually gone stale, so polling faster would just waste
     * calls without changing the outcome. Bounded by `stopped`, same
     * discipline as everything else in this effect - never retries
     * after unmount.
     */
    async function run() {
      while (!stopped) {
        const claimRes = await authedFetch(`/api/sessions/${sessionId}/runtime-host/claim`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tabId }),
        });

        if (stopped) return;

        if (claimRes.ok) {
          heartbeat = setInterval(() => {
            void authedFetch(`/api/sessions/${sessionId}/runtime-host/heartbeat`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ tabId }),
            });
          }, HEARTBEAT_INTERVAL_MS);

          session = new RuntimeSession();
          await session.start(sessionId, callbacks);
          return;
        }

        // Someone else currently owns it - wait and try again later,
        // rather than giving up for the rest of this tab's lifetime.
        await new Promise((resolve) => setTimeout(resolve, HEARTBEAT_INTERVAL_MS));
      }
    }

    /**
     * Phase 22: on regaining visibility, re-establish the Firestore
     * listeners and heartbeat immediately rather than waiting for the
     * next 8s tick - see RuntimeSession.reconnectListeners's own doc
     * comment for the live-reproduced failure this recovers from.
     * Registered unconditionally (not gated on `session` being set
     * yet) so a tab that regains visibility mid-boot still tries once
     * `session` exists; harmless no-op otherwise.
     */
    function handleVisibilityChange() {
      if (document.visibilityState !== "visible" || stopped) return;
      // Logging lives inside reconnectListeners itself (one canonical
      // spot for every trigger source, not one per caller).
      session?.reconnectListeners(sessionId, callbacks, "visibilitychange");
      void authedFetch(`/api/sessions/${sessionId}/runtime-host/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tabId }),
      });
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);

    void run();

    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (heartbeat) clearInterval(heartbeat);
      session?.stop();
    };
  }, [sessionId]);

  return host;
}
