import "server-only";

import PptxGenJS from "pptxgenjs";

import type { PresentationPlan, SlideSpec } from "@/lib/presentations/schema";

/**
 * Phase 35 STEP 7: one polished, premium dark theme - reusing Huddle's
 * own app palette (app/globals.css's --bg-base/--fg/--accent etc.) so
 * a generated deck reads as genuinely "from Huddle," not a generic
 * template. STEP 7 also asks for context-adaptive theming ("do not
 * force every presentation to be dark") - deliberately not attempted
 * in this pass; see the Phase 35 report's own "intentionally left
 * out" section for why (a second, equally polished theme needs its
 * own real design pass, not a naive color inversion).
 */
const THEME = {
  bg: "0A0A0B",
  bgRaised: "16161A",
  fg: "F4F4F5",
  fgMuted: "A1A1AA",
  fgSubtle: "6B6B74",
  accent: "22D3EE",
  accentFg: "05191C",
  border: "2A2A30",
} as const;

/** PowerPoint has no access to Huddle's actual web fonts (Geist/Instrument) without font embedding - out of scope. Arial is universally available across PowerPoint/Keynote/LibreOffice, which matters more for a deck someone will actually open than a closer brand match that might silently fall back to Times New Roman on another machine. */
const FONT = "Arial";

const PAGE = { width: 13.333, height: 7.5 };
const MARGIN = 0.7;
const CONTENT_W = PAGE.width - MARGIN * 2;

function footer(slide: PptxGenJS.Slide, index: number, total: number) {
  slide.addText(`${index + 1} / ${total}`, {
    x: PAGE.width - 1.5,
    y: PAGE.height - 0.5,
    w: 1.0,
    h: 0.3,
    fontFace: FONT,
    fontSize: 10,
    color: THEME.fgSubtle,
    align: "right",
  });
}

function bulletRuns(items: string[]) {
  return items.map((text) => ({ text, options: { bullet: { code: "2022", indent: 18 }, breakLine: true, color: THEME.fg } }));
}

function renderTitle(pptx: PptxGenJS, plan: PresentationPlan, slide: SlideSpec) {
  const s = pptx.addSlide();
  s.background = { color: THEME.bg };
  s.addShape(pptx.ShapeType.rect, { x: MARGIN, y: 3.1, w: 0.55, h: 0.08, fill: { color: THEME.accent }, line: { type: "none" } });
  s.addText(slide.heading ?? plan.title, {
    x: MARGIN,
    y: 3.3,
    w: CONTENT_W,
    h: 1.4,
    fontFace: FONT,
    fontSize: 44,
    bold: true,
    color: THEME.fg,
    align: "left",
  });
  const subtitle = slide.subheading ?? plan.subtitle;
  if (subtitle) {
    s.addText(subtitle, {
      x: MARGIN,
      y: 4.6,
      w: CONTENT_W,
      h: 0.6,
      fontFace: FONT,
      fontSize: 20,
      color: THEME.fgMuted,
      align: "left",
    });
  }
  return s;
}

function renderTitleContent(pptx: PptxGenJS, slide: SlideSpec) {
  const s = pptx.addSlide();
  s.background = { color: THEME.bg };
  if (slide.heading) {
    s.addText(slide.heading, { x: MARGIN, y: 0.6, w: CONTENT_W, h: 0.7, fontFace: FONT, fontSize: 30, bold: true, color: THEME.fg });
    s.addShape(pptx.ShapeType.rect, { x: MARGIN, y: 1.32, w: 1.0, h: 0.045, fill: { color: THEME.accent }, line: { type: "none" } });
  }
  const bodyY = slide.heading ? 1.7 : 0.8;
  if (slide.bullets?.length) {
    s.addText(bulletRuns(slide.bullets), { x: MARGIN, y: bodyY, w: CONTENT_W, h: PAGE.height - bodyY - 0.8, fontFace: FONT, fontSize: 18, color: THEME.fg, lineSpacing: 30, valign: "top" });
  } else if (slide.body) {
    s.addText(slide.body, { x: MARGIN, y: bodyY, w: CONTENT_W, h: PAGE.height - bodyY - 0.8, fontFace: FONT, fontSize: 19, color: THEME.fgMuted, lineSpacing: 28, valign: "top" });
  }
  return s;
}

