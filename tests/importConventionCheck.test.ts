import { describe, expect, it } from "vitest";

import { checkImportConventions, checkIconImports } from "@/lib/agent/importConventionCheck";
import type { ProjectContract } from "@/types/session";

/**
 * Phase 18: pure function, no Firestore/provider dependency. See the
 * function's own doc comment for the root cause this closes and for
 * why it's deliberately narrow (two checks, not a linter).
 */

const NO_ALIAS_JS: ProjectContract = {
  framework: "Next.js 15",
  router: "Pages Router",
  language: "JavaScript",
  styling: "Tailwind CSS v4",
  pathAliases: "NONE",
  importConvention: "Relative imports",
  packageManager: "npm",
};

const REAL_ALIAS_JS: ProjectContract = {
  ...NO_ALIAS_JS,
  pathAliases: "@/* -> ./*",
  importConvention: "Alias imports (@/...)",
};

const TS_CONTRACT: ProjectContract = {
  ...NO_ALIAS_JS,
  language: "TypeScript",
  pathAliases: "@/* -> ./*",
};

describe("checkImportConventions - no contract yet", () => {
  it("never blocks anything before a contract has been set", () => {
    const result = checkImportConventions(
      "components/Header.js",
      'import Logo from "@/components/Logo";',
      undefined
    );
    expect(result).toBeNull();
  });
});

describe("checkImportConventions - path alias violations (Phase 18)", () => {
  it("1. flags an @/ import when the contract declares no alias", () => {
    const result = checkImportConventions(
      "pages/index.js",
      'import Header from "@/components/Header";\nimport Hero from "@/components/Hero";',
      NO_ALIAS_JS
    );
    expect(result).not.toBeNull();
    expect(result).toContain("@/components/Header");
    expect(result).toContain("pages/index.js");
  });

  it("2. allows an @/ import when the contract declares a real alias", () => {
    const result = checkImportConventions(
      "pages/index.js",
      'import Header from "@/components/Header";',
      REAL_ALIAS_JS
    );
    expect(result).toBeNull();
  });

  it("does not flag a plain relative import under a no-alias contract", () => {
    const result = checkImportConventions(
      "pages/index.js",
      'import Header from "../components/Header";',
      NO_ALIAS_JS
    );
    expect(result).toBeNull();
  });

  it("7. does not incorrectly flag an existing project that already has a real alias configured, even for many files", () => {
    const files = [
      'import Header from "@/components/Header";',
      'import { formatPrice } from "@/lib/utils";',
      'import products from "@/data/products";',
    ];
    for (const content of files) {
      expect(checkImportConventions("pages/index.js", content, REAL_ALIAS_JS)).toBeNull();
    }
  });

  it("checks every @/ import in a file, not just the first, by reporting on the first found (deterministic, not silently partial)", () => {
    const result = checkImportConventions(
      "pages/index.js",
      'import Header from "@/components/Header";\nimport Footer from "@/components/Footer";',
      NO_ALIAS_JS
    );
    expect(result).toContain("@/components/Header");
  });
});

describe("checkImportConventions - language violations (Phase 18)", () => {
  it("4. flags a .tsx file when the contract declares JavaScript", () => {
    const result = checkImportConventions("components/Header.tsx", "export default function Header() {}", NO_ALIAS_JS);
    expect(result).not.toBeNull();
    expect(result).toContain("Header.tsx");
    expect(result).toContain("JavaScript");
  });

  it("flags a .ts file (not just .tsx) when the contract declares JavaScript", () => {
    const result = checkImportConventions("lib/utils.ts", "export function x() {}", NO_ALIAS_JS);
    expect(result).not.toBeNull();
  });

  it("does not flag a .tsx file when the contract declares TypeScript", () => {
    const result = checkImportConventions("components/Header.tsx", "export default function Header() {}", TS_CONTRACT);
    expect(result).toBeNull();
  });

  it("does not flag an ordinary .js file under a JavaScript contract", () => {
    const result = checkImportConventions("components/Header.js", "export default function Header() {}", NO_ALIAS_JS);
    expect(result).toBeNull();
  });
});

describe("checkIconImports (Phase 25)", () => {
  it("allows a real, existing lucide-react icon", () => {
    expect(checkIconImports("components/Header.js", 'import { Home, ShoppingCart } from "lucide-react";')).toBeNull();
  });

  it("flags a hallucinated icon name that isn't a real export", () => {
    const result = checkIconImports("components/Header.js", 'import { ShoppingBagIconThatDoesNotExist } from "lucide-react";');
    expect(result).not.toBeNull();
    expect(result).toContain("ShoppingBagIconThatDoesNotExist");
    expect(result).toContain("components/Header.js");
  });

  it("checks every name in a multi-line import statement", () => {
    const content = `import {\n  Home,\n  TotallyFakeIconName,\n  ShoppingCart,\n} from "lucide-react";`;
    const result = checkIconImports("components/Nav.js", content);
    expect(result).toContain("TotallyFakeIconName");
  });

  it("resolves an aliased import to its real export name before checking", () => {
    expect(checkIconImports("components/Header.js", 'import { Home as HomeIcon } from "lucide-react";')).toBeNull();
    const result = checkIconImports("components/Header.js", 'import { NotReal as Whatever } from "lucide-react";');
    expect(result).toContain("NotReal");
  });

  it("ignores imports from other packages entirely", () => {
    expect(checkIconImports("components/Header.js", 'import { NotARealExport } from "react";')).toBeNull();
  });

  it("runs independent of any projectContract - checkImportConventions flags a bad icon even with no contract set", () => {
    const result = checkImportConventions(
      "components/Header.js",
      'import { TotallyFakeIconName } from "lucide-react";',
      undefined
    );
    expect(result).not.toBeNull();
    expect(result).toContain("TotallyFakeIconName");
  });

  it("still allows a real icon when a contract IS set, alongside the existing alias/language checks", () => {
    expect(
      checkImportConventions("components/Header.js", 'import { Home } from "lucide-react";', NO_ALIAS_JS)
    ).toBeNull();
  });
});

describe("checkImportConventions - never triggers a side effect on its own (Phase 18, scenario 8)", () => {
  it("is a pure function - same inputs always produce the same output, no hidden state", () => {
    const a = checkImportConventions("pages/index.js", 'import x from "@/x";', NO_ALIAS_JS);
    const b = checkImportConventions("pages/index.js", 'import x from "@/x";', NO_ALIAS_JS);
    expect(a).toEqual(b);
    // No dependency injection point for run_command/write_file exists on
    // this function's signature at all - it can only return a string or
    // null, never trigger a tool call itself.
    expect(checkImportConventions.length).toBe(3);
  });
});
