"use client";

import { useEffect } from "react";

import { ensureSignedIn } from "@/lib/firebase/client";

/** Fires anonymous sign-in as early as possible on any page load (e.g. a direct refresh of /session/[id], not just the New Session flow) so Firestore reads don't race auth. */
export default function AuthBoot() {
  useEffect(() => {
    void ensureSignedIn();
  }, []);

  return null;
}
