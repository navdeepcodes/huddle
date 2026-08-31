/**
 * Phase 36 STEP 6: bounded, validated input for create_image/edit_image
 * - "do not allow arbitrary model parameters to be exposed directly to
 * the user in v1." Only a small, fixed set of fields reach the
 * provider; everything else about the request is a Huddle decision,
 * not something the model can override per call.
 */
const VALID_ASPECT_RATIOS = new Set(["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"]);
const MAX_PROMPT_LENGTH = 800;
const MAX_INSTRUCTION_LENGTH = 500;
const MAX_TITLE_LENGTH = 120;

export type GenerateImageInput =
  | { ok: true; prompt: string; aspectRatio?: string; title: string }
  | { ok: false; error: string };

export function validateGenerateImageInput(raw: unknown): GenerateImageInput {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, error: "create_image's arguments must be an object." };
  }
  const p = raw as Record<string, unknown>;

  if (typeof p.prompt !== "string" || !p.prompt.trim()) {
    return { ok: false, error: "create_image requires a non-empty 'prompt' string." };
  }
  if (p.prompt.length > MAX_PROMPT_LENGTH) {
    return { ok: false, error: `'prompt' is too long - keep it to ${MAX_PROMPT_LENGTH} characters or fewer.` };
  }
  if (p.aspectRatio !== undefined && (typeof p.aspectRatio !== "string" || !VALID_ASPECT_RATIOS.has(p.aspectRatio))) {
    return { ok: false, error: `'aspectRatio', if present, must be one of: ${Array.from(VALID_ASPECT_RATIOS).join(", ")}.` };
  }
  if (p.title !== undefined && typeof p.title !== "string") {
    return { ok: false, error: "'title', if present, must be a string." };
  }

  const rawTitle = typeof p.title === "string" && p.title.trim() ? p.title.trim() : p.prompt.trim().slice(0, 60);
  return {
    ok: true,
    prompt: p.prompt.trim(),
    aspectRatio: p.aspectRatio as string | undefined,
    title: rawTitle.slice(0, MAX_TITLE_LENGTH),
  };
}

export type EditImageInput =
  | { ok: true; sourceArtifactId: string; instruction: string; title: string }
  | { ok: false; error: string };

export function validateEditImageInput(raw: unknown): EditImageInput {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, error: "edit_image's arguments must be an object." };
  }
  const p = raw as Record<string, unknown>;

  if (typeof p.sourceArtifactId !== "string" || !p.sourceArtifactId.trim()) {
    return { ok: false, error: "edit_image requires a non-empty 'sourceArtifactId' string, referencing an existing project image." };
  }
  if (typeof p.instruction !== "string" || !p.instruction.trim()) {
    return { ok: false, error: "edit_image requires a non-empty 'instruction' string." };
  }
  if (p.instruction.length > MAX_INSTRUCTION_LENGTH) {
    return { ok: false, error: `'instruction' is too long - keep it to ${MAX_INSTRUCTION_LENGTH} characters or fewer.` };
  }
  if (p.title !== undefined && typeof p.title !== "string") {
    return { ok: false, error: "'title', if present, must be a string." };
  }

  const rawTitle = typeof p.title === "string" && p.title.trim() ? p.title.trim() : "Edited image";
  return {
    ok: true,
    sourceArtifactId: p.sourceArtifactId.trim(),
    instruction: p.instruction.trim(),
    title: rawTitle.slice(0, MAX_TITLE_LENGTH),
  };
}
