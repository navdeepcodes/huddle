"use client";

import { useSyncExternalStore } from "react";

const KEY = "huddle:intro-seen";
const listeners = new Set<() => void>();

/** Pure - exported so the read/write mapping is testable without a real localStorage/React tree. */
export function parseIntroSeen(raw: string | null): boolean {
  return raw === "1";
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

function getSnapshot(): boolean {
  return parseIntroSeen(localStorage.getItem(KEY));
}

/** `null` (not `false`) so a server render and the initial client hydration pass agree on "unresolved," never a hydration mismatch or a flash of the wrong screen - same reasoning as useIsMobile's own getServerSnapshot. */
function getServerSnapshot(): boolean | null {
  return null;
}

/**
 * Phase 34 PART 6: "persist whatever minimal onboarding-completion
 * state is actually necessary... avoid unnecessary Firestore fields."
 * Whether a browser has ever seen the splash/auth intro is purely a
 * client-side "have I shown this before" flag - it has no server
 * meaning, so a single localStorage key is the whole implementation,
 * not a new Firestore field. Built on useSyncExternalStore (the same
 * primitive useIsMobile.ts already established for this exact class of
 * problem - a browser-only value read without a hydration mismatch)
 * rather than a useEffect+setState pair, which react-hooks flags as
 * an anti-pattern for exactly this "sync from an external system on
 * mount" shape.
 */
export function useHasSeenIntro(): [boolean | null, (seen: boolean) => void] {
  const seen = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  function setSeen(value: boolean) {
    if (value) localStorage.setItem(KEY, "1");
    else localStorage.removeItem(KEY);
    listeners.forEach((listener) => listener());
  }

  return [seen, setSeen];
}
