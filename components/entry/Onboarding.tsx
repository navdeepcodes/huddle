"use client";

import { useState } from "react";
import { updateProfile } from "firebase/auth";

import { auth } from "@/lib/firebase/client";
import { parseSessionIdFromInput } from "@/lib/sessions/parseSessionIdFromInput";
import { HuddleMark } from "@/components/brand/HuddleMark";
import { classifyRequestIntent } from "@/lib/projects/classifyIntent";
import { QuickResult } from "@/components/entry/QuickResult";

interface Props {
  createProject: (message: string) => Promise<{ ok: true; id: string } | { ok: false; error: string }>;
  navigateToSession: (id: string) => void;
  /** Phase 38 fix: tells EntryGate the quick-result screen is done and it's safe to swap to the real dashboard - see EntryGate's own doc comment for the race this closes. */
  onDone: () => void;
}

type Step = "welcome" | "build" | "ready";

/**
 * Phase 34 PART 4/5: shown only when useProjectList() resolves to zero
 * projects (see EntryGate) - a genuinely new user, never a returning
 * one. Two real screens, not four: "what are you building" (create)
 * and the optional name field are ONE screen, not a separate
 * traditional form per input, matching "do not turn onboarding into a
 * long questionnaire" and the 30-60s budget. Creates through the
 * EXISTING createProject/useProjectList - no second project-creation
 * path - and "Join a project" reuses the EXISTING join-by-URL
 * mechanism (parseSessionIdFromInput + navigateToSession), not a new
 * invite system.
 *
 * Phase 38 fix: a "quick" first message (a question, a one-off image -
 * classifyRequestIntent says not a project) used to still hard-navigate
 * into the full /session/[id] workspace, exactly the Session != Project
 * violation Phase 37 was supposed to close everywhere. It only got that
 * far here because onboarding never had QuickResult's inline-on-Home
 * treatment - it does now, reusing the SAME component Home already
 * mounts, not a second implementation.
 */
export function Onboarding({ createProject, navigateToSession, onDone }: Props) {
  const [step, setStep] = useState<Step>("welcome");
  const [quickSessionId, setQuickSessionId] = useState<string | null>(null);

  if (step === "welcome") return <Welcome onNext={() => setStep("build")} />;
  if (quickSessionId) {
    return <QuickOnboardingResult sessionId={quickSessionId} navigateToSession={navigateToSession} onDone={onDone} />;
  }
  if (step === "ready") return <ProjectReady />;
  return (
    <BuildStep
      createProject={createProject}
      navigateToSession={navigateToSession}
      onProjectReady={() => setStep("ready")}
      onQuickResult={setQuickSessionId}
    />
  );
}

function Welcome({ onNext }: { onNext: () => void }) {
  return (
    <div className="huddle-animate-fade-in flex min-h-dvh flex-col items-center justify-center gap-6 bg-bg-base px-6 text-center">
      <HuddleMark size={48} className="text-accent" />
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight text-fg">Meet Huddle.</h1>
        <p className="max-w-xs text-sm text-fg-subtle">Your AI teammate for making and building things together.</p>
      </div>
      <button
        onClick={onNext}
        className="rounded-full bg-accent px-8 py-3.5 text-sm font-medium text-accent-fg transition-transform active:scale-95"
      >
        Get started
      </button>
    </div>
  );
}

