import * as LucideIcons from "lucide-react";

import type { ProjectContract } from "@/types/session";

/**
 * Phase 18: cheap, deterministic pre-flight checks for generation
 * mistakes actually observed live (Ember x2, the Phase 17
 * coffee-testimonials run) - see ProjectContract's own doc comment for
 * the path-alias/language root cause. The two contract-gated checks
 * (path aliases, TS-in-a-JS-project) return null unless BOTH a contract
 * has been explicitly set AND the file's own content contradicts it -
 * an unset contract never blocks anything, since there's nothing yet to
 * check against. checkIconImports (Phase 25) is NOT contract-gated - a
 * hallucinated icon name is wrong independent of any stack decision, so
 * it runs on every write regardless of whether a contract exists yet.
 * All of it runs against a candidate write BEFORE it's persisted (see
 * loop.ts), so the mistake is caught at generation time instead of
 * discovered later via a runtime/build error.
 *
 * Deliberately narrow - this is NOT a linter or a syntax checker. It
 * catches classes of mistake with hard, cheap, unambiguous evidence (an
 * "@/" import string with no declared "@" alias; a .ts/.tsx file in a
 * JavaScript project; a named import from "lucide-react" that isn't a
 * real export of the actual installed package) - not Tailwind v3-vs-v4
 * syntax, not made-up package versions, not wrong Next.js router APIs.
 * Those need real semantic understanding disproportionate to "cheap and
 * deterministic," and stay owned by the prompt's own explicit guidance,
 * npm install's own failure, or view_preview's own visual inspection -
 * this mechanism generalizes by being reusable for a FUTURE cheap check
 * of the same shape, not by trying to enumerate every possible mistake
 * now.
 *
 * Phase 25: the lucide-react check below validates against the REAL
 * installed package (`Object.keys(LucideIcons)`, ~6000 real export
 * names including both "Home" and "HomeIcon" aliases) - not a
 * hardcoded/hand-maintained list, so it can never drift out of sync
 * with whatever lucide-react version Huddle itself has installed (see
 * the prompt's own version-pinning guidance, which points generated
 * projects at the same major version).
 */

const ALIAS_IMPORT_RE = /from\s+["'](@\/[^"']+)["']/;
const TS_EXTENSION_RE = /\.(ts|tsx)$/;

function declaresAtAlias(pathAliases: string): boolean {
  return pathAliases.includes("@");
}

function isJavaScriptContract(language: string): boolean {
  return /^javascript$/i.test(language.trim());
}

export function checkImportConventions(
  path: string,
  content: string,
  contract: ProjectContract | undefined
): string | null {
  const iconViolation = checkIconImports(path, content);
  if (iconViolation) return iconViolation;

  if (!contract) return null;

  if (!declaresAtAlias(contract.pathAliases)) {
    const match = content.match(ALIAS_IMPORT_RE);
    if (match) {
      return (
        `This project's contract declares path aliases as "${contract.pathAliases}", but ${path} imports from ` +
        `"${match[1]}" - use a relative import instead (e.g. "../components/...", matching this file's actual ` +
        `location), or update the contract via update_progress first if you've genuinely added real alias ` +
        `configuration (a jsconfig.json/tsconfig.json with a "paths" entry).`
      );
    }
  }

  if (isJavaScriptContract(contract.language) && TS_EXTENSION_RE.test(path)) {
    return (
      `This project's contract declares the language as "${contract.language}", but ${path} is a TypeScript file - ` +
      `use .js/.jsx instead, or update the contract via update_progress first if you've genuinely decided to use TypeScript.`
    );
  }

  return null;
}

const LUCIDE_IMPORT_RE = /import\s*\{([^}]*)\}\s*from\s*["']lucide-react["']/g;
const VALID_LUCIDE_EXPORTS = new Set(Object.keys(LucideIcons));

/**
 * Not gated on a projectContract (unlike the two checks above) - a
 * hallucinated icon name is wrong regardless of what stack/convention
 * the project declared, so this runs on every write_file call
 * unconditionally. Deterministic and cheap: one regex extraction plus a
 * Set lookup per imported name, no semantic understanding needed.
 */
export function checkIconImports(path: string, content: string): string | null {
  for (const match of content.matchAll(LUCIDE_IMPORT_RE)) {
    const names = match[1]
      .split(",")
      .map((n) => n.trim())
      .filter(Boolean)
      .map((n) => n.split(/\s+as\s+/)[0].trim());

    for (const name of names) {
      if (!VALID_LUCIDE_EXPORTS.has(name)) {
        return (
          `${path} imports "${name}" from "lucide-react", but that isn't a real export of the installed lucide-react ` +
          `version - it's likely a hallucinated icon name. Use a real icon (e.g. check the exact spelling/casing) or ` +
          `pick a different one that actually exists.`
        );
      }
    }
  }

  return null;
}
