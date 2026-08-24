"use client";

import { useEffect, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";

import { db, subscribeWhenSignedIn } from "@/lib/firebase/client";

import type { AgentTurn } from "@/types/session";

export function useAgentTurn(sessionId: string): AgentTurn | null {
  const [turn, setTurn] = useState<AgentTurn | null>(null);

  useEffect(() => {
    return subscribeWhenSignedIn(() =>
      onSnapshot(doc(db, "agentTurns", sessionId), (snap) => {
        setTurn(snap.exists() ? (snap.data() as AgentTurn) : null);
      })
    );
  }, [sessionId]);

  return turn;
}
