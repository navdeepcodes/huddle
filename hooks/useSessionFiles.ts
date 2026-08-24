"use client";

import { useEffect, useState } from "react";
import { collection, onSnapshot, query, where } from "firebase/firestore";

import { db, subscribeWhenSignedIn } from "@/lib/firebase/client";

import type { SessionFile } from "@/types/session";

export interface SessionFilesResult {
  files: SessionFile[];
  /** False until the first snapshot arrives - lets the explorer tell "hasn't loaded yet" apart from "genuinely empty" instead of flashing an empty state on every reopen. */
  loaded: boolean;
}

export function useSessionFiles(sessionId: string): SessionFilesResult {
  const [files, setFiles] = useState<SessionFile[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    // sessionId is fixed for a mounted workspace (see FileExplorer's own
    // comment - a session switch is a hard page reload), so this effect
    // only ever runs once; no reset-on-change branch is needed.
    return subscribeWhenSignedIn(() => {
      const q = query(collection(db, "sessionFiles"), where("sessionId", "==", sessionId));
      return onSnapshot(q, (snap) => {
        setFiles(snap.docs.map((d) => d.data() as SessionFile).sort((a, b) => a.path.localeCompare(b.path)));
        setLoaded(true);
      });
    });
  }, [sessionId]);

  return { files, loaded };
}
