import "server-only";

import { adminDb } from "@/lib/firebase/admin";
import { encryptCredential, decryptCredential } from "@/lib/credentials/crypto";

export type CredentialProvider = "nemotron";

interface CredentialDoc {
  uid: string;
  provider: CredentialProvider;
  ciphertext: string;
  iv: string;
  authTag: string;
  updatedAt: number;
}

/**
 * Phase 29: the ONLY place a user's raw Nemotron key is ever
 * written, read, or decrypted. This file is server-only (both by the
 * "server-only" import guard and because it uses adminDb, which
 * throws in a browser bundle) - nothing here is importable from a
 * client component. Firestore rules deny all client access to
 * `userCredentials` (deny-by-default catch-all, same as every other
 * Huddle collection); this module is the sole caller of the Admin SDK
 * against it. No API route ever returns a value this module produces
 * except `getCredentialStatus`'s boolean.
 */
function docId(uid: string, provider: CredentialProvider): string {
  return `${uid}_${provider}`;
}

export async function getCredentialStatus(uid: string, provider: CredentialProvider): Promise<boolean> {
  const snap = await adminDb.collection("userCredentials").doc(docId(uid, provider)).get();
  return snap.exists;
}

export async function setCredential(uid: string, provider: CredentialProvider, rawKey: string): Promise<void> {
  const { ciphertext, iv, authTag } = encryptCredential(rawKey);
  const doc: CredentialDoc = { uid, provider, ciphertext, iv, authTag, updatedAt: Date.now() };
  await adminDb.collection("userCredentials").doc(docId(uid, provider)).set(doc);
}

export async function deleteCredential(uid: string, provider: CredentialProvider): Promise<void> {
  await adminDb.collection("userCredentials").doc(docId(uid, provider)).delete();
}

/**
 * The only function that ever decrypts a raw key. Returns null if the
 * user has no credential configured for this provider - callers
 * decide what "no credential" means (platform fallback, clean error,
 * etc.), this function makes no policy decision of its own. Never
 * logs, never included in a returned object beyond the immediate
 * caller's own use of the string.
 */
export async function resolveCredential(uid: string, provider: CredentialProvider): Promise<string | null> {
  const snap = await adminDb.collection("userCredentials").doc(docId(uid, provider)).get();
  if (!snap.exists) return null;
  const data = snap.data() as CredentialDoc;
  return decryptCredential({ ciphertext: data.ciphertext, iv: data.iv, authTag: data.authTag });
}
