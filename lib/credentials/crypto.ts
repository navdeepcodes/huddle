import "server-only";

import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

/**
 * Phase 29: at-rest encryption for a user's personal Nemotron API key.
 * Firestore security rules already deny ALL client access to the
 * collection this protects (deny-by-default catch-all, same as every
 * other Huddle collection - see firestore.rules), so this is defense
 * in depth, not the only barrier: it protects the raw key even against
 * direct Firestore console/export access, a future rules regression,
 * or an unrelated Admin-SDK credential compromise elsewhere in the
 * shared apostle-e3c23 project. AES-256-GCM via Node's built-in
 * crypto - no new dependency, no client-derivable key (the encryption
 * key is CREDENTIAL_ENCRYPTION_KEY, a server-only env var, never sent
 * to the browser) - explicitly NOT the "encrypted with a client-
 * visible key" pattern that would be no real protection at all.
 */
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // standard/recommended for GCM

function getKey(): Buffer {
  const raw = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error("CREDENTIAL_ENCRYPTION_KEY is not configured - cannot store or read user credentials.");
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("CREDENTIAL_ENCRYPTION_KEY must decode to exactly 32 bytes for AES-256-GCM.");
  }
  return key;
}

export interface EncryptedCredential {
  ciphertext: string; // base64
  iv: string; // base64
  authTag: string; // base64
}

export function encryptCredential(plaintext: string): EncryptedCredential {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

/** Throws if the ciphertext/authTag don't match (tampered or wrong key) - never returns a partially-decrypted or garbage value. */
export function decryptCredential(encrypted: EncryptedCredential): string {
  const decipher = createDecipheriv(ALGORITHM, getKey(), Buffer.from(encrypted.iv, "base64"));
  decipher.setAuthTag(Buffer.from(encrypted.authTag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}
