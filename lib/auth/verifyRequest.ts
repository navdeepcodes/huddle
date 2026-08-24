import "server-only";

import type { NextRequest } from "next/server";

import { adminAuth } from "@/lib/firebase/admin";

/**
 * Verifies the request's `Authorization: Bearer <idToken>` header
 * against Firebase Admin and returns the caller's uid, or null if
 * missing/invalid/expired. Never trust a client-supplied uid - this is
 * the only source of truth for "who is making this request".
 */
export async function getVerifiedUid(request: NextRequest): Promise<string | null> {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;

  const token = header.slice(7).trim();
  if (!token) return null;

  try {
    const decoded = await adminAuth.verifyIdToken(token);
    return decoded.uid;
  } catch (error) {
    console.error("Token verification failed:", error);
    return null;
  }
}
