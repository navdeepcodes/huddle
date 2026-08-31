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
const constructedClients: Array<{ apiKey: string | undefined; maxRetries: number | undefined; instance: unknown }> = [];

vi.mock("openai", () => {
  class FakeOpenAI {
    apiKey: string | undefined;
    chat: { completions: { create: ReturnType<typeof vi.fn> } };
    constructor(opts: { apiKey?: string; maxRetries?: number }) {
      this.apiKey = opts.apiKey;
      constructedClients.push({ apiKey: opts.apiKey, maxRetries: opts.maxRetries, instance: this });
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

    // Phase 41C: each resolution now legitimately builds TWO clients
    // (Ultra + Lightning fallback), both bound to that same user's key -
    // 4 total, not 2. The security property under test is unchanged:
    // no client built for A is ever the same instance as one built for B.
    expect(constructedClients).toHaveLength(4);
    const aClients = constructedClients.filter((c) => c.apiKey === "nvapi-KEY-A");
    const bClients = constructedClients.filter((c) => c.apiKey === "nvapi-KEY-B");
    expect(aClients).toHaveLength(2);
    expect(bClients).toHaveLength(2);
    for (const a of aClients) for (const b of bClients) expect(a.instance).not.toBe(b.instance);
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

  /**
   * Phase 40B §E: retries have exactly one owner - generateStepWithRecovery's
   * outer ladder (see providerRecovery.test.ts). The SDK client itself
   * must stay at maxRetries: 0 forever, or the two ladders multiply
   * again exactly as Phase 40 §9 found and removed.
   */
  it("E. the underlying OpenAI client is constructed with maxRetries: 0 - the SDK never retries on its own", async () => {
    credentials.set("user-a", "nvapi-KEY-A");
    await resolveAgentProviders("user-a");

    // Phase 41C: two clients now (Ultra + Lightning) - both must hold
    // this invariant, not just the primary.
    expect(constructedClients).toHaveLength(2);
    for (const c of constructedClients) expect(c.maxRetries).toBe(0);
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

  /**
   * 2026-08-28: DeepSeek used to be appended here unconditionally as a
   * fallback. Live evidence proved it could never succeed once
   * Nemotron (thinking enabled) had produced reasoning - DeepSeek
   * rejects the next request with `400 The reasoning_content in the
   * thinking mode must be passed back to the API`, so the only thing
   * the fallback ever did was replace Nemotron's real failure with a
   * misleading DeepSeek one.
   *
   * Phase 41C: a real fallback IS registered again - Nemotron Lightning,
   * not DeepSeek. Phase 41A benchmarked it directly against Ultra (9/9
   * successful calls, dramatically lower latency) before this was added;
   * a wider bake-off found no other NVIDIA free-endpoint candidate
   * currently usable. This test now locks in "Ultra + Lightning, still
   * never DeepSeek" instead of "Ultra alone."
   */
  it("registers Ultra + Lightning as the two providers - never DeepSeek", async () => {
    credentials.set("user-a", "nvapi-KEY-A");
    const { providers } = await resolveAgentProviders("user-a");
    expect(providers.map((p) => p.id)).toEqual(["nvidia", "nvidia-lightning"]);
    expect(providers.map((p) => p.id)).not.toContain("deepseek");
  });

  /**
   * Phase 41C §6: Lightning must get a SMALLER attempt budget than
   * Ultra's default (4) - "do not increase retry counts." Ultra keeps
   * no explicit override (uses providerRecovery's own default), so this
   * pins the one number that actually matters: Lightning's is 2, not 4
   * and not unset.
   */
  it("Lightning is configured with the verified model id and a bounded 2-attempt budget, distinct from Ultra's default", async () => {
    credentials.set("user-a", "nvapi-KEY-A");
    const { providers } = await resolveAgentProviders("user-a");

    const ultra = providers.find((p) => p.id === "nvidia")!;
    const lightning = providers.find((p) => p.id === "nvidia-lightning")!;

    expect(ultra.model).toBe("nvidia/nemotron-3-ultra-550b-a55b");
    expect(ultra.maxAttempts).toBeUndefined(); // uses the shared default (4)

    expect(lightning.model).toBe("nvidia/nemotron-3.5-lightning-30b-a3b");
    expect(lightning.maxAttempts).toBe(2);
  });

  it("returns an EMPTY provider list when no Nemotron credential resolves - never a fallback that cannot work", async () => {
    delete process.env.NVIDIA_API_KEY;
    const { providers } = await resolveAgentProviders("user-with-nothing");
    // The routes' own 422 ("No Nemotron API key is configured") keys off
    // exactly this - an empty list, not a list containing a doomed provider.
    expect(providers).toHaveLength(0);
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

    // The underlying OpenAI client itself was only ever constructed once
    // PER PROVIDER for this resolution - the retry reused the Ultra
    // client, it didn't build a new one (let alone one bound to a
    // different key). Phase 41C: resolution now legitimately builds TWO
    // clients for user A (Ultra + Lightning fallback), both bound to A's
    // key - the invariant under test (no THIRD, no different key) still
    // holds at length 2, not 1.
    expect(constructedClients.filter((c) => c.apiKey === "nvapi-KEY-A")).toHaveLength(2);
  });
});
