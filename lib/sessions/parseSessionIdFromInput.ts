/**
 * Phase 34 PART 4 step 4 ("Join a project"): accepts either a full
 * share URL (whatever navigateToSession's window.location.href
 * produced) or a bare session id pasted directly, and reuses the
 * EXISTING join-by-URL mechanism (visiting /session/[id] triggers
 * useSessionJoin's POST .../join - see joinSession.ts) rather than
 * building a second invite/lookup system.
 */
export function parseSessionIdFromInput(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;

  const match = value.match(/\/session\/([^/?#]+)/);
  if (match) return match[1];

  return /^[A-Za-z0-9_-]+$/.test(value) ? value : null;
}
