"use client";

import { useEffect, useState } from "react";
import { ArrowUp, MoreHorizontal, Settings, Sparkles } from "lucide-react";

import { relativeTime } from "@/app/page";
import { BottomSheet } from "@/components/mobile/BottomSheet";
import { QuickResult } from "@/components/entry/QuickResult";
import { classifyRequestIntent } from "@/lib/projects/classifyIntent";
import { isProjectWorthy } from "@/lib/projects/isProjectWorthy";

import type { Session } from "@/types/session";

interface Props {
  projects: Session[] | null;
  onCreate: (message: string) => Promise<{ ok: true; id: string } | { ok: false; error: string }>;
  onNavigate: (id: string) => void;
  onArchive: (id: string) => Promise<boolean>;
}

/** Phase 37 STEP 6: same intent cues as desktop - prefills, never a template picker. */
const PROJECT_STARTERS: Array<{ label: string; prefill: string }> = [
  { label: "Website", prefill: "Build a website for " },
  { label: "App", prefill: "Build an app that " },
  { label: "Hackathon", prefill: "Let's build our hackathon project: " },
  { label: "SaaS", prefill: "Build a SaaS product for " },
  { label: "Game", prefill: "Build a game where " },
];

/**
 * Phase 32: the mobile companion's front door - "Home" says "Tell
 * Huddle what you want, watch it build, review what it made, and keep
 * moving," the same principle desktop's dashboard was never designed
 * around (desktop opens on a plain compose box; mobile is the premium
 * creation surface). Shares useProjectList's data/create/archive logic
 * with the desktop dashboard via props from app/page.tsx - no second
 * fetch, no second Firestore query.
 *
 * Phase 37: "Tell Huddle what to build" assumed every interaction was
 * a Project - now a quick question/image/presentation stays right here
 * (QuickResult, inline) instead of hard-navigating away, and "Your
 * projects" only ever shows sessions that actually became one
 * (isProjectWorthy) - see Session.hasRealFiles's own doc comment.
 */
