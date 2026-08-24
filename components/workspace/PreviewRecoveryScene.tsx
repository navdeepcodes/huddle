"use client";

import { useState } from "react";
import { RotateCcw, ChevronDown } from "lucide-react";

/**
 * Phase 30 Part 7/8/10/11: the calm crash/recovery presentation.
 * "recovering" reflects a REAL backend mechanism already running
 * (watchForRecovery, lib/runtime/runtimeSession.ts - see
 * previewState.ts's own doc comment) - this component never claims
 * recovery succeeded on its own; it only animates while `state`
 * (derived from the actual RuntimeHost doc) says "recovering", and
 * the parent (PreviewPane) is what transitions this component away
 * once the real state flips to "running". "error" only appears after
 * previewState.ts's UI-only grace period has elapsed with no change -
 * at that point the silent backend loop may still be trying, but the
 * user is no longer left staring at nothing with no way out.
 */
export function PreviewRecoveryScene({
  state,
  label,
  detail,
  onRetry,
}: {
  state: "recovering" | "error";
  label: string;
  detail: string | null;
  onRetry: () => void;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);

  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 bg-bg-base px-6 text-center">
      <div className="relative w-full max-w-sm overflow-hidden rounded-lg border border-border bg-bg-raised">
        <div className="flex items-center gap-1.5 border-b border-border px-3 py-2">
          <span className="h-1.5 w-1.5 rounded-full bg-border-strong" />
          <span className="h-1.5 w-1.5 rounded-full bg-border-strong" />
          <span className="h-1.5 w-1.5 rounded-full bg-border-strong" />
        </div>
        <div className={`space-y-3 p-4 transition-opacity duration-500 ${state === "recovering" ? "opacity-40" : "opacity-25"}`}>
          <div className="h-2.5 w-16 rounded bg-border" />
          <div className="h-10 w-full rounded bg-border" />
          <div className="flex gap-2">
            <div className="h-14 flex-1 rounded bg-border" />
            <div className="h-14 flex-1 rounded bg-border" />
            <div className="h-14 flex-1 rounded bg-border" />
          </div>
        </div>
        {state === "recovering" && (
          <div className="huddle-animate-scan pointer-events-none absolute inset-0 bg-gradient-to-r from-transparent via-accent/10 to-transparent" />
        )}
      </div>

      <div>
        <p className="mb-1 flex items-center justify-center gap-1.5 text-sm text-fg">
          {state === "recovering" && <RotateCcw className="h-3.5 w-3.5 animate-spin text-accent" strokeWidth={2} style={{ animationDuration: "2s" }} />}
          {label}
        </p>
        {/* Recovering: the calm, non-technical framing shows inline - it's
            reassurance, not a diagnosis. Error: the same detail text IS
            the technical reason (host.errorMessage), so it stays hidden
            behind "View details" instead - see this component's own doc
            comment. */}
        {state === "recovering" && detail && <p className="text-xs text-fg-subtle">{detail}</p>}
      </div>

      {state === "error" && (
        <div className="flex flex-col items-center gap-2">
          <div className="flex items-center gap-2">
            <button
              onClick={onRetry}
              className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg"
            >
              Try again
            </button>
            <button
              onClick={() => setDetailsOpen((v) => !v)}
              className="flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs text-fg-muted hover:bg-bg-raised"
            >
              View details
              <ChevronDown className={`h-3 w-3 transition-transform ${detailsOpen ? "rotate-180" : ""}`} strokeWidth={2} />
            </button>
          </div>
          {detailsOpen && detail && (
            <pre className="huddle-animate-fade-in max-h-40 w-full max-w-sm overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-bg-raised p-2.5 text-left font-mono text-2xs text-fg-subtle">
              {detail}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
