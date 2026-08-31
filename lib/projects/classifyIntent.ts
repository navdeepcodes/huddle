/**
 * Phase 37 STEP 1/15: a deterministic, local heuristic - explicitly
 * NOT an AI classifier (no model call, no embeddings, no service).
 * Used only to decide the INITIAL UI treatment for a founding request
 * (inline quick result vs. the full project workspace) - it never
 * gates whether a session gets created (the existing architecture
 * always needs one), and it's never the final word: isProjectWorthy.ts
 * (derived from real file activity) is the authoritative signal once
 * the agent has actually done something.
 */
export type RequestIntent = "project" | "quick";

const PROJECT_PATTERN =
  /\b(build|create|make|develop|design|set up|start)\b[^.!?]{0,60}\b(website|site|app|application|platform|dashboard|saas|game|product|portfolio|startup|mvp|prototype|webapp|web app|store|shop|blog|tool|system)\b/i;

const PROJECT_PHRASE = /\b(let'?s build|keep iterating|ongoing project|working on (my|our|a)|our (app|product|startup|website|game))\b/i;

const QUICK_IMAGE = /\b(generate|create|make|draw)\b[^.!?]{0,40}\b(image|picture|photo|illustration|graphic|icon|logo|wallpaper|artwork)\b/i;

const QUICK_SLIDES = /\b(presentation|slides?|slide deck|pitch deck|deck)\b/i;

const QUESTION_PATTERN = /^(what|why|how|when|where|who|explain|tell me|give me|can you|could you|is |are |does |do |should )/i;

/** ~12 words is the rough point where a request stops reading like a one-line ask and starts reading like a real spec - a soft tiebreaker only, after every explicit pattern above has already had a chance to match. */
const LONG_REQUEST_WORD_COUNT = 12;

export function classifyRequestIntent(message: string): RequestIntent {
  const text = message.trim();
  if (!text) return "quick";

  if (PROJECT_PATTERN.test(text) || PROJECT_PHRASE.test(text)) return "project";
  if (QUICK_IMAGE.test(text) || QUICK_SLIDES.test(text) || QUESTION_PATTERN.test(text)) return "quick";

  return text.split(/\s+/).length > LONG_REQUEST_WORD_COUNT ? "project" : "quick";
}
