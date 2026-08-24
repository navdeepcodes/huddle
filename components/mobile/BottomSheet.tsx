"use client";

import { useEffect } from "react";
import { X } from "lucide-react";

interface Props {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
}

/**
 * Phase 32: the one shared modal primitive for every mobile screen that
 * needs a lightweight overlay (archive confirm, collaborators, project
 * settings/share) - a real bottom sheet (enters from its own anchor
 * edge, per this phase's motion convention), not a centered desktop-
 * style dialog stretched onto a phone. Scrim-tap and Escape both
 * dismiss; safe-area-aware bottom padding so content never sits under
 * the home indicator.
 */
export function BottomSheet({ open, onClose, title, children }: Props) {
  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center">
      <div className="huddle-animate-fade-in absolute inset-0 bg-black/60" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="huddle-animate-sheet-in huddle-safe-bottom relative w-full max-w-lg rounded-t-2xl border-t border-border bg-bg-overlay px-5 pt-4 shadow-2xl"
      >
        <div className="mx-auto mb-3 h-1 w-9 shrink-0 rounded-full bg-border-strong" aria-hidden />
        {title && (
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-medium text-fg">{title}</h2>
            <button
              onClick={onClose}
              aria-label="Close"
              className="flex h-8 w-8 items-center justify-center rounded-full text-fg-subtle hover:bg-bg-raised hover:text-fg"
            >
              <X className="h-4 w-4" strokeWidth={2} />
            </button>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}
