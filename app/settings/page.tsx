"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { authedFetch } from "@/lib/firebase/authedFetch";
import { auth } from "@/lib/firebase/client";
import { linkAnonymousToGoogle } from "@/lib/firebase/authActions";
import { useAuthState } from "@/hooks/useAuthState";
import { useHasSeenIntro } from "@/hooks/useHasSeenIntro";

type Status = "loading" | "connected" | "not_configured";

/**
 * Phase 29: the browser side of the credential API - the ONLY thing
 * this page ever handles is a status boolean and, briefly, a value
 * the user just typed that gets sent once on Save and never displayed
 * again (no state anywhere here holds the raw key after that POST
 * resolves - `keyInput` is cleared immediately after a successful
 * save, and the value is never logged, never included in any response
 * this page reads back). See lib/credentials/credentialStore.ts's own
 * doc comment for the server-side half of that guarantee.
 */
export default function SettingsPage() {
  const router = useRouter();
  const authState = useAuthState();
  const [, setIntroSeen] = useHasSeenIntro();
  const [linking, setLinking] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);

  const [status, setStatus] = useState<Status>("loading");
  const [keyInput, setKeyInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    authedFetch("/api/credentials/nemotron")
      .then((res) => (res.ok ? res.json() : { configured: false }))
      .then(({ configured }) => {
        if (!cancelled) setStatus(configured ? "connected" : "not_configured");
      })
      .catch(() => {
        if (!cancelled) setStatus("not_configured");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!keyInput.trim() || saving) return;
    setSaving(true);
    setError(null);
    const res = await authedFetch("/api/credentials/nemotron", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: keyInput.trim() }),
    });
    setKeyInput("");
    if (res.ok) {
      setStatus("connected");
    } else {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "Couldn't save that key - try again.");
    }
    setSaving(false);
  }

  async function remove() {
    setSaving(true);
    setError(null);
    const res = await authedFetch("/api/credentials/nemotron", { method: "DELETE" });
    if (res.ok) {
      setStatus("not_configured");
    } else {
      setError("Couldn't remove the key - try again.");
    }
    setSaving(false);
  }

  async function handleSignIn() {
    setLinking(true);
    setLinkError(null);
    const result = await linkAnonymousToGoogle();
    setLinking(false);
    if (!result.ok) setLinkError(result.error);
  }

  /** PART 9 "Sign-out: Return to authentication cleanly" - resetting the intro-seen flag routes them back through the splash/auth choice on their next visit via EntryGate, rather than a dedicated signed-out screen. */
  async function handleSignOut() {
    await auth.signOut();
    setIntroSeen(false);
    router.push("/");
  }

  return (
    <div className="mx-auto w-full max-w-lg px-6 py-12">
      <Link href="/" className="mb-6 flex items-center gap-1.5 text-sm text-fg-subtle hover:text-fg">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2} />
        Back
      </Link>

      <h1 className="mb-1 text-xl font-semibold text-fg">Settings</h1>
      <p className="mb-8 text-sm text-fg-subtle">Manage your account and provider credentials.</p>

      <section className="mb-4 rounded-lg border border-border p-4">
        <h2 className="mb-1 text-sm font-medium text-fg">Account</h2>

        {authState.status === "authenticated" ? (
          <>
            <p className="mb-4 text-xs text-fg-subtle">
              Signed in{authState.user.displayName ? ` as ${authState.user.displayName}` : ""}
              {authState.user.email ? ` (${authState.user.email})` : ""}. Your projects sync across devices.
            </p>
            <button
              onClick={handleSignOut}
              className="rounded-md border border-border px-3 py-1.5 text-xs text-fg-muted hover:bg-bg-raised"
            >
              Sign out
            </button>
          </>
        ) : (
          <>
            <p className="mb-4 text-xs text-fg-subtle">
              You&rsquo;re using Huddle anonymously - your projects live only in this browser. Sign in to keep them
              synced across devices.
            </p>
            <button
              onClick={handleSignIn}
              disabled={linking}
              className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg disabled:opacity-40"
            >
              {linking ? "Signing in…" : "Sign in with Google"}
            </button>
            {linkError && <p className="mt-2 text-xs text-danger">{linkError}</p>}
          </>
        )}
      </section>

      <section className="rounded-lg border border-border p-4">
        <h2 className="mb-1 text-sm font-medium text-fg">AI Provider</h2>
        <p className="mb-4 text-xs text-fg-subtle">
          Use your own NVIDIA Nemotron API key so your agent traffic is attributed to your account. Without one,
          Huddle uses a shared platform credential.
        </p>

        <div className="mb-4 flex items-center justify-between">
          <span className="text-sm text-fg">Nemotron</span>
          {status === "loading" ? (
            <span className="text-xs text-fg-subtle">Checking…</span>
          ) : status === "connected" ? (
            <span className="flex items-center gap-1.5 text-xs text-success">
              <span className="h-1.5 w-1.5 rounded-full bg-success" />
              Connected
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-xs text-fg-subtle">
              <span className="h-1.5 w-1.5 rounded-full bg-fg-subtle" />
              Not configured
            </span>
          )}
        </div>

        <form onSubmit={save} className="flex flex-col gap-2">
          <input
            type="password"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            placeholder={status === "connected" ? "Replace your key…" : "nvapi-…"}
            autoComplete="off"
            className="rounded-md border border-border bg-bg-raised px-2.5 py-1.5 text-xs text-fg outline-none placeholder:text-fg-subtle focus:border-border-strong"
          />
          {error && <p className="text-xs text-danger">{error}</p>}
          <div className="flex items-center gap-2">
            <button
              type="submit"
              disabled={!keyInput.trim() || saving}
              className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg disabled:opacity-40"
            >
              Save key
            </button>
            {status === "connected" && (
              <button
                type="button"
                onClick={remove}
                disabled={saving}
                className="rounded-md border border-border px-3 py-1.5 text-xs text-fg-muted hover:bg-bg-raised disabled:opacity-40"
              >
                Remove key
              </button>
            )}
          </div>
        </form>
      </section>
    </div>
  );
}
