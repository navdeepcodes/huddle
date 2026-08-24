import { initializeApp, getApps, getApp } from "firebase/app";
import { getAuth, signInAnonymously, onAuthStateChanged, type User } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

export const firebaseApp = getApps().length ? getApp() : initializeApp(firebaseConfig);
export const db = getFirestore(firebaseApp);
export const auth = getAuth(firebaseApp);

/**
 * v1 has no login UI in scope - every visitor gets a real Firebase
 * Anonymous Auth uid, which is what session ownership/rules are keyed
 * on. Swapping in real sign-in later doesn't change the data model,
 * only how a uid gets minted.
 *
 * Memoized module-level: every caller (authedFetch, and every
 * Firestore-subscribing hook below) awaits the SAME promise instead of
 * each racing its own onAuthStateChanged listener / signInAnonymously
 * call. Confirmed live (2026-08-21) that skipping this on a genuinely
 * fresh browser - no cached auth state - let every onSnapshot listener
 * in the app (session doc, files, agent turn, runtime host, and
 * RuntimeSession's own file/command subscriptions) fire before
 * anonymous sign-in ever started, all rejected with
 * permission-denied. authedFetch already awaited ensureSignedIn, which
 * masked this everywhere sign-in happened to already be cached from
 * an earlier visit - it only surfaces on a true first load.
 */
let signedInPromise: Promise<User> | null = null;

export function ensureSignedIn(): Promise<User> {
  if (!signedInPromise) {
    signedInPromise = new Promise((resolve, reject) => {
      const unsubscribe = onAuthStateChanged(
        auth,
        (user) => {
          if (user) {
            unsubscribe();
            resolve(user);
            return;
          }
          signInAnonymously(auth).catch((error) => {
            unsubscribe();
            signedInPromise = null;
            reject(error);
          });
        },
        (error) => {
          signedInPromise = null;
          reject(error);
        }
      );
    });
  }
  return signedInPromise;
}

/** Same value and reasoning as runtimeSession.ts's RECONNECT_DEBOUNCE_MS - not imported from there since that module is runtime-specific and this one is deliberately generic. */
const RESUBSCRIBE_DEBOUNCE_MS = 2_000;

/**
 * Wraps a Firestore subscription so it only attaches once anonymous
 * sign-in has actually resolved, instead of racing it. Returns a
 * cleanup function suitable for returning directly from a useEffect -
 * handles the case where the component unmounts (or sessionId changes)
 * before ensureSignedIn() resolves, so a stale subscription never
 * attaches after the fact.
 *
 * Phase 27 Part B/I.4: also re-subscribes on visibilitychange, for the
 * same root cause runtimeSession.ts's reconnectListeners already
 * documents and fixes for the runtime's own listeners - the modern
 * Firestore Web SDK's IndexedDB-backed onSnapshot can be silently
 * killed by a backgrounded tab with no error routed to the listener's
 * callback (confirmed live: useSessionFiles's listener died this way
 * and never recovered, leaving a viewer's file tree/content frozen
 * indefinitely with no visible sign anything was wrong - a fresh tab
 * on the same session showed the current content immediately). Phase
 * 22/23 only fixed this for RuntimeSession's own internal files/
 * commands subscriptions (needed to keep the WebContainer itself
 * fed); every hook that goes through this shared wrapper - session
 * doc, files, agent turn - gets the same recovery from one place
 * instead of three separate copies of the same reconnect logic.
 *
 * Phase 28 Part 7: also re-subscribes when `auth.currentUser`'s uid
 * itself changes, not just on visibilitychange - confirmed live in
 * a two-tab test session where a tab's identity was silently swapped
 * by Firebase Auth's own cross-tab persistence sync (a second tab of
 * the same origin signing in rewrites the shared IndexedDB auth
 * record, and every tab watching that record picks up the new user -
 * by design, for a normal multi-account-switch use case, but a live
 * hazard here since two anonymous identities in one browser profile
 * share that same record). The already-open query listener kept
 * delivering updates to documents it already held (existing file
 * modifications synced fine) but silently stopped receiving
 * newly-added documents (a brand new file, or a new nested path,
 * never appeared) - consistent with the listener's watch state being
 * partially stale under the rug-pulled auth context, not a hard
 * error, so nothing routed to a listener error callback either.
 * Guarded on the uid actually changing (not on every token refresh
 * onAuthStateChanged also fires for) so a healthy listener isn't
 * torn down and rebuilt on routine background token renewal.
 */
export function subscribeWhenSignedIn(subscribe: () => () => void): () => void {
  let unsubscribe: (() => void) | undefined;
  let cancelled = false;
  let lastResubscribeAt: number | null = null;
  let lastUid: string | null = null;

  function attach() {
    ensureSignedIn()
      .then((user) => {
        lastUid = user.uid;
        if (!cancelled) unsubscribe = subscribe();
      })
      .catch(() => {});
  }

  function resubscribeIfDue() {
    if (cancelled) return;
    const now = Date.now();
    if (lastResubscribeAt !== null && now - lastResubscribeAt < RESUBSCRIBE_DEBOUNCE_MS) return;
    lastResubscribeAt = now;
    unsubscribe?.();
    attach();
  }

  function handleVisibilityChange() {
    if (document.visibilityState === "visible") resubscribeIfDue();
  }

  function handleAuthStateChanged(user: User | null) {
    if (user && user.uid !== lastUid) resubscribeIfDue();
  }

  attach();
  document.addEventListener("visibilitychange", handleVisibilityChange);
  const unsubscribeAuth = onAuthStateChanged(auth, handleAuthStateChanged);

  return () => {
    cancelled = true;
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    unsubscribeAuth();
    unsubscribe?.();
  };
}
