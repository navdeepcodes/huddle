import { HuddleMark } from "@/components/brand/HuddleMark";

/** Phase 34 PART 9: the "loading" state - auth restoring, or the intro-seen flag not read yet - must never flash the wrong screen. A calm, static mark instead of a spinner or "Loading…" text, per PART 1's own instruction. */
export function EntryLoadingScreen() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg-base">
      <HuddleMark size={40} className="text-fg-subtle" />
    </div>
  );
}
