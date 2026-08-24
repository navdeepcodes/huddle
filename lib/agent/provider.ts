import "server-only";

import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionMessage,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

/**
 * The shape any model provider capable of running Huddle's agent loop
 * is implemented against. Ported from apostle's lib/ai/agentProvider.ts
 * (proven, real, live-confirmed cross-provider quirks - see
 * sanitizeAgentMessage below) with the multi-provider fallback registry
 * deliberately left out: v1 registers exactly one provider (DeepSeek).
 * The interface stays pluggable so a future provider is a new file, not
 * a rewrite.
 */

export interface AgentStepUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface AgentStepResult {
  message: ChatCompletionAssistantMessageParam;
  truncated: boolean;
  usage: AgentStepUsage | null;
}

export type AgentProviderFailureKind =
  | "timeout"
  | "rate_limited"
  | "auth"
  | "network"
  | "malformed_response"
  | "cancelled"
  | "unknown";

export class AgentProviderError extends Error {
  readonly provider: string;
  readonly kind: AgentProviderFailureKind;
  readonly retryable: boolean;
  readonly cause?: unknown;

  constructor(
    provider: string,
    kind: AgentProviderFailureKind,
    message: string,
    retryable: boolean,
    cause?: unknown
  ) {
    super(message);
    this.name = "AgentProviderError";
    this.provider = provider;
    this.kind = kind;
    this.retryable = retryable;
    this.cause = cause;
  }
}

export interface AgentModelProvider {
  readonly id: string;
  readonly displayName: string;
  readonly model: string;

  generateStep(
    messages: ChatCompletionMessageParam[],
    tools: ChatCompletionTool[],
    signal?: AbortSignal
  ): Promise<AgentStepResult>;
}

/**
 * Strips a provider's raw response message down to the plain, standard
 * OpenAI assistant-message shape. Kept from apostle verbatim: this is a
 * real, live-confirmed cross-provider incompatibility (DeepSeek's
 * `reasoning_content` gets rejected by Groq/Mistral, Groq also rejects
 * `refusal`), not a defensive guess - rediscovering it would waste real
 * time for zero benefit even though v1 only has one provider, because
 * the day a second provider is added this is exactly what prevents a
 * silent 400 on the first replayed message.
 */
export function sanitizeAgentMessage(
  message: ChatCompletionMessage
): ChatCompletionAssistantMessageParam {
  const toolCalls = message.tool_calls?.filter(
    (call): call is Extract<
      NonNullable<ChatCompletionMessage["tool_calls"]>[number],
      { type: "function" }
    > => call.type === "function"
  );

  return {
    role: "assistant",
    content: message.content ?? null,
    ...(toolCalls && toolCalls.length > 0
      ? {
          tool_calls: toolCalls.map((call) => ({
            id: call.id,
            type: "function" as const,
            function: {
              name: call.function.name,
              arguments: call.function.arguments,
            },
          })),
        }
      : {}),
  };
}

export function classifyAgentProviderFailure(
  error: unknown,
  signal?: AbortSignal
): { kind: AgentProviderFailureKind; retryable: boolean } {
  if (signal?.aborted) {
    return { kind: "cancelled", retryable: false };
  }

  const status =
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof (error as { status: unknown }).status === "number"
      ? (error as { status: number }).status
      : null;

  const name = error instanceof Error ? error.name : undefined;

  if (name === "APIUserAbortError" || name === "AbortError") {
    return { kind: "cancelled", retryable: false };
  }

  if (
    name === "APIConnectionTimeoutError" ||
    (error instanceof Error && /timed?\s?out/i.test(error.message))
  ) {
    return { kind: "timeout", retryable: true };
  }

  if (status === 429) {
    return { kind: "rate_limited", retryable: true };
  }

  if (status === 401 || status === 403) {
    return { kind: "auth", retryable: false };
  }

  if (status !== null && status >= 500) {
    return { kind: "network", retryable: true };
  }

  if (
    name === "APIConnectionError" ||
    (error instanceof Error &&
      /network|ECONNRESET|ENOTFOUND|ECONNREFUSED|fetch failed/i.test(
        error.message
      ))
  ) {
    return { kind: "network", retryable: true };
  }

  if (status !== null && status >= 400) {
    return { kind: "malformed_response", retryable: true };
  }

  return { kind: "unknown", retryable: true };
}
