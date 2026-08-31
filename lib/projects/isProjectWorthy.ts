import type { Session } from "@/types/session";

/**
 * Phase 37: the authoritative "is this a Project" check, used to split
 * the dashboard into "Your Projects" and "Recent creations." Trivial
 * on purpose - see Session.hasRealFiles's own doc comment for why one
 * boolean, set from real file activity, is the whole signal.
 */
export function isProjectWorthy(session: Session): boolean {
  return session.hasRealFiles === true;
}