function renderTwoColumn(pptx: PptxGenJS, slide: SlideSpec) {
  const s = pptx.addSlide();
  s.background = { color: THEME.bg };
  if (slide.heading) {
    s.addText(slide.heading, { x: MARGIN, y: 0.6, w: CONTENT_W, h: 0.7, fontFace: FONT, fontSize: 30, bold: true, color: THEME.fg });
    s.addShape(pptx.ShapeType.rect, { x: MARGIN, y: 1.32, w: 1.0, h: 0.045, fill: { color: THEME.accent }, line: { type: "none" } });
  }
  const colY = slide.heading ? 1.8 : 0.9;
  const colW = (CONTENT_W - 0.6) / 2;
  const rightX = MARGIN + colW + 0.6;

  s.addShape(pptx.ShapeType.line, { x: MARGIN + colW + 0.3, y: colY, w: 0, h: PAGE.height - colY - 0.7, line: { color: THEME.border, width: 1 } });

  if (slide.columnLeftHeading) s.addText(slide.columnLeftHeading, { x: MARGIN, y: colY, w: colW, h: 0.5, fontFace: FONT, fontSize: 18, bold: true, color: THEME.accent });
  if (slide.columnLeftBullets?.length) {
    s.addText(bulletRuns(slide.columnLeftBullets), { x: MARGIN, y: colY + (slide.columnLeftHeading ? 0.55 : 0), w: colW, h: PAGE.height - colY - 1.2, fontFace: FONT, fontSize: 16, color: THEME.fg, lineSpacing: 26, valign: "top" });
  }
  if (slide.columnRightHeading) s.addText(slide.columnRightHeading, { x: rightX, y: colY, w: colW, h: 0.5, fontFace: FONT, fontSize: 18, bold: true, color: THEME.accent });
  if (slide.columnRightBullets?.length) {
    s.addText(bulletRuns(slide.columnRightBullets), { x: rightX, y: colY + (slide.columnRightHeading ? 0.55 : 0), w: colW, h: PAGE.height - colY - 1.2, fontFace: FONT, fontSize: 16, color: THEME.fg, lineSpacing: 26, valign: "top" });
  }
  return s;
}

function renderImageContent(pptx: PptxGenJS, slide: SlideSpec) {
  const s = pptx.addSlide();
  s.background = { color: THEME.bg };
  const boxW = 5.0;
  const boxX = PAGE.width - MARGIN - boxW;
  const textW = boxX - MARGIN - 0.5;

  if (slide.heading) s.addText(slide.heading, { x: MARGIN, y: 0.8, w: textW, h: 0.7, fontFace: FONT, fontSize: 26, bold: true, color: THEME.fg });
  if (slide.body) s.addText(slide.body, { x: MARGIN, y: 1.6, w: textW, h: 3.5, fontFace: FONT, fontSize: 17, color: THEME.fgMuted, lineSpacing: 26, valign: "top" });

  s.addShape(pptx.ShapeType.roundRect, { x: boxX, y: 1.0, w: boxW, h: 4.5, fill: { color: THEME.bgRaised }, line: { color: THEME.border, width: 1 }, rectRadius: 0.08 });
  s.addText(slide.imageCaption ?? "Image placeholder", {
    x: boxX,
    y: 3.0,
    w: boxW,
    h: 0.5,
    fontFace: FONT,
    fontSize: 13,
    color: THEME.fgSubtle,
    align: "center",
  });
  return s;
}

