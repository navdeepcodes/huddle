import "server-only";

import type { ChatCompletionTool } from "openai/resources/chat/completions";

/**
 * Huddle's v1 tool vocabulary - native OpenAI-style function calling,
 * not prose parsed out of a fenced block (that failure mode is exactly
 * what native tool calling exists to avoid - see apostle's
 * lib/codespace/tools.ts for the original, live-confirmed reasoning).
 *
 * commit/push exist in the proven legacy set but aren't registered
 * here - nothing in "one message -> working product" needs git, and
 * adding them back later (Phase 4, when GitHub integration is real) is
 * a new file, not a rewrite of this one.
 *
 * Phase 40: create_directory was removed entirely (2026-08-25) - live
 * evidence (the Marginalia build) showed the model calling it twice
 * before writing into new directories despite its own description
 * already saying "usually unnecessary." executeTool's handler was
 * always a pure no-op ("directories are implicit here" - see its own
 * comment), so every call was one full model round-trip spent on
 * literally nothing. Same lesson as the brand-icon fix: telling the
 * model not to do something isn't reliable enough on its own when the
 * cost of it happening anyway is a wasted turn - removing the tool
 * means it can't be called at all. executeTool.ts's case and
 * activityFeed.ts's display cases are left in place on purpose, to
 * keep rendering correct for sessions that already called it before
 * this fix.
 */

const PATH_PARAM = {
  type: "string",
  description:
    "Session-relative path, no leading slash (e.g. \"components/Header.js\").",
} as const;

const REASON_PARAM = {
  type: "string",
  description:
    "One short sentence describing what this does and why - shown to the user.",
} as const;