export function MobileHome({ projects, onCreate, onNavigate, onArchive }: Props) {
  const [message, setMessage] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quickSessionId, setQuickSessionId] = useState<string | null>(null);

  async function handleCreate() {
    if (!message.trim() || creating) return;
    const text = message.trim();
    setCreating(true);
    setError(null);
    const result = await onCreate(text);
    if (!result.ok) {
      setError(result.error);
      setCreating(false);
      return;
    }

    if (classifyRequestIntent(text) === "project") {
      onNavigate(result.id);
      return;
    }
    setMessage("");
    setCreating(false);
    setQuickSessionId(result.id);
  }

  const projectList = projects?.filter(isProjectWorthy) ?? null;
  const recentCreations = projects?.filter((p) => !isProjectWorthy(p)) ?? null;

  return (
    <div className="min-h-dvh bg-bg-base">
      <div className="mx-auto flex min-h-dvh max-w-lg flex-col px-5">
        <header className="huddle-safe-top flex shrink-0 items-center justify-between pb-2">
          <span className="text-lg font-semibold tracking-tight text-fg">Huddle</span>
          <a
            href="/settings"
            aria-label="Settings"
            className="flex h-10 w-10 items-center justify-center rounded-full text-fg-subtle hover:bg-bg-raised hover:text-fg"
          >
            <Settings className="h-5 w-5" strokeWidth={1.75} />
          </a>
        </header>

        <div className="huddle-glow relative mt-4 shrink-0 overflow-hidden rounded-2xl border border-border bg-bg-raised p-4">
          <p className="mb-2.5 flex items-center gap-1.5 text-xs font-medium text-fg-subtle">
            <Sparkles className="h-3.5 w-3.5 text-accent" strokeWidth={2} />
            What do you want to make or explore?
          </p>
          <textarea
            rows={3}
            value={message}
            onChange={(e) => {
              setMessage(e.target.value);
              if (error) setError(null);
            }}
            placeholder="Ask a question, generate an image, or describe a project…"
            className="w-full resize-none bg-transparent text-base text-fg outline-none placeholder:text-fg-subtle"
          />
          <div className="mt-2 flex items-center justify-between gap-2">
            <div className="flex min-w-0 gap-1.5 overflow-x-auto">
              {PROJECT_STARTERS.map((starter) => (
                <button
                  key={starter.label}
                  onClick={() => setMessage(starter.prefill)}
                  className="shrink-0 rounded-full border border-border px-2.5 py-1 text-xs text-fg-subtle active:bg-bg-overlay"
                >
                  {starter.label}
                </button>
              ))}
            </div>
            <button
              onClick={handleCreate}
              disabled={!message.trim() || creating}
              aria-label="Ask Huddle"
              className="ml-auto flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent text-accent-fg transition-transform active:scale-95 disabled:opacity-40"
            >
              <ArrowUp className="h-5 w-5" strokeWidth={2.5} />
            </button>
          </div>
          {error && <p className="mt-1.5 text-xs text-danger">{error}</p>}
        </div>

        {quickSessionId && (
          <div className="mt-4 shrink-0">
            <QuickResult sessionId={quickSessionId} onContinueInWorkspace={onNavigate} onDismiss={() => setQuickSessionId(null)} />
          </div>
        )}

        <div className="mt-9 flex-1 pb-8">
          <p className="mb-3 text-xs font-medium uppercase tracking-wide text-fg-subtle">Your projects</p>

          {projectList === null ? (
            <ProjectCardSkeletonList />
          ) : projectList.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="flex flex-col gap-3">
              {projectList.map((p) => (
                <ProjectCard key={p.id} project={p} onOpen={() => onNavigate(p.id)} onArchive={() => onArchive(p.id)} />
              ))}
            </div>
          )}

          {recentCreations !== null && recentCreations.length > 0 && (
            <div className="mt-9">
              <p className="mb-3 text-xs font-medium uppercase tracking-wide text-fg-subtle">Recent creations</p>
              <div className="flex flex-col gap-3">
                {recentCreations.map((p) => (
                  <ProjectCard key={p.id} project={p} onOpen={() => onNavigate(p.id)} onArchive={() => onArchive(p.id)} />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ProjectCard({ project, onOpen, onArchive }: { project: Session; onOpen: () => void; onArchive: () => Promise<boolean> }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [archiving, setArchiving] = useState(false);
  // React forbids Date.now() during render - `now` is real state instead, ticked only as often as the "recently active" pulse actually needs to stay fresh.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const lastActive = project.updatedAt ?? project.createdAt;
  const recentlyActive = now - lastActive < 3 * 60_000;
  const monogram = project.name.trim().charAt(0).toUpperCase() || "H";

  return (
    <div className="relative overflow-hidden rounded-2xl border border-border bg-bg-raised">
      <button onClick={onOpen} className="block w-full text-left active:opacity-80">
        {/* No stored preview thumbnail infra exists yet - this is a deliberate placeholder (monogram + soft accent field), not a broken image. */}
        <div className="flex aspect-[2/1] items-center justify-center bg-gradient-to-br from-bg-overlay to-bg-raised">
          <span className="text-3xl font-semibold text-fg-subtle">{monogram}</span>
        </div>
        <div className="p-4">
          <p className="truncate text-base font-medium text-fg">{project.name}</p>
          {project.description && <p className="mt-0.5 line-clamp-2 text-sm text-fg-subtle">{project.description}</p>}
          <div className="mt-2.5 flex items-center gap-1.5 text-xs text-fg-subtle">
            <span className={`h-1.5 w-1.5 rounded-full ${recentlyActive ? "huddle-animate-pulse bg-accent" : "bg-border-strong"}`} />
            {relativeTime(lastActive)}
          </div>
        </div>
      </button>

      <button
        onClick={() => setMenuOpen(true)}
        aria-label={`Options for ${project.name}`}
        className="absolute right-3 top-3 flex h-10 w-10 items-center justify-center rounded-full bg-black/30 text-white backdrop-blur-sm"
      >
        <MoreHorizontal className="h-4 w-4" strokeWidth={2} />
      </button>

      <BottomSheet open={menuOpen} onClose={() => setMenuOpen(false)} title={project.name}>
        <button
          onClick={async () => {
            setArchiving(true);
            await onArchive();
            setArchiving(false);
            setMenuOpen(false);
          }}
          disabled={archiving}
          className="flex w-full items-center gap-2.5 rounded-xl px-3 py-3.5 text-left text-sm text-danger hover:bg-bg-raised disabled:opacity-50"
        >
          {archiving ? "Archiving…" : "Archive project"}
        </button>
      </BottomSheet>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="huddle-glow flex flex-col items-center rounded-2xl border border-border px-6 py-14 text-center">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-bg-raised">
        <Sparkles className="h-5 w-5 text-accent" strokeWidth={1.75} />
      </div>
      <p className="text-sm font-medium text-fg">Nothing built yet</p>
      <p className="mt-1 max-w-[26ch] text-sm text-fg-subtle">Describe what you want above, and Huddle will start building it.</p>
    </div>
  );
}

function ProjectCardSkeletonList() {
  return (
    <div className="flex flex-col gap-3" aria-hidden>
      {[0, 1].map((i) => (
        <div key={i} className="overflow-hidden rounded-2xl border border-border bg-bg-raised">
          <div className="huddle-animate-shimmer aspect-[2/1] bg-bg-overlay" />
          <div className="p-4">
            <div className="huddle-animate-shimmer h-4 w-2/3 rounded bg-bg-overlay" />
            <div className="huddle-animate-shimmer mt-2 h-3 w-1/2 rounded bg-bg-overlay" />
          </div>
        </div>
      ))}
    </div>
  );
}
