import { cn } from "@/lib/cn";

interface HuddleMarkProps {
  size?: number;
  className?: string;
  /** "in" plays the one-time entrance once (splash/auth screen); "breathe" is a slow, restrained idle loop reserved for "Huddle is present" contexts - not the default for a static logo render. */
  animate?: "in" | "breathe" | "none";
  /** Set only when the mark stands alone as the accessible identity (e.g. a splash screen) - omit when it sits beside the "Huddle" wordmark, where the text already carries the name and the mark should stay decorative. */
  title?: string;
}

/**
 * Phase 34: Huddle's own visual identity - previously nonexistent (no
 * logo/brandmark component existed anywhere in this codebase). Two
 * vertical strokes plus a leaning, rounded crossbar - unmistakably an
 * H, but the angled connector (rather than a flat bar) gives it a
 * distinct, ownable geometry instead of reading as a generic serif-free
 * letterform. Single-color, `currentColor`-driven so it themes for
 * free wherever it's placed (text-accent on the splash, text-fg in a
 * header) rather than carrying its own hardcoded palette.
 */
export function HuddleMark({ size = 32, className, animate = "none", title }: HuddleMarkProps) {
  const animationClass = animate === "in" ? "huddle-animate-mark-in" : animate === "breathe" ? "huddle-animate-mark-breathe" : undefined;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      className={cn(animationClass, className)}
    >
      {title && <title>{title}</title>}
      <path d="M10 6V26" stroke="currentColor" strokeWidth="4.5" strokeLinecap="round" />
      <path d="M22 6V26" stroke="currentColor" strokeWidth="4.5" strokeLinecap="round" />
      <path d="M10 14L22 18" stroke="currentColor" strokeWidth="4.5" strokeLinecap="round" />
    </svg>
  );
}
