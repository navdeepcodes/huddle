import type { RuntimeHost } from "@/types/session";

/**
 * Phase 30: a pure presentation layer over the EXISTING runtime state
 * machine (RuntimeState: idle/starting/installing/running/crashed/
 * timeout - types/session.ts) - no new backend state is introduced.
 * "crashed" specifically already has a live backend recovery loop
 * (watchForRecovery, lib/runtime/runtimeSession.ts) that silently
 * watches for a new port and restores `running` once the dev server
 * actually responds again - that is what RECOVERING reflects here,
 * not an invented animation. "timeout" does NOT have that same
 * automatic loop (confirmed by reading watchForRecovery's own call
 * site: only triggered when the attempt ended "crashed"), so it maps
 * to ERROR, not RECOVERING - the UI must never claim a silent recovery
 * is in progress when nothing is actually retrying.
 *
 * RENDERING vs READY is a genuine client-side signal, not a guess:
 * once state is "running" (which itself already means the backend
 * confirmed a real HTTP response before ever reporting it - see
 * waitForRealResponse in runtimeSession.ts), the iframe's own `load`
 * event (fires for cross-origin content too, unlike reading its DOM)
 * is what flips RENDERING to READY - real browser evidence, not a
 * timer.
 */
export type PreviewState =
  | "idle"
  | "building"
  | "starting_server"
  | "rendering"
  | "ready"
  | "recovering"
  | "error";

export interface PreviewStateInfo {
  state: PreviewState;
  label: string;
  detail: string | null;
}

/** How long a preview can sit in "crashed" before the UI additionally offers a manual retry, on top of the still-running silent recovery - a UI-only grace period, not a backend timeout. */
export const RECOVERY_GRACE_MS = 45_000;

export function derivePreviewState(host: RuntimeHost | null, iframeLoaded: boolean, now: number): PreviewStateInfo {
  if (!host || host.state === "idle") {
    return { state: "idle", label: "Preview", detail: null };
  }

  switch (host.state) {
    case "starting":
      return { state: "starting_server", label: "Starting your preview", detail: "Starting the development server" };
    case "installing":
      return { state: "building", label: "Building your workspace", detail: "Installing dependencies" };
    case "running":
      if (!host.previewUrl) {
        return { state: "starting_server", label: "Starting your preview", detail: "Starting the development server" };
      }
      return iframeLoaded
        ? { state: "ready", label: "Ready", detail: null }
        : { state: "rendering", label: "Rendering your site", detail: null };
    case "crashed": {
      const elapsed = now - (host.updatedAt ?? now);
      const pastGrace = elapsed > RECOVERY_GRACE_MS;
      return {
        state: pastGrace ? "error" : "recovering",
        label: pastGrace ? "Preview couldn't be restored automatically" : "Preview interrupted",
        detail: pastGrace
          ? (host.errorMessage ?? "The development server stopped responding.")
          : "Huddle noticed the preview stopped responding and is trying to restore it.",
      };
    }
    case "timeout":
      return {
        state: "error",
        label: "Preview didn't start in time",
        detail: host.errorMessage ?? "The development server took too long to respond.",
      };
    default:
      return { state: "idle", label: "Preview", detail: null };
  }
}
