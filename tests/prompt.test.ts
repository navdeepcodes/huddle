import { describe, expect, it } from "vitest";

import { SYSTEM_PROMPT } from "@/lib/agent/prompt";

/**
 * Phase 20: guards the two prompt-level fixes for the batching gap
 * (observed live, repeatedly: ~1 file per iteration despite the prompt
 * already saying to batch) and the "fix every instance before
 * re-running" debugging gap (observed live: the model sometimes fixed
 * one @/-alias violation, rebuilt, found the next, rebuilt again).
 * Same discipline as tools.test.ts's guidance-presence tests - proves
 * the instruction can't silently regress out of the prompt, not that a
 * real model follows it (that's the live benchmark's job).
 */
describe("SYSTEM_PROMPT - batching guidance (Phase 20 regression)", () => {
  it("gives concrete batching units, not just an abstract instruction to batch", () => {
    expect(SYSTEM_PROMPT).toContain("config/package files");
    expect(SYSTEM_PROMPT.toLowerCase()).toContain("data files");
  });

  it("keeps the explicit escape hatch so batching is never forced over correctness", () => {
    expect(SYSTEM_PROMPT).toContain("correctness matters more than batching");
  });
});

describe("SYSTEM_PROMPT - fix-all-instances debugging guidance (Phase 20 regression)", () => {
  it("instructs fixing every instance of a repeated mistake before re-running, not one-by-one", () => {
    expect(SYSTEM_PROMPT).toContain("fix every instance in one pass");
  });
});

describe("SYSTEM_PROMPT - error priority and generalized error clustering (Phase 21 regression)", () => {
  it("tells the model a blocking render error outranks unstarted features or polish", () => {
    expect(SYSTEM_PROMPT.toLowerCase()).toContain("outranks an unstarted feature");
  });

  it("generalizes error-clustering beyond imports to icons, dependencies, framework conventions, and CSS config", () => {
    expect(SYSTEM_PROMPT).toContain("invalid icon imports");
    expect(SYSTEM_PROMPT).toContain("missing dependencies");
    expect(SYSTEM_PROMPT.toLowerCase()).toContain("css/tailwind config errors");
  });

  it("blocks claiming done while view_preview's last result shows a blocking error", () => {
    expect(SYSTEM_PROMPT).toContain("Never call it done while view_preview's last real result shows a blocking error");
  });
});

/**
 * Phase 25: audit found the version-guidance example block still said
 * "lucide-react": "^0" - stale relative to the real current major (1.x,
 * confirmed by Huddle's own installed lucide-react version). Left
 * as-is, this actively taught the model to pin an outdated range on
 * every generated project - a predictable generation mistake the
 * prompt itself was causing.
 */
describe("SYSTEM_PROMPT - lucide-react version guidance (Phase 25 regression)", () => {
  it("points generated projects at the current major version, not a stale ^0 range", () => {
    expect(SYSTEM_PROMPT).toContain('"lucide-react": "^1"');
    expect(SYSTEM_PROMPT).not.toContain('"lucide-react": "^0"');
  });
});

describe("SYSTEM_PROMPT - error classification framework (Phase 25 regression)", () => {
  it("gives the model an explicit local/systemic/configuration/dependency/architectural framework", () => {
    expect(SYSTEM_PROMPT).toContain("**Local**");
    expect(SYSTEM_PROMPT).toContain("**Systemic**");
    expect(SYSTEM_PROMPT).toContain("**Configuration-level**");
    expect(SYSTEM_PROMPT).toContain("**Dependency-level**");
    expect(SYSTEM_PROMPT).toContain("**Architectural**");
  });
});

describe("SYSTEM_PROMPT - full-scope completion gate (Phase 25 regression)", () => {
  it("requires naming every distinct page/section/feature the request implies before declaring done", () => {
    expect(SYSTEM_PROMPT.toLowerCase()).toContain("name every distinct page/section/feature");
  });

  it("gives the concrete four-page example so a homepage-only build isn't mistaken for done", () => {
    expect(SYSTEM_PROMPT).toContain("home, collections, products, and cart");
  });
});

describe("SYSTEM_PROMPT - asset/photography discipline (Phase 25 regression)", () => {
  it("tells the model photography is a deliberate choice, not a default", () => {
    expect(SYSTEM_PROMPT.toLowerCase()).toContain("no photography at all");
  });
});

/**
 * Phase 41 (GENERATION QUALITY + PERFORMANCE): live benchmarking found
 * section 5 flatly told the model "You cannot generate ... binary image
 * files here" while a later section instructed using create_image for
 * exactly that - a direct self-contradiction. Confirmed live: create_image
 * has never been called across 8+ real builds. Guards against the false
 * claim regressing back in, and that the two real image sources
 * (LoremFlickr for ordinary photography, create_image/edit_image used
 * selectively for hero/brand imagery) are both described accurately.
 */
describe("SYSTEM_PROMPT - image generation is described accurately, not as impossible (Phase 41 regression)", () => {
  it("never claims binary image generation is impossible - create_image is a real, working tool", () => {
    expect(SYSTEM_PROMPT.toLowerCase()).not.toContain("cannot generate, fetch, or self-host binary image files");
  });

  it("tells the model create_image/edit_image output needs no remotePatterns entry, since it's served from this project's own public/ folder", () => {
    expect(SYSTEM_PROMPT).toContain("public/");
    expect(SYSTEM_PROMPT.toLowerCase()).toContain("no remote host, no");
  });

  it("tells the model to use generation selectively - hero/brand imagery, not one image per section", () => {
    expect(SYSTEM_PROMPT.toLowerCase()).toContain("never one per section");
  });
});

/**
 * Phase 41: root-caused a real, reproducible build failure - a
 * contraction apostrophe ("doesn't") inside a single-quoted JS string
 * terminates it early and produces a confusing parser error far from
 * the actual cause. Live evidence: the model twice misdiagnosed this as
 * an em-dash problem and rebuilt twice before the real fix landed by
 * accident. Guards the prompt rule that should prevent it recurring.
 */
describe("SYSTEM_PROMPT - quote-style guidance for narrative copy (Phase 41 regression)", () => {
  it("tells the model to prefer double-quoted/template-literal strings for body copy, since apostrophes are common", () => {
    expect(SYSTEM_PROMPT.toLowerCase()).toContain("prefer double-quoted strings");
  });
});

/**
 * Phase 41: correctness (no hallucinated brand icons) was already
 * solved; taste (using icons only when they communicate something,
 * not as decoration) was not addressed. Guards the new sentence.
 */
describe("SYSTEM_PROMPT - purposeful icon use, not decorative (Phase 41 regression)", () => {
  it("tells the model an icon earns its place by communicating something real", () => {
    expect(SYSTEM_PROMPT.toLowerCase()).toContain("communicates something real");
  });
});
