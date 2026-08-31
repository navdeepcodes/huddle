"use client";

import { useEffect, useState } from "react";

import { HuddleMark } from "@/components/brand/HuddleMark";
import { linkAnonymousToGoogle } from "@/lib/firebase/authActions";

interface Props {
  /** Already signed in with a real provider (e.g. persisted from a previous visit but the intro-seen flag was somehow cleared) - skip the sign-in choice entirely, there's nothing left to decide. */
  isAlreadyAuthenticated: boolean;
  onDone: () => void;
}

const SPLASH_MS = 1100;

/**
 * Phase 34 PART 1/2/3: the branded entry - a short, one-time splash
 * (H mark, no "Loading…") that transitions into the sign-in choice.
 * Shown only once per browser (see useHasSeenIntro) - a returning
 * visitor of any kind (anonymous or authenticated) never sees this
 * again. "Continue without an account" keeps today's zero-friction
 * anonymous flow fully intact - this is an optional upgrade, not a
 * hard gate (PART 9's "Anonymous existing user" stays a real, supported
 * path, not a state this screen forces past).
 */
export function IntroSequence({ isAlreadyAuthenticated, onDone }: Props) {
  const [showSplash, setShowSplash] = useState(true);

  useEffect(() => {
    const id = setTimeout(() => setShowSplash(false), SPLASH_MS);
    return () => clearTimeout(id);
  }, []);

  useEffect(() => {
    if (!showSplash && isAlreadyAuthenticated) onDone();
  }, [showSplash, isAlreadyAuthenticated, onDone]);

  if (showSplash || isAlreadyAuthenticated) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-5 bg-bg-base px-6">
        <HuddleMark size={56} animate="in" title="Huddle" className="text-accent" />
      </div>
    );
  }

  return <AuthChoiceScreen onDone={onDone} />;
}

function GoogleGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
      <path d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.9c1.7-1.57 2.68-3.87 2.68-6.62z" fill="#4285F4" />
      <path d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26c-.8.54-1.83.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.95v2.33A9 9 0 0 0 9 18z" fill="#34A853" />
      <path d="M3.95 10.7A5.4 5.4 0 0 1 3.66 9c0-.59.1-1.17.29-1.7V4.97H.95A9 9 0 0 0 0 9c0 1.45.35 2.83.95 4.03z" fill="#FBBC05" />
      <path d="M9 3.58c1.32 0 2.51.46 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .95 4.97L3.95 7.3C4.66 5.17 6.65 3.58 9 3.58z" fill="#EA4335" />
    </svg>
  );
}

function AuthChoiceScreen({ onDone }: { onDone: () => void }) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleGoogle() {
    setWorking(true);
    setError(null);
    const result = await linkAnonymousToGoogle();
    setWorking(false);
    if (result.ok) {
      onDone();
    } else {
      setError(result.error);
    }
  }

  return (
    <div className="huddle-animate-fade-in flex min-h-dvh flex-col items-center justify-center gap-8 bg-bg-base px-6 text-center">
      <HuddleMark size={44} className="text-accent" />

      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight text-fg">Build something together.</h1>
        <p className="text-sm text-fg-subtle">Sign in to keep your projects synced across devices.</p>
      </div>

      <div className="flex w-full max-w-xs flex-col gap-3">
        <button
          onClick={handleGoogle}
          disabled={working}
          className="flex items-center justify-center gap-2.5 rounded-full bg-fg px-5 py-3.5 text-sm font-medium text-bg-base transition-opacity disabled:opacity-60"
        >
          <GoogleGlyph />
          {working ? "Signing in…" : "Continue with Google"}
        </button>
        <button onClick={onDone} className="rounded-full px-5 py-3.5 text-sm text-fg-subtle hover:text-fg">
          Continue without an account
        </button>
      </div>

      {error && (
        <p className="max-w-xs text-xs text-danger">
          {error}{" "}
          <button onClick={handleGoogle} className="underline underline-offset-2">
            Try again
          </button>
        </p>
      )}
    </div>
  );
}
