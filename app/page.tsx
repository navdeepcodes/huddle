"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight, Archive } from "lucide-react";

import { useProjectList } from "@/hooks/useProjectList";
import { useIsMobile } from "@/hooks/useIsMobile";
import { MobileHome } from "@/components/mobile/MobileHome";
import { EntryGate } from "@/components/entry/EntryGate";
import { QuickResult } from "@/components/entry/QuickResult";
import { classifyRequestIntent } from "@/lib/projects/classifyIntent";
import { isProjectWorthy } from "@/lib/projects/isProjectWorthy";

import type { Session } from "@/types/session";

export function relativeTime(ms: number): string {
  const diffMin = Math.round((Date.now() - ms) / 60_000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.round(diffHr / 24)}d ago`;
}

/** Phase 37 STEP 6: intent cues, not a template marketplace - each just prefills the composer with project-shaped language, nudging the user's own words rather than picking for them. */
const PROJECT_STARTERS: Array<{ label: string; prefill: string }> = [
  { label: "Website", prefill: "Build a website for " },
  { label: "App", prefill: "Build an app that " },
  { label: "Hackathon", prefill: "Let's build our hackathon project: " },
  { label: "SaaS", prefill: "Build a SaaS product for " },
  { label: "Game", prefill: "Build a game where " },
  { label: "Research", prefill: "Help me build a research project on " },
];

export default function NewSessionPage() {
  const isMobile = useIsMobile();
  const { projects, createProject, archiveProject } = useProjectList();

  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [archivingId, setArchivingId] = useState<string | null>(null);
  const [confirmingArchiveId, setConfirmingArchiveId] = useState<string | null>(null);
  /** Phase 37: a "quick" request's session stays right here instead of hard-navigating away - see QuickResult's own doc comment. */
  const [quickSessionId, setQuickSessionId] = useState<string | null>(null);

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

    const text = message.trim();
    setLoading(true);
    setError(null);
    const result = await createProject(text);
    if (!result.ok) {
      setError(result.error);
      setLoading(false);
      return;
    }

    // Phase 37 STEP 1/2: a session is still always created (the runtime/agent
    // architecture structurally requires one) - what changes is whether the
    // user gets pulled into the full workspace for it. A session that turns
    // out to be real work self-promotes via QuickResult's own "Continue in
    // workspace" affordance (isProjectWorthy, derived from real file writes),
    // never from this pre-turn guess alone.
    if (classifyRequestIntent(text) === "project") {
      navigateToSession(result.id);
      return;
    }
    setMessage("");
    setLoading(false);
    setQuickSessionId(result.id);
  }

  if (isMobile) {
    return (
      <EntryGate projects={projects} createProject={createProject} navigateToSession={navigateToSession}>
        <MobileHome projects={projects} onCreate={createProject} onNavigate={navigateToSession} onArchive={archiveProject} />
      </EntryGate>
    );
  }

  const projectList = projects?.filter(isProjectWorthy) ?? null;
  const recentCreations = projects?.filter((p) => !isProjectWorthy(p)) ?? null;

  return (
    <EntryGate projects={projects} createProject={createProject} navigateToSession={navigateToSession}>
    <div className="flex flex-1 flex-col items-center px-6 py-16">
      <div className="w-full max-w-2xl">
        <div className="mb-2 flex items-start justify-between">
          <h1 className="text-3xl font-semibold tracking-tight text-fg">Huddle</h1>
          <Link href="/settings" className="mt-2 text-xs text-fg-subtle hover:text-fg">
            Settings
          </Link>
        </div>
        <p className="mb-8 text-fg-subtle">What do you want to make or explore?</p>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <textarea
            autoFocus
            rows={4}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Ask a question, generate an image, or describe a project to build."
            className="w-full resize-none rounded-xl border border-border bg-bg-raised p-4 text-base text-fg outline-none placeholder:text-fg-subtle focus:border-border-strong"
          />
          {error && <p className="text-sm text-danger">{error}</p>}
          <div className="flex items-center justify-between gap-3">
            <div className="flex flex-wrap gap-1.5">
              {PROJECT_STARTERS.map((starter) => (
                <button
                  key={starter.label}
                  type="button"
                  onClick={() => setMessage(starter.prefill)}
                  className="rounded-full border border-border px-2.5 py-1 text-xs text-fg-subtle hover:border-border-strong hover:text-fg"
                >
                  {starter.label}
                </button>
              ))}
            </div>
            <button
              type="submit"
              disabled={!message.trim() || loading}
              className="shrink-0 rounded-full bg-accent px-5 py-2.5 text-sm font-medium text-accent-fg disabled:opacity-40"
            >
              {loading ? "Starting…" : "Ask Huddle"}
            </button>
          </div>
        </form>

        {quickSessionId && (
          <div className="mt-6">
            <QuickResult
              sessionId={quickSessionId}
              onContinueInWorkspace={navigateToSession}
              onDismiss={() => setQuickSessionId(null)}
            />
          </div>
        )}

        <div className="mt-14">
          <p className="mb-3 text-xs font-medium uppercase tracking-wide text-fg-subtle">Your projects</p>

          {projectList === null ? (
            <ProjectListSkeleton />
          ) : projectList.length === 0 ? (
            <div className="rounded-xl border border-border px-4 py-8 text-center">
              <p className="text-sm text-fg-subtle">No projects yet - describe something to build above, and it&rsquo;ll show up here.</p>
            </div>
          ) : (
            <ProjectRows
              projects={projectList}
              confirmingArchiveId={confirmingArchiveId}
              archivingId={archivingId}
              setConfirmingArchiveId={setConfirmingArchiveId}
              setArchivingId={setArchivingId}
              archiveProject={archiveProject}
            />
          )}
        </div>

        {recentCreations !== null && recentCreations.length > 0 && (
          <div className="mt-10">
            <p className="mb-3 text-xs font-medium uppercase tracking-wide text-fg-subtle">Recent creations</p>
            <ProjectRows
              projects={recentCreations}
              confirmingArchiveId={confirmingArchiveId}
              archivingId={archivingId}
              setConfirmingArchiveId={setConfirmingArchiveId}
              setArchivingId={setArchivingId}
              archiveProject={archiveProject}
            />
          </div>
        )}
      </div>
    </div>
    </EntryGate>
  );
}

interface ProjectRowsProps {
  projects: Session[];
  confirmingArchiveId: string | null;
  archivingId: string | null;
  setConfirmingArchiveId: (id: string | null) => void;
  setArchivingId: (id: string | null) => void;
  archiveProject: (id: string) => Promise<boolean>;
}

function ProjectRows({ projects, confirmingArchiveId, archivingId, setConfirmingArchiveId, setArchivingId, archiveProject }: ProjectRowsProps) {
  return (
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