function BuildStep({
  createProject,
  navigateToSession,
  onProjectReady,
  onQuickResult,
}: Omit<Props, "onDone"> & { onProjectReady: () => void; onQuickResult: (sessionId: string) => void }) {
  const [idea, setIdea] = useState("");
  const [showName, setShowName] = useState(false);
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [showJoin, setShowJoin] = useState(false);
  const [joinValue, setJoinValue] = useState("");
  const [joinError, setJoinError] = useState<string | null>(null);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!idea.trim() || loading) return;
    setLoading(true);
    setError(null);

    if (name.trim() && auth.currentUser) {
      await updateProfile(auth.currentUser, { displayName: name.trim() }).catch(() => {});
    }

    const result = await createProject(idea.trim());
    if (!result.ok) {
      setError(result.error);
      setLoading(false);
      return;
    }

    if (classifyRequestIntent(idea.trim()) === "project") {
      onProjectReady();
      window.setTimeout(() => navigateToSession(result.id), 900);
      return;
    }

    // Quick: stay put and show the real response inline (QuickOnboardingResult)
    // instead of hard-navigating into a workspace this request never earned.
    setLoading(false);
    onQuickResult(result.id);
  }

  function handleJoin(e: React.FormEvent) {
    e.preventDefault();
    const id = parseSessionIdFromInput(joinValue);
    if (!id) {
      setJoinError("That doesn't look like a valid project link.");
      return;
    }
    navigateToSession(id);
  }

  return (
    <div className="huddle-animate-fade-in flex min-h-dvh flex-col items-center justify-center gap-6 bg-bg-base px-6">
      <div className="w-full max-w-md space-y-6">
        <div className="space-y-1.5 text-center">
          <h1 className="text-xl font-semibold tracking-tight text-fg">What do you want to make or explore?</h1>
          <p className="text-sm text-fg-subtle">Ask a question, generate something, or describe a project - Huddle will start.</p>
        </div>

        {!showJoin ? (
          <form onSubmit={handleCreate} className="space-y-4">
            <textarea
              autoFocus
              rows={4}
              value={idea}
              onChange={(e) => setIdea(e.target.value)}
              placeholder="A portfolio website for my design studio… or just ask something."
              disabled={loading}
              className="w-full resize-none rounded-2xl border border-border bg-bg-raised p-4 text-base text-fg outline-none placeholder:text-fg-subtle focus:border-border-strong disabled:opacity-60"
            />

            {showName ? (
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your name (optional)"
                disabled={loading}
                className="w-full rounded-xl border border-border bg-bg-raised px-4 py-2.5 text-sm text-fg outline-none placeholder:text-fg-subtle focus:border-border-strong disabled:opacity-60"
              />
            ) : (
              <button
                type="button"
                onClick={() => setShowName(true)}
                className="text-xs text-fg-subtle hover:text-fg"
              >
                + Add your name
              </button>
            )}

            {error && <p className="text-sm text-danger">{error}</p>}

            <button
              type="submit"
              disabled={!idea.trim() || loading}
              className="w-full rounded-full bg-accent px-5 py-3.5 text-sm font-medium text-accent-fg transition-opacity disabled:opacity-40"
            >
              {loading ? "Starting…" : "Ask Huddle"}
            </button>

            <button
              type="button"
              onClick={() => setShowJoin(true)}
              className="block w-full text-center text-xs text-fg-subtle hover:text-fg"
            >
              Join a project instead
            </button>
          </form>
        ) : (
          <form onSubmit={handleJoin} className="space-y-4">
            <input
              autoFocus
              value={joinValue}
              onChange={(e) => {
                setJoinValue(e.target.value);
                if (joinError) setJoinError(null);
              }}
              placeholder="Paste a project link…"
              className="w-full rounded-xl border border-border bg-bg-raised px-4 py-3 text-sm text-fg outline-none placeholder:text-fg-subtle focus:border-border-strong"
            />
            {joinError && <p className="text-sm text-danger">{joinError}</p>}
            <button
              type="submit"
              disabled={!joinValue.trim()}
              className="w-full rounded-full bg-accent px-5 py-3.5 text-sm font-medium text-accent-fg disabled:opacity-40"
            >
              Join project
            </button>
            <button
              type="button"
              onClick={() => setShowJoin(false)}
              className="block w-full text-center text-xs text-fg-subtle hover:text-fg"
            >
              Create a project instead
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

/**
 * PART 5: the transition before the hard navigation into /session/[id]
 * - never a silent redirect straight into a generic workspace. Only
 * reached for a real project classification now (Phase 38) - a quick
 * request goes to QuickOnboardingResult below instead.
 */
function ProjectReady() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-5 bg-bg-base px-6 text-center">
      <HuddleMark size={44} animate="in" className="text-accent" />
      <p className="text-lg font-medium text-fg">Your project is ready.</p>
    </div>
  );
}

/**
 * Phase 38 fix: the quick-request counterpart to ProjectReady - except
 * this one doesn't navigate anywhere. It mounts the EXACT QuickResult
 * component Home uses (real turn, real inline response, its own
 * "Continue in workspace" affordance if the session ever earns real
 * files), wrapped in onboarding's own chrome. "Continue to Huddle" and
 * QuickResult's own dismiss both just call onDone - there's nothing
 * left to decide once the user has seen the reply.
 */
function QuickOnboardingResult({
  sessionId,
  navigateToSession,
  onDone,
}: {
  sessionId: string;
  navigateToSession: (id: string) => void;
  onDone: () => void;
}) {
  return (
    <div className="huddle-animate-fade-in flex min-h-dvh flex-col items-center justify-center gap-5 bg-bg-base px-6">
      <div className="w-full max-w-md space-y-4">
        <div className="text-center">
          <HuddleMark size={32} animate="in" className="mx-auto mb-3 text-accent" />
          <p className="text-sm text-fg-subtle">Huddle&rsquo;s on it.</p>
        </div>
        <QuickResult sessionId={sessionId} onContinueInWorkspace={navigateToSession} onDismiss={onDone} />
        <button
          onClick={onDone}
          className="block w-full rounded-full bg-accent px-5 py-3 text-sm font-medium text-accent-fg transition-transform active:scale-95"
        >
          Continue to Huddle
        </button>
      </div>
    </div>
  );
}
