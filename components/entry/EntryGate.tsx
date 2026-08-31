"use client";

import { useState, type ReactNode } from "react";

import { useAuthState } from "@/hooks/useAuthState";
import { useHasSeenIntro } from "@/hooks/useHasSeenIntro";
import { EntryLoadingScreen } from "@/components/entry/EntryLoadingScreen";
import { IntroSequence } from "@/components/entry/IntroSequence";
import { Onboarding } from "@/components/entry/Onboarding";

import type { Session } from "@/types/session";

interface Props {
  projects: Session[] | null;
  createProject: (message: string) => Promise<{ ok: true; id: string } | { ok: false; error: string }>;
  navigateToSession: (id: string) => void;
  children: ReactNode;
}

/**
 * Phase 34: the whole entry state machine, gating the EXISTING
 * dashboard (`children`) rather than replacing it. Takes
 * projects/createProject as props instead of calling useProjectList()
 * itself - the caller (app/page.tsx) already needs that hook for the
 * dashboard body, and a second independent call would mean two
 * competing fetches of the same data (the exact "do not duplicate
 * existing state" this phase's brief warns against).
 *
 * Screen order, each gated on the previous fully resolving so nothing
 * ever flashes the wrong screen (PART 9):
 * loading -> intro (first visit only, splash + optional sign-in) ->
 * loading (projects still resolving) -> onboarding (zero projects) ->
 * children (the real product, unchanged).
 *
 * Phase 38 fix: `projects.length === 0` used to be re-evaluated on
 * every render, which meant a "quick" onboarding submission (a
 * question, a one-off image - anything classifyRequestIntent doesn't
 * call "project") still yanked the user straight to `children` the
 * instant that session's Firestore doc landed and `projects` ticked up
 * to 1, seconds before Huddle's actual reply even arrived - Onboarding
 * never got the chance to show it inline (QuickResult), and the
 * hard-navigate-to-workspace bug the user reported was really this
 * race's more visible sibling. Decided ONCE (render-time adjustment,
 * same pattern as PreviewPane's own prevPreviewUrl reset - not an
 * effect) the first time `projects` resolves non-null, then latched:
 * only Onboarding's own onDone can release it, so a session being
 * created mid-flow never yanks the screen out from under the user.
 */
export function EntryGate({ projects, createProject, navigateToSession, children }: Props) {
  const authState = useAuthState();
  const [introSeen, setIntroSeen] = useHasSeenIntro();
  const [showOnboarding, setShowOnboarding] = useState<boolean | null>(null);

  if (authState.status === "loading" || introSeen === null) {
    return <EntryLoadingScreen />;
  }

  if (!introSeen) {
    return (
      <IntroSequence
        isAlreadyAuthenticated={authState.status === "authenticated"}
        onDone={() => setIntroSeen(true)}
      />
    );
  }

  if (projects === null) {
    return <EntryLoadingScreen />;
  }

  if (showOnboarding === null) {
    setShowOnboarding(projects.length === 0);
  }

  if (showOnboarding) {
    return (
      <Onboarding
        createProject={createProject}
        navigateToSession={navigateToSession}
        onDone={() => setShowOnboarding(false)}
      />
    );
  }

  return <>{children}</>;
}
