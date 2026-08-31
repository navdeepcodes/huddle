"use client";

import { useEffect, useState } from "react";
import { onAuthStateChanged, type User } from "firebase/auth";

import { auth } from "@/lib/firebase/client";

export type AuthState =
  | { status: "loading" }
  | { status: "signed-out" }
  | { status: "anonymous"; user: User }
  | { status: "authenticated"; user: User };

/**
 * Phase 34: a read-only presentation layer over Firebase Auth's own
 * onAuthStateChanged - distinct from client.ts's ensureSignedIn(),
 * which actively FORCES anonymous sign-in and exists for data hooks
 * that need a uid to subscribe with. This hook never signs anyone in;
 * it only reports what's already true, so the entry flow can tell
 * "nothing resolved yet" (loading) apart from "no session at all"
 * (signed-out - only reachable right after an explicit sign-out, since
 * AuthBoot immediately re-triggers anonymous sign-in) apart from an
 * anonymous identity vs a real provider identity.
 */
export function useAuthState(): AuthState {
  const [state, setState] = useState<AuthState>({ status: "loading" });

  useEffect(() => {
    return onAuthStateChanged(auth, (user) => {
      if (!user) {
        setState({ status: "signed-out" });
        return;
      }
      setState({ status: user.isAnonymous ? "anonymous" : "authenticated", user });
    });
  }, []);

  return state;
}
