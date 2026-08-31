import "server-only";

/**
 * Phase 39: live A/B evidence (2026-08-25, the user's own side-by-side
 * Replit comparison against this exact same "coffee roastery landing
 * page" request) showed Replit's agent finishing in ~3 minutes against
 * a pre-built app scaffold (src/App.tsx + src/index.css + one image on
 * top of an already-configured template), where Huddle's agent was
 * still generating package.json/next.config.mjs/postcss.config.mjs/
 * globals.css from scratch via the model, by hand, minutes in - the
 * exact source of several already-confirmed live bugs this session
 * (guessed pre-release Tailwind versions, wrong v3-style PostCSS
 * wiring, TypeScript syntax leaking into a .js file). None of that
 * boilerplate is creative content the model should be generating fresh
 * every single build - it's the same handful of proven-correct files
 * every time, which is exactly what a deterministic tool (matching
 * create_presentation's own reasoning: the model provides content, an
 * engine owns the mechanical output) should own instead.
 *
 * Deliberately narrow: only the config/plumbing prompt.ts already
 * specifies exactly (Pages Router, JS, Tailwind v4, lucide-react, the
 * proven version ranges) - never pages/index.js or any component,
 * which is genuinely creative content the model must still write
 * itself. `theme` is intentionally left for the model to fill in via
 * an ordinary write_file to styles/globals.css afterward - a real
 * brand's colors/fonts aren't boilerplate, and scaffolding fake
 * placeholder values would just be a second thing to overwrite.
 *
 * Phase 40 (2026-08-25): the user pulled the actual Replit-generated
 * project directory for this same coffee-roastery request off disk
 * (not a screenshot - the real files) to make a specific point: their
 * agent's own git history shows the entire app shell - build tooling,
 * routing, an error boundary, a components/hooks kit - lands in ONE
 * deterministic commit, and the only files a person actually wrote
 * were the page content, the theme, and one image. Investigated before
 * copying it wholesale: Huddle's runtime is a real StackBlitz
 * WebContainer (lib/runtime/webcontainerRuntime.ts) same as Replit's
 * dev-server model, but this repo's own prompt.ts already carries a
 * live-confirmed, hard-won finding that Next.js **Pages Router**
 * (unlike App Router) boots and renders cleanly there - so this stays
 * Next.js rather than following Replit's Vite choice; re-litigating a
 * proven-working router to chase a framework match would be trading a
 * confirmed-safe result for an unverified one. What DOES carry over
 * cleanly, because the reference project's own App.tsx shows it's
 * genuinely just React with no Vite-specific API surface: an error
 * boundary (so one broken section shows its own fallback instead of
 * taking the whole preview down - the most literal read of "our
 * preview shouldn't crash"), a `cn()` class-merge helper (the one
 * utility nearly every hand-rolled component ends up wanting), and -
 * the highest-leverage single addition - `react-icons`. The recurring
 * brand-icon hallucination this session (Github/Linkedin/Instagram
 * from lucide-react, which has never carried brand marks in the
 * version this project pins) turned out to be exactly what the
 * reference project's own App.tsx needed too; their fix wasn't a
 * smarter model, it was having a real package installed that actually
 * exports these icons. `autoFixBrandIcons` (importConventionCheck.ts)
 * stays on as a safety net for the rare slip, but this is the real
 * fix, not a substitute standing in for one.
 */
export interface ScaffoldFile {
  path: string;
  content: string;
}

export function buildNextjsScaffoldFiles(projectName?: string): ScaffoldFile[] {
  const name = (projectName ?? "huddle-project")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "huddle-project";

  return [
    {
      path: "package.json",
      content: JSON.stringify(
        {
          name,
          private: true,
          scripts: {
            dev: "next dev",
            build: "next build",
            start: "next start",
          },
          dependencies: {
            next: "^15",
            react: "^19",
            "react-dom": "^19",
            "lucide-react": "^1",
            "react-icons": "^5",
            clsx: "^2",
            "tailwind-merge": "^2",
          },
          devDependencies: {
            tailwindcss: "^4",
            "@tailwindcss/postcss": "^4",
          },
        },
        null,
        2
      ) + "\n",
    },
    {
      path: "next.config.mjs",
      content: `/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    // Add { protocol: "https", hostname: "..." } here for any external
    // image host you hotlink from - required or next/image throws at
    // runtime, not build time.
    remotePatterns: [],
  },
};

export default nextConfig;
`,
    },
    {
      path: "postcss.config.mjs",
      content: `export default {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};
`,
    },
    {
      path: "styles/globals.css",
      content: `@import "tailwindcss";

@theme {
  /* Add this project's real brand colors/fonts here, e.g.:
     --color-brand-500: #...;
     --font-display: "...", sans-serif;
     Do not leave this block empty in the finished product - a real
     visual direction belongs here, inferred from the actual request. */
}
`,
    },
    {
      path: "pages/_app.js",
      content: `import "../styles/globals.css";
import { ErrorBoundary } from "../lib/ErrorBoundary";

export default function App({ Component, pageProps }) {
  return (
    <ErrorBoundary>
      <Component {...pageProps} />
    </ErrorBoundary>
  );
}
`,
    },
    {
      path: "lib/utils.js",
      content: `import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

// Merge Tailwind classes without duplicate/conflicting utilities winning
// by source order alone, e.g. cn("px-2", condition && "px-4").
export function cn(...inputs) {
  return twMerge(clsx(inputs));
}
`,
    },
    {
      path: "lib/ErrorBoundary.js",
      content: `import { Component } from "react";

// One broken section (a bad prop, an undefined map over missing data)
// shows its own fallback instead of taking the whole preview down.
export class ErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("ErrorBoundary caught an error:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex min-h-screen w-full items-center justify-center bg-neutral-50 p-6">
          <div className="w-full max-w-lg text-center">
            <h1 className="text-xl font-semibold text-neutral-900">Something went wrong</h1>
            <p className="mt-2 text-sm text-neutral-600">
              This part of the page hit an error. Fix the component and it will recover on the next save.
            </p>
            <pre className="mt-4 overflow-x-auto rounded bg-neutral-100 p-3 text-left text-xs text-neutral-800">
              {this.state.error.message || String(this.state.error)}
            </pre>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
`,
    },
  ];
}
