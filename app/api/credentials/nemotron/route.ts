import { NextRequest, NextResponse } from "next/server";

import { getVerifiedUid } from "@/lib/auth/verifyRequest";
import { getCredentialStatus, setCredential, deleteCredential } from "@/lib/credentials/credentialStore";

const PROVIDER = "nemotron" as const;

/**
 * Phase 29: the browser's only interface to a user's Nemotron
 * credential. Every method verifies the request's own Firebase ID
 * token (getVerifiedUid) and acts ONLY on that uid - there is no
 * "target uid" parameter anywhere in this route, by construction, so
 * a user modifying someone else's credential isn't a check that can
 * be forgotten, it's a request shape that doesn't exist. GET never
 * returns the key itself, only whether one is configured.
 */
export async function GET(request: NextRequest) {
  const uid = await getVerifiedUid(request);
  if (!uid) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const configured = await getCredentialStatus(uid, PROVIDER);
  return NextResponse.json({ configured, provider: PROVIDER });
}

export async function PUT(request: NextRequest) {
  const uid = await getVerifiedUid(request);
  if (!uid) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const { key } = await request.json();
  if (typeof key !== "string" || !key.trim()) {
    return NextResponse.json({ error: "key is required." }, { status: 400 });
  }
  // A bound, not a validation call against the provider - see this
  // phase's own "do not validate by making unnecessary model calls"
  // instruction. Just enough to reject an obviously-wrong paste (an
  // empty string after trimming, or something absurdly long) without
  // ever inspecting or logging the value itself.
  if (key.trim().length > 512) {
    return NextResponse.json({ error: "That doesn't look like a valid API key." }, { status: 400 });
  }

  await setCredential(uid, PROVIDER, key.trim());
  return NextResponse.json({ configured: true, provider: PROVIDER });
}

export async function DELETE(request: NextRequest) {
  const uid = await getVerifiedUid(request);
  if (!uid) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  await deleteCredential(uid, PROVIDER);
  return NextResponse.json({ configured: false, provider: PROVIDER });
}
