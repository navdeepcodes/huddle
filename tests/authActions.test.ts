import { describe, expect, it, vi } from "vitest";

import { linkAnonymousToGoogleWith, type LinkGoogleDeps } from "@/lib/firebase/authActions";

function firebaseError(code: string) {
  const error = new Error(code) as Error & { code: string };
  error.code = code;
  return error;
}

function baseDeps(overrides: Partial<LinkGoogleDeps> = {}): LinkGoogleDeps {
  return {
    isAnonymous: true,
    link: vi.fn().mockResolvedValue(undefined),
    signInWithLinkedCredential: vi.fn().mockResolvedValue(undefined),
    credentialFromError: vi.fn().mockReturnValue({ providerId: "google.com" } as never),
    ...overrides,
  };
}

describe("linkAnonymousToGoogleWith", () => {
  it("links the current anonymous user in place on a clean success", async () => {
    const deps = baseDeps();
    const result = await linkAnonymousToGoogleWith(deps);
    expect(result).toEqual({ ok: true, mergedExistingAccount: false });
    expect(deps.link).toHaveBeenCalledOnce();
    expect(deps.signInWithLinkedCredential).not.toHaveBeenCalled();
  });

  it("is a no-op success when the user is already a real (non-anonymous) account", async () => {
    const deps = baseDeps({ isAnonymous: false });
    const result = await linkAnonymousToGoogleWith(deps);
    expect(result).toEqual({ ok: true, mergedExistingAccount: false });
    expect(deps.link).not.toHaveBeenCalled();
  });

  it("reports not-signed-in-yet without attempting to link when there's no user at all", async () => {
    const deps = baseDeps({ isAnonymous: null });
    const result = await linkAnonymousToGoogleWith(deps);
    expect(result.ok).toBe(false);
    expect(deps.link).not.toHaveBeenCalled();
  });

  it("falls back to signing into the EXISTING account on auth/credential-already-in-use, never a silent merge", async () => {
    const deps = baseDeps({
      link: vi.fn().mockRejectedValue(firebaseError("auth/credential-already-in-use")),
    });
    const result = await linkAnonymousToGoogleWith(deps);
    expect(result).toEqual({ ok: true, mergedExistingAccount: true });
    expect(deps.signInWithLinkedCredential).toHaveBeenCalledOnce();
  });

  it("reports failure (not a merge) when credential-already-in-use has no recoverable credential", async () => {
    const deps = baseDeps({
      link: vi.fn().mockRejectedValue(firebaseError("auth/credential-already-in-use")),
      credentialFromError: vi.fn().mockReturnValue(null),
    });
    const result = await linkAnonymousToGoogleWith(deps);
    expect(result.ok).toBe(false);
    expect(deps.signInWithLinkedCredential).not.toHaveBeenCalled();
  });

  it("reports a plain cancellation without treating it as an error to retry blindly", async () => {
    const deps = baseDeps({ link: vi.fn().mockRejectedValue(firebaseError("auth/popup-closed-by-user")) });
    const result = await linkAnonymousToGoogleWith(deps);
    expect(result).toEqual({ ok: false, error: "Sign-in was cancelled." });
  });

  it("reports the specific operation-not-allowed constraint when Google sign-in isn't enabled server-side", async () => {
    const deps = baseDeps({ link: vi.fn().mockRejectedValue(firebaseError("auth/operation-not-allowed")) });
    const result = await linkAnonymousToGoogleWith(deps);
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toMatch(/isn't enabled/);
  });
});
