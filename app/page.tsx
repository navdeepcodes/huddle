"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight, Archive } from "lucide-react";

import { useProjectList } from "@/hooks/useProjectList";
import { useIsMobile } from "@/hooks/useIsMobile";
import { MobileHome } from "@/components/mobile/MobileHome";

export function relativeTime(ms: number): string {
  const diffMin = Math.round((Date.now() - ms) / 60_000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.round(diffHr / 24)}d ago`;
}

export default function NewSessionPage() {
  const isMobile = useIsMobile();
  const { projects, createProject, archiveProject } = useProjectList();

  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [archivingId, setArchivingId] = useState<string | null>(null);
  const [confirmingArchiveId, setConfirmingArchiveId] = useState<string | null>(null);

  /**
   * A real top-level navigation, not router.push. Proven live
   * (2026-08-19): crossOriginIsolated - which WebContainer's
   * SharedArrayBuffer usage hard-requires - is fixed at whatever
   * top-level document the browser actually navigated to. A
   * client-side (SPA) transition into /session/[id] never re-fetches
   * the document, so it never picks up that route's COOP/COEP headers
   * (already correctly configured in next.config.ts) - confirmed with
   * the identical URL showing crossOriginIsolated true on a hard load
   * and false via router.push, side by side. This is a one-time cost
   * on session creation, not a general navigation-pattern change.
   * Shared by both the desktop and mobile create flows below.
   */
  function navigateToSession(id: string) {
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- deliberate: router.push does not carry the COOP/COEP headers this route needs, see comment above.
    window.location.href = `/session/${id}`;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!message.trim() || loading) return;

    setLoading(true);
    setError(null);
    const result = await createProject(message.trim());
    if (result.ok) {
      navigateToSession(result.id);
    } else {
      setError(result.error);
      setLoading(false);
    }
  }

  if (isMobile) {
    return <MobileHome projects={projects} onCreate={createProject} onNavigate={navigateToSession} onArchive={archiveProject} />;
  }

  return (
    <div className="flex flex-1 flex-col items-center px-6 py-16">
      <div className="w-full max-w-2xl">
        <div className="mb-2 flex items-start justify-between">
          <h1 className="text-3xl font-semibold tracking-tight text-fg">Huddle</h1>
          <Link href="/settings" className="mt-2 text-xs text-fg-subtle hover:text-fg">
            Settings
          </Link>
        </div>
        <p className="mb-8 text-fg-subtle">Tell Huddle what to build.</p>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <textarea
            autoFocus
            rows={4}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Build a premium ecommerce website for a Japanese furniture brand."
            className="w-full resize-none rounded-xl border border-border bg-bg-raised p-4 text-base text-fg outline-none placeholder:text-fg-subtle focus:border-border-strong"
          />
          {error && <p className="text-sm text-danger">{error}</p>}
          <button
            type="submit"
            disabled={!message.trim() || loading}
            className="self-end rounded-full bg-accent px-5 py-2.5 text-sm font-medium text-accent-fg disabled:opacity-40"
          >
            {loading ? "Starting…" : "New Session"}
          </button>
        </form>

        <div className="mt-14">
          <p className="mb-3 text-xs font-medium uppercase tracking-wide text-fg-subtle">Your projects</p>

          {projects === null ? (
            <ProjectListSkeleton />
          ) : projects.length === 0 ? (
            <div className="rounded-xl border border-border px-4 py-8 text-center">
              <p className="text-sm text-fg-subtle">No projects yet - describe what you want built above.</p>
            </div>
          ) : (
            <ul className="divide-y divide-border rounded-xl border border-border">
              {projects.map((p) => (
                <li key={p.id} className="group relative">
                  <a href={`/session/${p.id}`} className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-bg-raised">
                    <div className="min-w-0">
                      <p className="truncate text-sm text-fg">{p.name}</p>
                      {p.description && <p className="truncate text-xs text-fg-subtle">{p.description}</p>}
                    </div>
                    <span className="flex shrink-0 items-center gap-2 text-xs text-fg-subtle">
                      {relativeTime(p.updatedAt ?? p.createdAt)}
                      <ArrowRight className="h-3.5 w-3.5 opacity-0 transition-opacity group-hover:opacity-100" strokeWidth={2} />
                    </span>
                  </a>

                  {confirmingArchiveId === p.id ? (
                    <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1.5 rounded-md border border-border bg-bg-overlay px-2 py-1 text-2xs shadow-lg">
                      <span className="text-fg-muted">Archive this project?</span>
                      <button
                        onClick={async (e) => {
                          e.preventDefault();
                          setArchivingId(p.id);
                          await archiveProject(p.id);
                          setArchivingId(null);
                          setConfirmingArchiveId(null);
                        }}
                        disabled={archivingId === p.id}
                        className="rounded bg-danger px-1.5 py-0.5 font-medium text-white disabled:opacity-50"
                      >
                        {archivingId === p.id ? "Archiving…" : "Archive"}
                      </button>
                      <button
                        onClick={(e) => {
                          e.preventDefault();
                          setConfirmingArchiveId(null);
                        }}
                        className="rounded px-1.5 py-0.5 text-fg-muted hover:bg-bg-raised"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={(e) => {
                        e.preventDefault();
                        setConfirmingArchiveId(p.id);
                      }}
                      aria-label={`Archive ${p.name}`}
                      title="Archive"
                      className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1.5 text-fg-subtle opacity-0 hover:bg-bg-overlay hover:text-danger group-hover:opacity-100"
                    >
                      <Archive className="h-3.5 w-3.5" strokeWidth={1.75} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function ProjectListSkeleton() {
  return (
    <div className="space-y-0 overflow-hidden rounded-xl border border-border">
      {[0, 1, 2].map((i) => (
        <div key={i} className={i > 0 ? "border-t border-border px-4 py-3" : "px-4 py-3"} aria-hidden>
          <div className="huddle-animate-shimmer h-3.5 w-40 rounded bg-bg-raised" />
          <div className="huddle-animate-shimmer mt-2 h-2.5 w-64 rounded bg-bg-raised" />
        </div>
      ))}
    </div>
  );
}
