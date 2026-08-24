import "server-only";

/**
 * In-memory map of the one AbortController per currently-running turn,
 * keyed by sessionId - what makes the turn server-owned and decoupled
 * from the originating HTTP request: POST /turn starts the loop
 * detached (doesn't await it), and POST /turn/cancel looks it up here
 * to abort it. A dev-server or serverless-instance restart loses this
 * map, same known tradeoff as apostle's equivalent - acceptable for
 * v1, revisit only if it's ever a real observed problem.
 */
const activeControllers = new Map<string, AbortController>();

export function registerTurn(sessionId: string): AbortController {
  const controller = new AbortController();
  activeControllers.set(sessionId, controller);
  return controller;
}

export function unregisterTurn(sessionId: string): void {
  activeControllers.delete(sessionId);
}

export function cancelTurn(sessionId: string): boolean {
  const controller = activeControllers.get(sessionId);
  if (!controller) return false;
  controller.abort();
  return true;
}

export function isTurnActive(sessionId: string): boolean {
  return activeControllers.has(sessionId);
}
