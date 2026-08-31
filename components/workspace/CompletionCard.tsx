import { AlertTriangle, CheckCircle2, CircleAlert, Eye, XCircle } from "lucide-react";

import { cn } from "@/lib/cn";

import type { CompletionSummary } from "@/lib/agent/completionSummary";

const STATUS_ICON: Record<CompletionSummary["status"], typeof CheckCircle2> = {
  success: CheckCircle2,
  partial: AlertTriangle,
  failed: CircleAlert,
  cancelled: XCircle,
};

const STATUS_COLOR: Record<CompletionSummary["status"], string> = {
  success: "text-success",
  partial: "text-warning",
  failed: "text-danger",
  cancelled: "text-fg-subtle",
};

const STATUS_BORDER: Record<CompletionSummary["status"], string> = {
  success: "border-border",
  partial: "border-warning/30",
  failed: "border-danger/30",
  cancelled: "border-border",
};

/**
 * Phase 33 STEP 4: the one place a finished turn answers "what did
 * Huddle do, did it succeed, was it verified, is anything left" - built
 * entirely from deriveCompletionSummary's already evidence-checked
 * output (a done subgoal's own description, a real file-write count, a
 * real view_preview result - never raw model prose asserting success).
 * Shared as-is by desktop HuddlePanel and mobile MobileProjectView, as
 * the final row in the same unified timeline both already render from
 * buildUnifiedFeed - STEP 6's "same behavior, different surface"
 * applies to the data, not to a second copy of this component.
 */
export function CompletionCard({ summary }: { summary: CompletionSummary }) {
  const Icon = STATUS_ICON[summary.status];

  return (
    <div className={cn("rounded-xl border px-3.5 py-3", STATUS_BORDER[summary.status])}>
      <div className="flex items-center gap-2">
        <Icon className={cn("h-4 w-4 shrink-0", STATUS_COLOR[summary.status])} strokeWidth={2} />
        <span className="text-sm font-medium text-fg">{summary.headline}</span>
      </div>

      {summary.whatItDid.length > 0 && (
        <ul className="mt-2 space-y-1">
          {summary.whatItDid.map((line, i) => (
            <li key={i} className="flex items-start gap-1.5 text-xs text-fg-muted">
              <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-fg-subtle" aria-hidden />
              {line}
            </li>
          ))}
        </ul>
      )}

      {summary.verified && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-fg-subtle">
          <Eye className="h-3 w-3 shrink-0" strokeWidth={2} />
          Verified against the live preview
        </p>
      )}

      {summary.blocked.map((line, i) => (
        <p key={`blocked-${i}`} className="mt-1.5 text-xs text-warning">
          Blocked: {line}
        </p>
      ))}

      {summary.remaining.map((line, i) => (
        <p key={`remaining-${i}`} className="mt-1.5 text-xs text-fg-subtle">
          Still remaining: {line}
        </p>
      ))}
    </div>
  );
}
