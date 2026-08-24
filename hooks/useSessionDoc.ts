"use client";

import { useEffect, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";

import { db, subscribeWhenSignedIn } from "@/lib/firebase/client";

import type { Session } from "@/types/session";

export function useSessionDoc(sessionId: string): Session | null {
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    return subscribeWhenSignedIn(() =>
      onSnapshot(doc(db, "sessions", sessionId), (snap) => {
        setSession(snap.exists() ? (snap.data() as Session) : null);
      })
    );
  }, [sessionId]);

  return session;
}
