import "server-only";

import type { ChatCompletionTool } from "openai/resources/chat/completions";

/**
 * Huddle's v1 tool vocabulary - native OpenAI-style function calling,
 * not prose parsed out of a fenced block (that failure mode is exactly
 * what native tool calling exists to avoid - see apostle's
 * lib/codespace/tools.ts for the original, live-confirmed reasoning).
 *
 * Seven tools for the golden path. commit/push exist in the proven
 * legacy set but aren't registered here - nothing in "one message ->
 * working product" needs git, and adding them back later (Phase 4,
 * when GitHub integration is real) is a new file, not a rewrite of
 * this one.
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
        "Create a new file, or overwrite an existing one, with its complete new content. Not a diff/patch - always the full file text as it should be after the change. When editing a file whose content you were shown, reproduce it in full with only the necessary lines changed. Multiple write_file calls in the same step are persisted together as one batch - every single call must include its own complete path and content; a call missing either is rejected and none of the others in the batch are affected.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Required. Session-relative path, no leading slash (e.g. \"components/Header.js\"). Every write_file call needs its own path, even when writing many files in one step.",
          },
          content: {
            type: "string",
            description: "The complete file content after this change.",
          },
          reason: REASON_PARAM,
        },
        required: ["path", "content", "reason"],
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
      name: "create_directory",
      description:
        "Create a folder, and any missing parent folders. Usually unnecessary before write_file, which creates missing parent folders for you. Call this directly only when you want an empty folder to exist with nothing in it yet.",
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
        },
        required: ["objective", "subgoals"],
      },
    },
  },
];
