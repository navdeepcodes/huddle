import { describe, expect, it, beforeAll } from "vitest";

describe("encryptCredential / decryptCredential (Phase 29)", () => {
  beforeAll(() => {
    process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  });

  it("round-trips a real API-key-shaped string exactly", async () => {
    const { encryptCredential, decryptCredential } = await import("@/lib/credentials/crypto");
    const raw = "nvapi-abc123DEF456ghiJKL789";
    const encrypted = encryptCredential(raw);
    expect(decryptCredential(encrypted)).toBe(raw);
  });

  it("never stores the plaintext anywhere in the encrypted output", async () => {
    const { encryptCredential } = await import("@/lib/credentials/crypto");
    const raw = "nvapi-super-secret-value-12345";
    const encrypted = encryptCredential(raw);
    expect(encrypted.ciphertext).not.toContain(raw);
    expect(JSON.stringify(encrypted)).not.toContain(raw);
  });

  it("produces a different ciphertext each time (random IV) even for the same input", async () => {
    const { encryptCredential } = await import("@/lib/credentials/crypto");
    const a = encryptCredential("same-key-value");
    const b = encryptCredential("same-key-value");
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.iv).not.toBe(b.iv);
  });

  it("throws rather than silently decrypting when the ciphertext was tampered with", async () => {
    const { encryptCredential, decryptCredential } = await import("@/lib/credentials/crypto");
    const encrypted = encryptCredential("nvapi-real-key");
    const tampered = { ...encrypted, ciphertext: Buffer.from("tampered-data-here").toString("base64") };
    expect(() => decryptCredential(tampered)).toThrow();
  });

  it("throws rather than silently decrypting with the wrong auth tag", async () => {
    const { encryptCredential, decryptCredential } = await import("@/lib/credentials/crypto");
    const encrypted = encryptCredential("nvapi-real-key");
    const otherAuthTag = encryptCredential("different-value").authTag;
    expect(() => decryptCredential({ ...encrypted, authTag: otherAuthTag })).toThrow();
  });
});
