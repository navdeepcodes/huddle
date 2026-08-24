"use client";

import { useSyncExternalStore } from "react";

/**
 * Phase 32: the one thing gating "mobile companion" vs "desktop
 * workspace" - a real width check (matchMedia, live-updating on
 * resize/rotate), not a CSS-only responsive collapse. The desktop
 * workspace is explicitly NOT made responsive this phase (product
 * requirement) - this hook is what lets the two route trees pick a
 * genuinely different component, not a squeezed layout of the same one.
 *
 * Breakpoint at 1024px (not Tailwind's 768px `md`): the brief's own
 * required verification viewports include 768x1024 as a MOBILE
 * viewport (a large phone/small tablet, judged by companion-app
 * treatment, not desktop IDE treatment), so mobile must still win at
 * 768px wide - only >=1024 gets the desktop three-pane workspace.
 *
 * useSyncExternalStore, not useState+useEffect: this is React's own
 * sanctioned primitive for "subscribe to an external mutable source"
 * (matchMedia here), and it's what correctly avoids a hydration
 * mismatch - getServerSnapshot always returns false (matching what SSR
 * rendered, since there's no window there), and React itself re-checks
 * getSnapshot right after hydration and re-renders if the real client
 * value differs, no manual effect/setState needed.
 */
const MOBILE_BREAKPOINT_PX = 1024;

function getMediaQuery(): MediaQueryList | null {
  return typeof window === "undefined" ? null : window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_PX - 1}px)`);
}

function subscribe(callback: () => void): () => void {
  const mql = getMediaQuery();
  if (!mql) return () => {};
  mql.addEventListener("change", callback);
  return () => mql.removeEventListener("change", callback);
}

function getSnapshot(): boolean {
  return getMediaQuery()?.matches ?? false;
}

function getServerSnapshot(): boolean {
  return false;
}

export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
