import { auth, ensureSignedIn } from "@/lib/firebase/client";

/** fetch() with the signed-in user's Firebase ID token attached - every API route verifies this server-side via lib/auth/verifyRequest.ts. */
export async function authedFetch(input: string, init?: RequestInit): Promise<Response> {
  await ensureSignedIn();
  const token = await auth.currentUser?.getIdToken();

  return fetch(input, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
}
