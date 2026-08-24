import "server-only";

/**
 * Phase 26: the shape any vision-critique backend is implemented
 * against - deliberately NOT AgentModelProvider (lib/agent/provider.ts):
 * that interface is shaped for the agent's tool-calling text loop
 * (messages history, tools, an assistant step with tool_calls) which a
 * one-shot image+prompt->critique call doesn't need and shouldn't be
 * forced into. What IS reused directly (not duplicated) is
 * AgentProviderError and classifyAgentProviderFailure - both already
 * generic, not agent-loop-specific - so vision failures get the exact
 * same retryable/kind classification discipline as agent-step failures,
 * via the same code.
 */
export interface VisionProvider {
  readonly id: string;
  readonly displayName: string;
  /** Throws AgentProviderError on any failure - never returns a failure as a value, matching AgentModelProvider.generateStep's own convention. */
  analyze(dataUrl: string, prompt: string): Promise<string>;
}
