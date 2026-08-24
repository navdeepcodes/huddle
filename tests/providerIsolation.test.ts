import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Phase 29 Part 9/13 (CRITICAL security test): proves the actual
 * OpenAI SDK client built for a request is bound to the REQUESTING
 * user's own credential and no one else's - not just that
 * resolveAgentProviders *looks* correct by inspection, but that the
 * concrete client object created for user A's turn, when asked to
 * make a request, would authenticate as A, and likewise for B,
 * independently and without any shared mutable state between them.
 * Mocks the "openai" package itself (capturing the apiKey each
 * constructed client instance was given) rather than making real
 * network calls - this is what "the provider receives key A" can
 * actually mean without hitting NVIDIA's real API in a test suite.
 */
const constructedClients: Array<{ apiKey: string | undefined; instance: unknown }> = [];

vi.mock("openai", () => {
  class FakeOpenAI {
    apiKey: string | undefined;
    chat: { completions: { create: ReturnType<typeof vi.fn> } };
    constructor(opts: { apiKey?: string }) {
      this.apiKey = opts.apiKey;
      constructedClients.push({ apiKey: opts.apiKey, instance: this });
      this.chat = {
        completions: {
          create: vi.fn().mockImplementation(async () => ({
            choices: [{ message: { role: "assistant", content: `responded using key: ${this.apiKey}` }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })),
        },
      };
    }
  }
  return { default: FakeOpenAI };
});

const credentials = new Map<string, string>();
vi.mock("@/lib/credentials/credentialStore", () => ({
  resolveCredential: vi.fn().mockImplementation(async (uid: string) => credentials.get(uid) ?? null),
}));

beforeEach(() => {
  constructedClients.length = 0;
  credentials.clear();
  process.env.NVIDIA_API_KEY = "platform-fallback-key";
});

const { resolveAgentProviders } = await import("@/lib/agent/providerResolution");

describe("Provider credential isolation (Phase 29 Part 9 - CRITICAL)", () => {
  it("User A's resolved Nemotron client is bound to A's own key", async () => {
    credentials.set("user-a", "nvapi-KEY-A");
    const { providers, nemotronSource } = await resolveAgentProviders("user-a");
    expect(nemotronSource).toBe("personal");

    const nemotron = providers.find((p) => p.id === "nvidia")!;
    const result = await nemotron.generateStep([], []);
    expect(result.message.content).toContain("nvapi-KEY-A");
  });

  it("User B's resolved Nemotron client is bound to B's own key, independent of A", async () => {
    credentials.set("user-a", "nvapi-KEY-A");
    credentials.set("user-b", "nvapi-KEY-B");

    const a = await resolveAgentProviders("user-a");
    const b = await resolveAgentProviders("user-b");

    const aResult = await a.providers.find((p) => p.id === "nvidia")!.generateStep([], []);
    const bResult = await b.providers.find((p) => p.id === "nvidia")!.generateStep([], []);

    expect(aResult.message.content).toContain("nvapi-KEY-A");
    expect(bResult.message.content).toContain("nvapi-KEY-B");
    expect(aResult.message.content).not.toContain("KEY-B");
    expect(bResult.message.content).not.toContain("KEY-A");
  });

  it("CRITICAL: no two resolved providers for different users ever share the same constructed client instance", async () => {
    credentials.set("user-a", "nvapi-KEY-A");
    credentials.set("user-b", "nvapi-KEY-B");

    await resolveAgentProviders("user-a");
    await resolveAgentProviders("user-b");

    expect(constructedClients).toHaveLength(2);
    expect(constructedClients[0].instance).not.toBe(constructedClients[1].instance);
    expect(constructedClients[0].apiKey).toBe("nvapi-KEY-A");
    expect(constructedClients[1].apiKey).toBe("nvapi-KEY-B");
  });

  it("CRITICAL: resolving providers for the same user twice in a row still uses that user's own key both times, never drifting to a stale or different value", async () => {
    credentials.set("user-a", "nvapi-KEY-A");
    const first = await resolveAgentProviders("user-a");
    const second = await resolveAgentProviders("user-a");

    const firstResult = await first.providers.find((p) => p.id === "nvidia")!.generateStep([], []);
    const secondResult = await second.providers.find((p) => p.id === "nvidia")!.generateStep([], []);

    expect(firstResult.message.content).toContain("nvapi-KEY-A");
    expect(secondResult.message.content).toContain("nvapi-KEY-A");
  });

  it("a user with no personal key falls back to the platform credential, not another user's key", async () => {
    credentials.set("user-a", "nvapi-KEY-A");
    // user-c has no personal key configured.
    const { providers, nemotronSource } = await resolveAgentProviders("user-c");
    expect(nemotronSource).toBe("platform");

    const result = await providers.find((p) => p.id === "nvidia")!.generateStep([], []);
    expect(result.message.content).toContain("platform-fallback-key");
    expect(result.message.content).not.toContain("KEY-A");
  });

  it("reports nemotronSource 'unavailable' when neither a personal nor a platform key exists, and no Nemotron provider is included", async () => {
    delete process.env.NVIDIA_API_KEY;
    const { providers, nemotronSource } = await resolveAgentProviders("user-with-nothing");
    expect(nemotronSource).toBe("unavailable");
    expect(providers.find((p) => p.id === "nvidia")).toBeUndefined();
  });
});

describe("Provider retry stays on the same user's credential (Phase 29 Part 10 - CRITICAL)", () => {
  it("a transient failure followed by a retry uses the SAME resolved client - never falls through to a different user's key", async () => {
    credentials.set("user-a", "nvapi-KEY-A");
    const { AgentProviderError } = await import("@/lib/agent/provider");
    const { generateStepWithRecovery } = await import("@/lib/agent/providerRecovery");

    const { providers } = await resolveAgentProviders("user-a");
    const nemotron = providers.find((p) => p.id === "nvidia")!;

    // Force the first attempt to fail transiently (retryable), the second to succeed.
    let callCount = 0;
    const realGenerateStep = nemotron.generateStep.bind(nemotron);
    nemotron.generateStep = async (...args: Parameters<typeof realGenerateStep>) => {
      callCount++;
      if (callCount === 1) {
        throw new AgentProviderError("nvidia", "network", "transient failure", true);
      }
      return realGenerateStep(...args);
    };

    const result = await generateStepWithRecovery([nemotron], [], [], undefined, async () => {});

    expect(callCount).toBe(2); // one failure, one retry - both against the same provider object
    expect(result.step.message.content).toContain("nvapi-KEY-A"); // the retry's actual response still came from A's client
    expect(result.attempts).toBe(2);

    // The underlying OpenAI client itself was only ever constructed once for this resolution - the retry reused it, it didn't build a new one (let alone one bound to a different key).
    expect(constructedClients.filter((c) => c.apiKey === "nvapi-KEY-A")).toHaveLength(1);
  });
});
