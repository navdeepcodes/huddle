import "server-only";

/**
 * Phase 29 Part 8: the ONLY provider-call logging in the app. Deliberately
 * narrow - exactly the fields the brief calls "useful telemetry," nothing
 * else. Never pass this function a prompt, a full request/response body,
 * or anything derived from an API key; there's no parameter shape here
 * that would even accept one, so a future caller can't accidentally leak
 * one through this path.
 */
export interface ProviderCallTelemetry {
  uid: string;
  sessionId: string;
  provider: string;
  model: string;
  turnId: string;
  success: boolean;
  latencyMs: number;
  attempts: number;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
}

export function logProviderCall(entry: ProviderCallTelemetry): void {
  console.log("[Huddle][provider-telemetry]", JSON.stringify(entry));
}