function renderSection(pptx: PptxGenJS, slide: SlideSpec) {
  const s = pptx.addSlide();
  s.background = { color: THEME.bg };
  s.addShape(pptx.ShapeType.rect, { x: MARGIN, y: PAGE.height / 2 - 0.15, w: 0.7, h: 0.09, fill: { color: THEME.accent }, line: { type: "none" } });
  s.addText(slide.heading ?? "", {
    x: MARGIN,
    y: PAGE.height / 2 - 0.05,
    w: CONTENT_W,
    h: 1.0,
    fontFace: FONT,
    fontSize: 36,
    bold: true,
    color: THEME.fg,
  });
  if (slide.subheading) {
    s.addText(slide.subheading, { x: MARGIN, y: PAGE.height / 2 + 0.9, w: CONTENT_W, h: 0.6, fontFace: FONT, fontSize: 18, color: THEME.fgMuted });
  }
  return s;
}

function renderQuote(pptx: PptxGenJS, slide: SlideSpec) {
  const s = pptx.addSlide();
  s.background = { color: THEME.bg };
  s.addText('"', { x: MARGIN, y: 1.1, w: 1.2, h: 1.2, fontFace: "Georgia", fontSize: 72, bold: true, color: THEME.accent });
  s.addText(slide.quote ?? "", {
    x: MARGIN + 0.3,
    y: 2.3,
    w: CONTENT_W - 0.6,
    h: 2.4,
    fontFace: FONT,
    fontSize: 28,
    italic: true,
    color: THEME.fg,
    lineSpacing: 36,
    valign: "top",
  });
  if (slide.attribution) {
    s.addText(`— ${slide.attribution}`, { x: MARGIN + 0.3, y: 4.9, w: CONTENT_W - 0.6, h: 0.5, fontFace: FONT, fontSize: 16, color: THEME.fgMuted });
  }
  return s;
}

function renderClosing(pptx: PptxGenJS, slide: SlideSpec) {
  const s = pptx.addSlide();
  s.background = { color: THEME.bg };
  s.addText(slide.heading ?? "Thank you", {
    x: MARGIN,
    y: 3.1,
    w: CONTENT_W,
    h: 1.2,
    fontFace: FONT,
    fontSize: 40,
    bold: true,
    color: THEME.fg,
    align: "center",
  });
  if (slide.body) {
    s.addText(slide.body, { x: MARGIN, y: 4.3, w: CONTENT_W, h: 0.7, fontFace: FONT, fontSize: 18, color: THEME.fgMuted, align: "center" });
  }
  return s;
}

/** Every renderer returns the real pptxgenjs Slide it just added, so notes/footer stay in one shared place instead of being repeated in each one. */
function renderSlide(pptx: PptxGenJS, plan: PresentationPlan, slide: SlideSpec): PptxGenJS.Slide {
  switch (slide.type) {
    case "title":
      return renderTitle(pptx, plan, slide);
    case "title_content":
      return renderTitleContent(pptx, slide);
    case "two_column":
      return renderTwoColumn(pptx, slide);
    case "image_content":
      return renderImageContent(pptx, slide);
    case "section":
      return renderSection(pptx, slide);
    case "quote":
      return renderQuote(pptx, slide);
    case "closing":
      return renderClosing(pptx, slide);
  }
}

export interface GeneratedPresentation {
  base64: string;
  slideCount: number;
}

/**
 * Phase 35 STEP 3/7: the ONE deterministic path from a validated,
 * content-fit PresentationPlan to real PPTX bytes - the model never
 * touches this. Every slide type gets its own small, purpose-built
 * layout function rather than one generic "text box dump" renderer,
 * per STEP 7's "multiple useful layouts, not 30" - seven types,
 * matching the plan's own SlideType union exactly.
 */
export async function generatePptx(plan: PresentationPlan): Promise<GeneratedPresentation> {
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: "HUDDLE_16X9", width: PAGE.width, height: PAGE.height });
  pptx.layout = "HUDDLE_16X9";
  pptx.author = "Huddle";
  pptx.title = plan.title;

  const total = plan.slides.length;
  plan.slides.forEach((slideSpec, i) => {
    const slide = renderSlide(pptx, plan, slideSpec);
    if (slideSpec.notes) slide.addNotes(slideSpec.notes);
    if (slideSpec.type !== "title") footer(slide, i, total);
  });

  const base64 = (await pptx.write({ outputType: "base64" })) as string;
  return { base64, slideCount: total };
}
