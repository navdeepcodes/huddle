/**
 * Phase 35 STEP 2/6: the structured plan the model produces via
 * create_presentation - never raw PPTX/base64 from the model itself.
 * Deliberately a plain data shape (no PPTX-specific concepts like
 * emu/inches) so the deterministic engine (generatePptx.ts) owns every
 * layout/typography decision - the model reasons about CONTENT
 * (headings, body, bullets), never pixels.
 */
export type SlideType =
  | "title"
  | "title_content"
  | "two_column"
  | "image_content"
  | "section"
  | "quote"
  | "closing";

const VALID_SLIDE_TYPES = new Set<SlideType>([
  "title",
  "title_content",
  "two_column",
  "image_content",
  "section",
  "quote",
  "closing",
]);

export interface SlideSpec {
  type: SlideType;
  heading?: string;
  subheading?: string;
  body?: string;
  bullets?: string[];
  /** two_column only. */
  columnLeftHeading?: string;
  columnLeftBullets?: string[];
  columnRightHeading?: string;
  columnRightBullets?: string[];
  /** image_content only - a labeled placeholder, never a real generated/fetched image (out of scope). */
  imageCaption?: string;
  /** quote only. */
  quote?: string;
  attribution?: string;
  /** Speaker notes - never rendered on the slide itself. */
  notes?: string;
}

export interface PresentationPlan {
  title: string;
  subtitle?: string;
  slides: SlideSpec[];
}

export type PlanValidationResult = { ok: true; plan: PresentationPlan } | { ok: false; error: string };

const MAX_TITLE_LENGTH = 120;
const MAX_SLIDES = 30;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function validateSlide(raw: unknown, index: number): { ok: true; slide: SlideSpec } | { ok: false; error: string } {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, error: `Slide ${index + 1} must be an object.` };
  }
  const s = raw as Record<string, unknown>;

  if (typeof s.type !== "string" || !VALID_SLIDE_TYPES.has(s.type as SlideType)) {
    return {
      ok: false,
      error: `Slide ${index + 1} has an invalid type "${String(s.type)}". Must be one of: ${Array.from(VALID_SLIDE_TYPES).join(", ")}.`,
    };
  }

  for (const field of ["heading", "subheading", "body", "imageCaption", "quote", "attribution", "notes", "columnLeftHeading", "columnRightHeading"]) {
    if (field in s && s[field] !== undefined && typeof s[field] !== "string") {
      return { ok: false, error: `Slide ${index + 1}'s "${field}" must be a string.` };
    }
  }
  for (const field of ["bullets", "columnLeftBullets", "columnRightBullets"]) {
    if (field in s && s[field] !== undefined && !isStringArray(s[field])) {
      return { ok: false, error: `Slide ${index + 1}'s "${field}" must be an array of strings.` };
    }
  }

  const type = s.type as SlideType;
  if (type === "quote" && !s.quote) {
    return { ok: false, error: `Slide ${index + 1} is type "quote" but has no "quote" text.` };
  }
  if (type === "two_column" && !isStringArray(s.columnLeftBullets) && !isStringArray(s.columnRightBullets)) {
    return { ok: false, error: `Slide ${index + 1} is type "two_column" but has no content in either column.` };
  }

  return {
    ok: true,
    slide: {
      type,
      heading: s.heading as string | undefined,
      subheading: s.subheading as string | undefined,
      body: s.body as string | undefined,
      bullets: s.bullets as string[] | undefined,
      columnLeftHeading: s.columnLeftHeading as string | undefined,
      columnLeftBullets: s.columnLeftBullets as string[] | undefined,
      columnRightHeading: s.columnRightHeading as string | undefined,
      columnRightBullets: s.columnRightBullets as string[] | undefined,
      imageCaption: s.imageCaption as string | undefined,
      quote: s.quote as string | undefined,
      attribution: s.attribution as string | undefined,
      notes: s.notes as string | undefined,
    },
  };
}

/**
 * Structural validation only - is this a well-formed plan at all.
 * Content-length fitting (long text, too many bullets) is a SEPARATE,
 * always-succeeding normalization pass (see fitSlideContent.ts) - a
 * slide with a too-long body is real, valid content to fit onto the
 * page, not a reason to reject the whole presentation.
 */
export function validatePresentationPlan(raw: unknown): PlanValidationResult {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, error: "create_presentation's arguments must be an object." };
  }
  const p = raw as Record<string, unknown>;

  if (typeof p.title !== "string" || !p.title.trim()) {
    return { ok: false, error: "create_presentation requires a non-empty 'title' string." };
  }
  if (p.subtitle !== undefined && typeof p.subtitle !== "string") {
    return { ok: false, error: "create_presentation's 'subtitle', if present, must be a string." };
  }
  if (!Array.isArray(p.slides) || p.slides.length === 0) {
    return { ok: false, error: "create_presentation requires a non-empty 'slides' array." };
  }
  if (p.slides.length > MAX_SLIDES) {
    return { ok: false, error: `Too many slides (${p.slides.length}) - keep it to ${MAX_SLIDES} or fewer.` };
  }

  const slides: SlideSpec[] = [];
  for (let i = 0; i < p.slides.length; i++) {
    const result = validateSlide(p.slides[i], i);
    if (!result.ok) return result;
    slides.push(result.slide);
  }

  return {
    ok: true,
    plan: {
      title: p.title.trim().slice(0, MAX_TITLE_LENGTH),
      subtitle: typeof p.subtitle === "string" ? p.subtitle.trim().slice(0, MAX_TITLE_LENGTH) : undefined,
      slides,
    },
  };
}
