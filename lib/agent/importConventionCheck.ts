import * as LucideIcons from "lucide-react";
import * as FaIcons from "react-icons/fa";
import * as SiIcons from "react-icons/si";

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
 * Phase 40: react-icons/fa and react-icons/si are what the prompt now
 * points the model at for brand/logo icons (see BRAND_ICON_SUBSTITUTES'
 * own doc comment - lucide-react never carries these). Validated the
 * same way as lucide-react below and for the same reason: a large,
 * memorized-from-training-data icon set is exactly the shape of thing
 * a model gets confidently, plausibly wrong (e.g. "FaXTwitter" instead
 * of "FaTwitter"), and this is cheap enough to check for real instead
 * of hoping the prompt's naming pattern is followed exactly.
 */
const ICON_IMPORT_SOURCES: Array<{
  re: RegExp;
  validNames: Set<string>;
  label: string;
}> = [
  { re: LUCIDE_IMPORT_RE, validNames: VALID_LUCIDE_EXPORTS, label: "lucide-react" },
  {
    re: /import\s*\{([^}]*)\}\s*from\s*["']react-icons\/fa["']/g,
    validNames: new Set(Object.keys(FaIcons)),
    label: "react-icons/fa",
  },
  {
    re: /import\s*\{([^}]*)\}\s*from\s*["']react-icons\/si["']/g,
    validNames: new Set(Object.keys(SiIcons)),
    label: "react-icons/si",
  },
];

/**
 * Live-reproduced root cause (2026-08-25): a real user's build spent
 * ~15 minutes and multiple provider-call retries (eventually aborting
 * outright) stuck repeatedly reimporting Github/Linkedin/Instagram
 * across Team.js/Footer.js - a completely reasonable choice for a
 * social-links section, rejected every single time. This installed
 * lucide-react version (confirmed via node -e against the real
 * package) has ZERO brand/logo icons at all - not a spelling issue,
 * a categorical gap the model has no way to know about from the name
 * alone.
 *
 * First fix (prompt guidance + a sharper reject message) reduced but
 * did NOT eliminate this - live-reproduced AGAIN the same day, same
 * mistake, on a fresh build, despite the model's own system prompt
 * stating the constraint outright. Telling it not to isn't reliable
 * enough on its own; a fix that doesn't depend on the model getting a
 * prose instruction right every single time is worth more than a
 * fourth round of stronger wording. So: silently substitute a
 * sensible generic icon and let the write succeed - zero retry, zero
 * burned iteration, zero chance to spiral - rather than reject and
 * make the model try again. The substitute is always spliced in as
 * `<Substitute> as <OriginalName>` (preserving any existing alias, or
 * aliasing back to the brand name itself if there wasn't one), so
 * every JSX usage elsewhere in the file keeps working completely
 * unchanged - only the single import line differs. This is
 * additive, not a rule the model has to remember: it can still name
 * whatever icon it wants, the environment just quietly makes the
 * unavailable ones work anyway.
 *
 * Phase 40: the scaffold now installs `react-icons`, and the prompt
 * points the model at `react-icons/fa`/`react-icons/si` for brand
 * icons directly - the real fix, not a workaround. This substitution
 * table stays on purely as a safety net for the rare case the model
 * reaches for lucide-react out of habit anyway; it should see
 * decreasing use over time as the prompt guidance actually lands.
 */
const BRAND_ICON_SUBSTITUTES: Record<string, string> = {
  github: "Link",
  gitlab: "Link",
  bitbucket: "Link",
  linkedin: "Link",
  twitter: "AtSign",
  x: "AtSign",
  instagram: "Camera",
  facebook: "Users",
  youtube: "Play",
  discord: "MessageCircle",
  slack: "MessageSquare",
  figma: "Layers",
  dribbble: "Circle",
  behance: "Layers",
  tiktok: "Music",
  whatsapp: "MessageCircle",
  telegram: "Send",
  spotify: "Music",
  twitch: "Video",
  pinterest: "Image",
  reddit: "MessageCircle",
  codepen: "Code",
  apple: "Circle",
  google: "Circle",
  microsoft: "Circle",
  amazon: "ShoppingBag",
  stripe: "CreditCard",
  paypal: "CreditCard",
};

export interface IconAutoFix {
  content: string;
  fixed: Array<{ from: string; to: string }>;
}

/** Runs BEFORE checkIconImports (see loop.ts's call site) so a brand name never reaches, and never triggers, the reject path below at all. */
export function autoFixBrandIcons(content: string): IconAutoFix | null {
  const fixed: Array<{ from: string; to: string }> = [];

  const newContent = content.replace(LUCIDE_IMPORT_RE, (fullMatch, namesRaw: string) => {
    const entries = namesRaw.split(",").map((n: string) => n.trim()).filter(Boolean);
    const rewritten = entries.map((entry: string) => {
      const [rawName, rawAlias] = entry.split(/\s+as\s+/).map((s) => s.trim());
      if (VALID_LUCIDE_EXPORTS.has(rawName)) return entry;

      const key = rawName.replace(/icon$/i, "").toLowerCase();
      const substitute = BRAND_ICON_SUBSTITUTES[key];
      if (!substitute) return entry;

      fixed.push({ from: rawName, to: substitute });
      return `${substitute} as ${rawAlias ?? rawName}`;
    });
    return fullMatch.replace(namesRaw, rewritten.join(", "));
  });

  return fixed.length > 0 ? { content: newContent, fixed } : null;
}

/**
 * Not gated on a projectContract (unlike the two checks above) - a
 * hallucinated icon name is wrong regardless of what stack/convention
 * the project declared, so this runs on every write_file call
 * unconditionally. Deterministic and cheap: one regex extraction plus a
 * Set lookup per imported name, no semantic understanding needed.
 *
 * By the time this runs, autoFixBrandIcons has already silently
 * resolved every KNOWN brand name (see loop.ts) - what's left here is
 * a genuine hallucination (a name that isn't real AND isn't a brand
 * this environment knows how to substitute), which still needs a real
 * reject, since there's no safe automatic guess for it.
 */
export function checkIconImports(path: string, content: string): string | null {
  for (const source of ICON_IMPORT_SOURCES) {
    for (const match of content.matchAll(source.re)) {
      const names = match[1]
        .split(",")
        .map((n) => n.trim())
        .filter(Boolean)
        .map((n) => n.split(/\s+as\s+/)[0].trim());

      for (const name of names) {
        if (!source.validNames.has(name)) {
          return (
            `${path} imports "${name}" from "${source.label}", but that isn't a real export of the installed ` +
            `${source.label} version - it's likely a hallucinated icon name. Use a real icon (e.g. check the exact ` +
            `spelling/casing) or pick a different one that actually exists.`
          );
        }
      }
    }
  }

  return null;
}
