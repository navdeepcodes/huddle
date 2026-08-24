/**
 * Phase 30 Part 5: the "website being assembled" scene shown while
 * PreviewPane has nothing real to render yet (BUILDING/STARTING_SERVER/
 * RENDERING). Deliberately abstract, generic blocks - never content
 * that could be mistaken for the user's actual site (per the phase
 * brief's own explicit warning). Pure CSS animation (shimmer + a
 * staggered rise-in per block via inline animation-delay) - no canvas,
 * no SVG, no new dependency; every animated class already degrades to
 * a static frame under prefers-reduced-motion (see globals.css).
 */
export function BuildingPreviewScene({ label, detail }: { label: string; detail: string | null }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 bg-bg-base px-6 text-center">
      <div className="flex items-center gap-1.5 text-fg-subtle">
        <span className="huddle-animate-pulse h-1.5 w-1.5 rounded-full bg-accent" />
        <span className="text-xs font-medium uppercase tracking-wide">Huddle</span>
      </div>

      <div className="w-full max-w-sm">
        <p className="mb-4 text-sm text-fg">{label}</p>

        <div className="overflow-hidden rounded-lg border border-border bg-bg-raised">
          {/* browser chrome */}
          <div className="flex items-center gap-1.5 border-b border-border px-3 py-2">
            <span className="h-1.5 w-1.5 rounded-full bg-border-strong" />
            <span className="h-1.5 w-1.5 rounded-full bg-border-strong" />
            <span className="h-1.5 w-1.5 rounded-full bg-border-strong" />
          </div>

          {/* skeleton page */}
          <div className="space-y-3 p-4">
            <div
              className="huddle-animate-shimmer huddle-animate-rise-in h-2.5 w-16 rounded bg-border"
              style={{ animationDelay: "0ms" }}
            />
            <div
              className="huddle-animate-shimmer huddle-animate-rise-in h-10 w-full rounded bg-border"
              style={{ animationDelay: "80ms" }}
            />
            <div className="flex gap-2">
              <div
                className="huddle-animate-shimmer huddle-animate-rise-in h-14 flex-1 rounded bg-border"
                style={{ animationDelay: "160ms" }}
              />
              <div
                className="huddle-animate-shimmer huddle-animate-rise-in h-14 flex-1 rounded bg-border"
                style={{ animationDelay: "220ms" }}
              />
              <div
                className="huddle-animate-shimmer huddle-animate-rise-in h-14 flex-1 rounded bg-border"
                style={{ animationDelay: "280ms" }}
              />
            </div>
          </div>
        </div>
      </div>

      {detail && <p className="text-xs text-fg-subtle">{detail}</p>}
    </div>
  );
}
