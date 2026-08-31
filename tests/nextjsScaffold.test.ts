import { describe, expect, it } from "vitest";

import { buildNextjsScaffoldFiles } from "@/lib/scaffold/nextjsScaffold";

describe("buildNextjsScaffoldFiles (Phase 39)", () => {
  it("writes exactly the seven proven config/plumbing files, never pages/index.js", () => {
    const files = buildNextjsScaffoldFiles("Ember & Oak");
    const paths = files.map((f) => f.path).sort();
    expect(paths).toEqual([
      "next.config.mjs",
      "package.json",
      "postcss.config.mjs",
      "pages/_app.js",
      "styles/globals.css",
      "lib/utils.js",
      "lib/ErrorBoundary.js",
    ].sort());
    expect(paths).not.toContain("pages/index.js");
  });

  it("package.json uses the exact proven, unpinned version ranges - never a guessed pre-release tag", () => {
    const pkg = JSON.parse(buildNextjsScaffoldFiles().find((f) => f.path === "package.json")!.content);
    expect(pkg.dependencies).toEqual({
      next: "^15",
      react: "^19",
      "react-dom": "^19",
      "lucide-react": "^1",
      "react-icons": "^5",
      clsx: "^2",
      "tailwind-merge": "^2",
    });
    expect(pkg.devDependencies).toEqual({
      tailwindcss: "^4",
      "@tailwindcss/postcss": "^4",
    });
    for (const range of [...Object.values(pkg.dependencies), ...Object.values(pkg.devDependencies)]) {
      expect(range).not.toMatch(/alpha|beta|insiders|canary|rc|-/);
    }
  });

  it("lib/utils.js exports a cn() helper built on clsx + tailwind-merge", () => {
    const content = buildNextjsScaffoldFiles().find((f) => f.path === "lib/utils.js")!.content;
    expect(content).toContain("export function cn(");
    expect(content).toContain('from "clsx"');
    expect(content).toContain('from "tailwind-merge"');
  });

  it("lib/ErrorBoundary.js is a real React error boundary (getDerivedStateFromError + a fallback)", () => {
    const content = buildNextjsScaffoldFiles().find((f) => f.path === "lib/ErrorBoundary.js")!.content;
    expect(content).toContain("getDerivedStateFromError");
    expect(content).toContain("export class ErrorBoundary");
  });

  it("slugifies a human-readable project name into a valid package.json name", () => {
    const pkg = JSON.parse(buildNextjsScaffoldFiles("Ember & Oak Roastery!").find((f) => f.path === "package.json")!.content);
    expect(pkg.name).toBe("ember-oak-roastery");
  });

  it("falls back to a generic name when none is given or it slugifies to nothing", () => {
    expect(JSON.parse(buildNextjsScaffoldFiles().find((f) => f.path === "package.json")!.content).name).toBe("huddle-project");
    expect(JSON.parse(buildNextjsScaffoldFiles("!!!").find((f) => f.path === "package.json")!.content).name).toBe("huddle-project");
  });

  it("postcss.config.mjs uses the v4 @tailwindcss/postcss plugin, not the v3 bare-plugin wiring", () => {
    const content = buildNextjsScaffoldFiles().find((f) => f.path === "postcss.config.mjs")!.content;
    expect(content).toContain("@tailwindcss/postcss");
    expect(content).not.toContain('"tailwindcss": {}');
  });

  it("globals.css imports tailwindcss the v4 way, with only a commented example inside @theme - no live fake declaration", () => {
    const content = buildNextjsScaffoldFiles().find((f) => f.path === "styles/globals.css")!.content;
    expect(content).toContain('@import "tailwindcss";');
    expect(content).toContain("@theme {");
    // Any example values live inside the /* ... */ comment, never as a real, active CSS declaration.
    const themeBody = content.slice(content.indexOf("@theme {") + "@theme {".length, content.lastIndexOf("}"));
    const withoutComments = themeBody.replace(/\/\*[\s\S]*?\*\//g, "").trim();
    expect(withoutComments).toBe("");
  });

  it("_app.js imports the scaffolded globals.css path and wraps every page in the error boundary", () => {
    const content = buildNextjsScaffoldFiles().find((f) => f.path === "pages/_app.js")!.content;
    expect(content).toContain('import "../styles/globals.css"');
    expect(content).toContain('import { ErrorBoundary } from "../lib/ErrorBoundary"');
    expect(content).toContain("<ErrorBoundary>");
  });

  it("next.config.mjs has an empty remotePatterns array ready to extend, never a guessed hostname", () => {
    const content = buildNextjsScaffoldFiles().find((f) => f.path === "next.config.mjs")!.content;
    expect(content).toContain("remotePatterns: []");
  });
});
