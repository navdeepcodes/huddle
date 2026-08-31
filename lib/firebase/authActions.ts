"use client";

import type { FirebaseError } from "firebase/app";
import { GoogleAuthProvider, linkWithPopup, signInWithCredential, type AuthCredential } from "firebase/auth";

import { auth } from "@/lib/firebase/client";

export type LinkGoogleResult =
  | { ok: true; mergedExistingAccount: boolean }
  | { ok: false; error: string; code?: string };

export interface LinkGoogleDeps {
  isAnonymous: boolean | null;
  /** Throws a FirebaseError-shaped object (a real `.code`) on failure, exactly like the real SDK call. */
  link: () => Promise<unknown>;
  signInWithLinkedCredential: (credential: AuthCredential) => Promise<unknown>;
  credentialFromError: (error: FirebaseError) => AuthCredential | null;
}

/**
 * Phase 34: the branching logic, isolated from the real Firebase calls
 * so it's testable without mocking the SDK module itself - same
 * dependency-injection shape usePresence.ts's startPresenceHeartbeat
 * already established in this codebase for exactly this reason.
 *
 * Upgrades the CURRENT anonymous user in place via link() (a real
 * linkWithPopup call - never signInWithPopup) which keeps the same
 * uid, so every session this anonymous user already owns (ownerId/
 * memberIds are just that uid - see types/session.ts) stays correctly
 * attached with zero data migration required. The one case that can't
 * be a clean in-place upgrade: auth/credential-already-in-use, when
 * this Google account is already the identity behind a DIFFERENT
 * Firebase user (e.g. linked from another browser previously).
 * Firebase has no account-merge API - silently forcing one here would
 * mean inventing data-migration code this phase explicitly forbids.
 * The honest, safe behavior: sign into that EXISTING account instead
 * (the user's real account, with its own projects) and report plainly
 * that this browser's anonymous work did not merge into it - never a
 * silent, destructive overwrite of either identity's data.
 */
export async function linkAnonymousToGoogleWith(deps: LinkGoogleDeps): Promise<LinkGoogleResult> {
  if (deps.isAnonymous === null) return { ok: false, error: "Not signed in yet - try again in a moment." };
  if (!deps.isAnonymous) return { ok: true, mergedExistingAccount: false };

  try {
    await deps.link();
    return { ok: true, mergedExistingAccount: false };
  } catch (error) {
    const firebaseError = error as FirebaseError;
    const code = firebaseError?.code;

    if (code === "auth/credential-already-in-use") {
      const credential = deps.credentialFromError(firebaseError);
      if (!credential) {
        return { ok: false, error: "That Google account is already in use and couldn't be resolved. Try a different account.", code };
      }
      try {
        await deps.signInWithLinkedCredential(credential);
        return { ok: true, mergedExistingAccount: true };
      } catch {
        return { ok: false, error: "Couldn't sign into that Google account. Try again.", code };
      }
    }

    if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") {
      return { ok: false, error: "Sign-in was cancelled." };
    }

    if (code === "auth/operation-not-allowed") {
      return { ok: false, error: "Google sign-in isn't enabled for this app yet.", code };
    }

    return { ok: false, error: "Couldn't sign in with Google. Try again.", code };
  }
}

export async function linkAnonymousToGoogle(): Promise<LinkGoogleResult> {
  return linkAnonymousToGoogleWith({
    isAnonymous: auth.currentUser?.isAnonymous ?? null,
    link: () => linkWithPopup(auth.currentUser!, new GoogleAuthProvider()),
    signInWithLinkedCredential: (credential) => signInWithCredential(auth, credential),
    credentialFromError: (error) => GoogleAuthProvider.credentialFromError(error),
  });
}
