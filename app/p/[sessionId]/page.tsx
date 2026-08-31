"use client";

import { use, useState } from "react";
import { Sparkles } from "lucide-react";

import { usePublicProjectPreview } from "@/hooks/usePublicProjectPreview";
import { HuddleMark } from "@/components/brand/HuddleMark";

interface Props {
  params: Promise<{ sessionId: string }>;
}

/**
 * Phase 38 STEP 2: the public "Let the World Try It" page - no auth
 * gate, no EntryGate, no sidebar. The project itself IS the page: a
 * live preview (booted fresh in THIS visitor's own tab - see
 * usePublicProjectPreview/publicBoot.ts) plus one lightweight way to
 * leave feedback. No file tree, no code viewer, no Git terminology, no
 * social counters - deliberately not built, see the Phase 38 brief.
 */
export default function PublicProjectPage({ params }: Props) {
  const { sessionId } = use(params);
  const { state, previewUrl, project, errorMessage } = usePublicProjectPreview(sessionId);

  return (
    <div className="flex min-h-dvh flex-col bg-bg-base">
      <header className="flex shrink-0 items-center justify-between border-b border-border px-5 py-3">
        <div className="flex items-center gap-2 min-w-0">
          <HuddleMark size={20} className="shrink-0 text-accent" />
          <span className="truncate text-sm font-medium text-fg">{project?.name ?? "A Huddle project"}</span>
        </div>
        <a href="https://huddle.dev" className="shrink-0 text-xs text-fg-subtle hover:text-fg">
          Built with Huddle
        </a>
      </header>

      <main className="relative flex-1">
        {state === "not_found" && (
          <div className="flex h-full min-h-[70dvh] flex-col items-center justify-center gap-2 px-6 text-center">
            <p className="text-sm font-medium text-fg">This project isn&rsquo;t available.</p>
            <p className="text-sm text-fg-subtle">It may not be shared with the world anymore.</p>
          </div>
        )}

        {state === "crashed" && (
          <div className="flex h-full min-h-[70dvh] flex-col items-center justify-center gap-2 px-6 text-center">
            <p className="text-sm font-medium text-fg">This project couldn&rsquo;t start.</p>
            {errorMessage && <p className="max-w-md text-sm text-fg-subtle">{errorMessage}</p>}
          </div>
        )}

        {state !== "not_found" && state !== "crashed" && !previewUrl && (
          <div className="flex h-full min-h-[70dvh] flex-col items-center justify-center gap-3 px-6 text-center">
            <HuddleMark size={32} animate="in" className="text-accent" />
            <p className="text-sm text-fg-subtle">
              {state === "fetching" && "Loading the project…"}
              {state === "installing" && "Setting up…"}
              {(state === "starting" || state === "idle" || state === "running") && "Starting your preview…"}
            </p>
          </div>
        )}

        {previewUrl && (
          <iframe
            src={previewUrl}
            title={project?.name ?? "Live preview"}
            className="h-[calc(100dvh-49px)] w-full border-0"
          />
        )}
      </main>

      {state !== "not_found" && <TellHuddleButton sessionId={sessionId} />}
    </div>
  );
}

function TellHuddleButton({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [notifyMe, setNotifyMe] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ id: string; notifyToken: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!text.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const res = await fetch(`/api/public/projects/${sessionId}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: text.trim(), viewport, notifyMe }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? "Couldn't send that - try again.");
        setSubmitting(false);
        return;
      }
      setResult(await res.json());
    } catch {
      setError("Couldn't send that - try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="huddle-animate-rise-in fixed bottom-5 right-5 flex items-center gap-1.5 rounded-full bg-accent px-4 py-2.5 text-sm font-medium text-accent-fg shadow-lg"
      >
        <Sparkles className="h-3.5 w-3.5" strokeWidth={2} />
        Tell Huddle
      </button>
    );
  }

  return (
    <div className="huddle-animate-rise-in fixed bottom-5 right-5 w-[min(92vw,360px)] overflow-hidden rounded-2xl border border-border bg-bg-raised shadow-xl">
      {result ? (
        <div className="space-y-2 p-4 text-center">
          <p className="text-sm font-medium text-fg">Thanks - the creator will see this.</p>
          {result.notifyToken && (
            <a
              href={`/p/${sessionId}/feedback/${result.id}?token=${result.notifyToken}`}
              className="block text-xs text-accent hover:underline"
            >
              Save this link to check back later
            </a>
          )}
          <button onClick={() => setOpen(false)} className="text-xs text-fg-subtle hover:text-fg">
            Close
          </button>
        </div>
      ) : (
        <div className="space-y-3 p-4">
          <p className="text-sm font-medium text-fg">Found something you&rsquo;d improve?</p>
          <textarea
            autoFocus
            rows={3}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="The mobile cards feel cramped…"
            className="w-full resize-none rounded-xl border border-border bg-bg-overlay p-3 text-sm text-fg outline-none placeholder:text-fg-subtle focus:border-border-strong"
          />
          <label className="flex items-center gap-2 text-xs text-fg-subtle">
            <input type="checkbox" checked={notifyMe} onChange={(e) => setNotifyMe(e.target.checked)} />
            Let me know if this gets fixed
          </label>
          {error && <p className="text-xs text-danger">{error}</p>}
          <div className="flex items-center justify-between gap-2">
            <button onClick={() => setOpen(false)} className="text-xs text-fg-subtle hover:text-fg">
              Cancel
            </button>
            <button
              onClick={submit}
              disabled={!text.trim() || submitting}
              className="rounded-full bg-accent px-4 py-2 text-xs font-medium text-accent-fg disabled:opacity-40"
            >
              {submitting ? "Sending…" : "Send"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
