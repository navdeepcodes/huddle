import type { PresentationPlan, SlideSpec } from "@/lib/presentations/schema";

/**
 * Phase 35 STEP 8: a pure, always-succeeding normalization pass -
 * distinct from schema.ts's structural validation, because content
 * that's simply too long for a slide is real, valid input to fit onto
 * the page, never a reason to reject the whole presentation. These
 * character/count limits are chosen to match generatePptx.ts's actual
 * box sizes/font sizes - keep them in sync if either changes.
 *
 * v1 fits content by truncation (with an ellipsis), not by
 * auto-splitting overflow into additional slides - simpler, always
 * safe, and meets STEP 8's real requirement ("never blindly overflow
 * text") without the added complexity of deciding split points.
 * Auto-splitting is a reasonable future enhancement, not attempted
 * here.
 */
const LIMITS = {
  title: 90,
  subtitle: 120,
  heading: 80,
  subheading: 100,
  body: 500,
  bullet: 120,
  maxBullets: 6,
  quote: 260,
  attribution: 80,
  imageCaption: 80,
} as const;

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

function fitBullets(bullets: string[] | undefined): string[] | undefined {
  if (!bullets) return bullets;
  return bullets.slice(0, LIMITS.maxBullets).map((b) => truncate(b, LIMITS.bullet));
}

export function fitSlideContent(slide: SlideSpec): SlideSpec {
  return {
    ...slide,
    heading: slide.heading ? truncate(slide.heading, LIMITS.heading) : slide.heading,
    subheading: slide.subheading ? truncate(slide.subheading, LIMITS.subheading) : slide.subheading,
    body: slide.body ? truncate(slide.body, LIMITS.body) : slide.body,
    bullets: fitBullets(slide.bullets),
    columnLeftHeading: slide.columnLeftHeading ? truncate(slide.columnLeftHeading, LIMITS.subheading) : slide.columnLeftHeading,
    columnLeftBullets: fitBullets(slide.columnLeftBullets),
    columnRightHeading: slide.columnRightHeading ? truncate(slide.columnRightHeading, LIMITS.subheading) : slide.columnRightHeading,
    columnRightBullets: fitBullets(slide.columnRightBullets),
    imageCaption: slide.imageCaption ? truncate(slide.imageCaption, LIMITS.imageCaption) : slide.imageCaption,
    quote: slide.quote ? truncate(slide.quote, LIMITS.quote) : slide.quote,
    attribution: slide.attribution ? truncate(slide.attribution, LIMITS.attribution) : slide.attribution,
  };
}

export function fitPresentationPlan(plan: PresentationPlan): PresentationPlan {
  return {
    ...plan,
    title: truncate(plan.title, LIMITS.title),
    subtitle: plan.subtitle ? truncate(plan.subtitle, LIMITS.subtitle) : plan.subtitle,
    slides: plan.slides.map(fitSlideContent),
  };
}