export const AGENT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Create new files, or overwrite existing ones, with their complete new content. Not a diff/patch - always the full file text as it should be after the change. When editing a file whose content you were shown, reproduce it in full with only the necessary lines changed. PREFER `files` over the single `path`/`content` shortcut whenever you already know the shape of more than one file to write (e.g. a set of components, or config+data files together) - one call with several files in `files` is much faster than one call per file, and is the single biggest lever on how quickly a build finishes. Use plain `path`/`content` only for a genuinely standalone single file. Every file (whichever shortcut you use) needs its own complete path and content; one invalid file rejects the whole call so you get one clear signal to fix and retry, not a silent partial write.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Session-relative path for a SINGLE file (e.g. \"components/Header.js\"), no leading slash. Omit this and use `files` instead when writing more than one file in this call.",
          },
          content: {
            type: "string",
            description: "The complete file content for the single `path` above. Omit when using `files`.",
          },
          files: {
            type: "array",
            description:
              "Write MULTIPLE files in this one call - each with its own complete path and content. This is the preferred shape whenever you already know several files you need to write (e.g. write Header.js, Hero.js, and Footer.js together in one files array, not three separate write_file calls).",
            items: {
              type: "object",
              properties: {
                path: {
                  type: "string",
                  description: "Session-relative path, no leading slash (e.g. \"components/Header.js\").",
                },
                content: {
                  type: "string",
                  description: "The complete file content after this change.",
                },
              },
              required: ["path", "content"],
            },
          },
          reason: REASON_PARAM,
        },
        required: ["reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_file",
      description:
        "Delete a file. Only ever call this when the user explicitly asked to delete something - never as a side effect of another change.",
      parameters: {
        type: "object",
        properties: {
          path: PATH_PARAM,
          reason: REASON_PARAM,
        },
        required: ["path", "reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "scaffold_nextjs_project",
      description:
        "Deterministically writes the proven-correct Next.js Pages Router + Tailwind v4 + lucide-react boilerplate for a NEW web project in one call: package.json (correct package version ranges), next.config.mjs, postcss.config.mjs, styles/globals.css (Tailwind imported, an empty @theme block for you to fill in), and pages/_app.js. Call this ONCE, first, before writing any other file, whenever you're starting a new real web product/website from an empty project - it replaces hand-writing those five files yourself, which is exactly where version-guessing and Tailwind v4 config mistakes have come from. It does NOT write pages/index.js or any component - that's the actual product, still yours to design and write. After it returns, edit styles/globals.css to add this project's real brand colors/fonts to the @theme block (never ship it empty) - do not otherwise rewrite the five scaffolded files from scratch. Skip this tool entirely for a continuation turn on a project that already has a package.json, or for a non-Next.js/non-web request.",
      parameters: {
        type: "object",
        properties: {
          projectName: {
            type: "string",
            description: "Optional short kebab-case name for package.json's \"name\" field (e.g. \"ember-oak-roastery\"). Defaults to a generic name if omitted - purely cosmetic, never blocks anything.",
          },
          reason: REASON_PARAM,
        },
        required: ["reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read a file's real, current content from the session. Use this for a file that isn't already shown to you - never guess a file's contents from its name or from what you meant to write earlier. Reads the persisted source of truth directly, so this works even before the runtime has finished starting.",
      parameters: {
        type: "object",
        properties: {
          path: PATH_PARAM,
          reason: REASON_PARAM,
        },
        required: ["path", "reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description:
        "List one directory's real entries (files and subdirectories, one level deep - not recursive). Use an empty string for the session root. Use this to confirm what actually exists rather than assuming. If this reports a directory as empty but you have real reason to believe it isn't (you wrote files there yourself earlier in this conversation, or the user just told you the project already exists), do not trust that at face value and do not start rebuilding from scratch - cross-check first with run_command (e.g. \"ls -la\" or \"ls -la <path>\"), which reads the real, currently-running filesystem independently of this tool. Only treat the project as genuinely empty once a second, independent check agrees.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Session-relative directory path, or an empty string for the session root.",
          },
          reason: REASON_PARAM,
        },
        required: ["path", "reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description:
        "Run a real shell command in the session's runtime - install dependencies, run a build/test, start a dev server, inspect anything. This executes for real; its result is the command's actual exit code and output, never a guess. Set background to true ONLY for a command meant to keep running after this step (a dev server, a watcher) - omit/false for installs, builds, tests, and one-shot commands so you get the real exit code back immediately. For a background command, this already waits briefly and checks real readiness for you before responding: it tells you plainly whether the server is Ready (with its port/URL) or Still starting (normal for a fresh install/compile) - you do not need to sleep, retry, or poll for it yourself, and this shell may not even have sleep/pkill available. If it's still starting, just call view_preview when you want to check it - that call waits for readiness on its own too. Restarting the same background command while it's already healthy reuses the existing server instead of spawning a duplicate.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The exact shell command to run.",
          },
          cwd: {
            type: "string",
            description:
              "Session-relative working directory. Omit to run at the session root.",
          },
          background: {
            type: "boolean",
            description:
              "True only for a long-running command (a dev server, a watcher) that should keep running after this step returns.",
          },
          reason: REASON_PARAM,
        },
        required: ["command", "reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "view_preview",
      description:
        "See a real screenshot of the running application, exactly as a person would see it, plus a written critique of what's actually visible (layout, hierarchy, whether it looks considered or generic). Start the dev server with run_command (background: true) first. This call already waits for the workspace to become ready and for the page to actually paint, within a bounded amount of time - you do not need to sleep, retry, or poll manually first; just call it. Captures a normal desktop viewport by default. Use this at meaningful checkpoints: after the first version of a UI is up, and again after a real visual change - never after every small file edit. The result's `status` tells you whether a screenshot exists at all (success/starting/not_ready/unavailable/failed) - \"starting\" means it's still worth calling again shortly, \"unavailable\" means the workspace genuinely crashed (the message says why, don't retry blindly); its separate `analysis` field tells you whether the written critique is available - a screenshot can succeed even when the critique doesn't (e.g. a rate-limited vision call). Don't keep calling this hoping for a different analysis result on the same screenshot - verify visual concerns through the screenshot itself and move on.",
      parameters: {
        type: "object",
        properties: {
          viewport: {
            type: "object",
            description:
              "Optional viewport size in pixels. Omit for the default desktop viewport.",
            properties: {
              width: { type: "number" },
              height: { type: "number" },
            },
          },
          reason: REASON_PARAM,
        },
        required: ["reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_progress",
      description:
        "Record or update your own tracking of this task - not a message to the user, your own working notes. `objective` is the FULL original request, every part of it, not just whatever you're currently focused on: \"build a coffee site and add a pricing section\" is one objective covering both, and finishing the coffee site doesn't complete it while pricing is still pending. Break it into `subgoals` - meaningful product deliverables (\"build the product catalog\", \"add responsive behavior\"), not individual files (\"create Header.js\") - a subgoal should track a piece of the product, not a checklist of files. If the request names or clearly implies multiple distinct pages/sections/features (\"home, collections, products, and cart\"), give EACH one its own subgoal - a single vague subgoal covering all of them lets you mark the whole thing done after building only one. Call this once early, right after you've planned the work, then again at real milestones - a deliverable's files are actually all written, the runtime is verified, view_preview has confirmed the visual result - not after every individual file. Update it BEFORE claiming a turn is finished so it reflects what you actually verified, not just what you attempted. Mark a subgoal \"blocked\" only when you've made a real attempt and hit a genuine, specific obstacle - explain the obstacle in its description. A subproblem (e.g. a CSS loading error) is a blocker on ONE subgoal, never a reason to stop tracking or working on the others: if one subgoal is blocked, move to a different pending one rather than retrying the same fix indefinitely. Also include `projectContract` on that same first call, before you write any implementation files - your own explicit decision about this project's stack and conventions (framework, router, language, styling, path aliases, import convention, package manager). State it once; it's remembered automatically on every later call, including continuation turns, so you never need to repeat it - only pass it again if a decision genuinely changes. Do not call this as busywork on every step - only when your actual plan or a status genuinely changes.",
      parameters: {
        type: "object",
        properties: {
          objective: {
            type: "string",
            description: "The complete original request, in your own words, covering every part of it.",
          },
          subgoals: {
            type: "array",
            description: "Meaningful product deliverables this objective breaks down into - not one entry per file.",
            items: {
              type: "object",
              properties: {
                description: { type: "string", description: "One short, concrete piece of work." },
                status: {
                  type: "string",
                  enum: ["pending", "in_progress", "blocked", "done"],
                  description:
                    "pending: not started. in_progress: actively working on it now. blocked: a real, specific obstacle stopped it - explain the obstacle in the description. done: genuinely finished, not just attempted.",
                },
              },
              required: ["description", "status"],
            },
          },
          projectContract: {
            type: "object",
            description:
              "Your explicit stack/convention decision for THIS project, stated once before writing implementation files. Every field is free text describing the actual project, not a fixed enum - state what's really true. Enforced: writing a file whose imports or extension contradict this gets rejected before it's persisted, so get pathAliases and language right.",
            properties: {
              framework: { type: "string", description: "e.g. \"Next.js 15\"." },
              router: { type: "string", description: "e.g. \"Pages Router\"." },
              language: { type: "string", description: "e.g. \"JavaScript\" or \"TypeScript\" - exact casing matters, this gates the .ts/.tsx check." },
              styling: { type: "string", description: "e.g. \"Tailwind CSS v4\"." },
              pathAliases: {
                type: "string",
                description:
                  "The actual alias configuration, or \"NONE\" if you haven't configured one. If this doesn't contain \"@\", any \"@/...\" import in a written file is rejected - only describe a real \"@/...\" alias here if you've genuinely added a jsconfig.json/tsconfig.json \"paths\" entry for it.",
              },
              importConvention: { type: "string", description: "e.g. \"Relative imports\" or \"Alias imports (@/...)\" - should agree with pathAliases." },
              packageManager: { type: "string", description: "e.g. \"npm\"." },
            },
            required: ["framework", "router", "language", "styling", "pathAliases", "importConvention", "packageManager"],
          },
          manifest: {
            type: "object",
            description:
              "Optional, and every field within it is also optional - a compact plan for a small website, not a second required contract. State this once, briefly, on your first call, alongside projectContract: what kind of product this is, what routes it needs, and roughly which files you intend to write for the first working version. This establishes \"this is a small website\" so the file-count guideline scales to the actual project instead of a blind default - it's a few words per field, not an architectural essay.",
            properties: {
              projectType: { type: "string", description: "e.g. \"marketing_site\", \"portfolio\", \"saas_dashboard\"." },
              routes: { type: "array", items: { type: "string" }, description: "Real routes/pages this product needs, e.g. [\"/\"] for a single landing page." },
              targetFiles: { type: "array", items: { type: "string" }, description: "The files you actually intend to write for the first working version - your plan, not an exhaustive final list." },
              fileBudget: { type: "number", description: "An explicit file-count guideline for this project, if you want to state one directly instead of implying it from targetFiles/routes." },
            },
          },
        },
        required: ["objective", "subgoals"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_presentation",
      description:
        "Generate a real, downloadable .pptx presentation as a project artifact - for a request like \"create a pitch deck\" or \"make a 7-slide presentation about X\". You provide structured slide CONTENT (headings, body text, bullets) - never binary/base64 PPTX data yourself; a deterministic engine turns your structure into the actual polished file, applying its own typography, layout, and theme. Plan a structure that fits the specific request (do not reuse a fixed template) - e.g. a pitch deck might be title, problem, solution, how it works, results, closing; a technical explainer might be title, background, architecture, implementation, results, conclusion. Choose the slide `type` that best fits each piece of content - do not force every slide into the same type. Keep each field reasonably concise (a slide is glanced at, not read like a document) - very long text is automatically fitted/truncated to stay readable, but writing tight content yourself produces a better result than relying on that. Returns the real outcome (slide count and where it was saved) on success, or a clear reason on failure - never assume it succeeded before this returns ok.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "The presentation's title (shown on the title slide)." },
          subtitle: { type: "string", description: "Optional subtitle for the title slide." },
          slides: {
            type: "array",
            description: "The full slide sequence, in order. 1-30 slides.",
            items: {
              type: "object",
              properties: {
                type: {
                  type: "string",
                  enum: ["title", "title_content", "two_column", "image_content", "section", "quote", "closing"],
                  description:
                    "title: opening slide (heading/subheading). title_content: a heading plus body text or bullets - the workhorse type. two_column: two side-by-side headed bullet lists, for a comparison or before/after. image_content: heading+body next to a labeled image placeholder (no real image is generated - this is an honest placeholder, use it only when a real image would genuinely help). section: a big, minimal divider slide between parts of the deck. quote: one large quote plus an optional attribution. closing: the final slide (e.g. \"Thank you\").",
                },
                heading: { type: "string" },
                subheading: { type: "string" },
                body: { type: "string", description: "Paragraph body text - for title_content/image_content/closing." },
                bullets: { type: "array", items: { type: "string" }, description: "For title_content - a bulleted list instead of body text." },
                columnLeftHeading: { type: "string" },
                columnLeftBullets: { type: "array", items: { type: "string" } },
                columnRightHeading: { type: "string" },
                columnRightBullets: { type: "array", items: { type: "string" } },
                imageCaption: { type: "string", description: "Label shown on the image placeholder, for image_content." },
                quote: { type: "string", description: "Required for type quote." },
                attribution: { type: "string", description: "Who said the quote, for type quote." },
                notes: { type: "string", description: "Optional speaker notes - never shown on the slide itself." },
              },
              required: ["type"],
            },
          },
          reason: REASON_PARAM,
        },
        required: ["title", "slides", "reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_image",
      description:
        "Generate a real image as a project artifact - for a request like \"create a hero image\" or \"generate an illustration of X\". A hosted image model produces real bytes; this never returns a placeholder. Write a specific, visual prompt (subject, composition, mood, style) - vague prompts produce generic results. Returns the real outcome (dimensions and where it was saved) on success, or a clear reason on failure - never assume it succeeded before this returns ok. Image generation can fail (provider unavailable, rate-limited) - if it does, say so honestly rather than claiming an image exists.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "A specific, visual description of the image to generate." },
          aspectRatio: {
            type: "string",
            enum: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"],
            description: "Optional - defaults to the model's own default if omitted.",
          },
          title: { type: "string", description: "Optional short title for the artifact - defaults to a shortened version of the prompt." },
          reason: REASON_PARAM,
        },
        required: ["prompt", "reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_image",
      description:
        "Edit an EXISTING image artifact already in this project (never an arbitrary URL) - for a request like \"make this warmer\" or \"increase the contrast.\" Always produces a NEW artifact; the original image is never overwritten or modified. Use list_files or the conversation's own history to find the source image's artifact id first if you don't already have it. Returns the real outcome on success, or a clear reason on failure.",
      parameters: {
        type: "object",
        properties: {
          sourceArtifactId: { type: "string", description: "The id of the existing image artifact to edit." },
          instruction: { type: "string", description: "The specific edit to make." },
          title: { type: "string", description: "Optional title for the new, edited artifact." },
          reason: REASON_PARAM,
        },
        required: ["sourceArtifactId", "instruction", "reason"],
      },
    },
  },
];
