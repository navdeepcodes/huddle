const EXTENSION_LANGUAGE: Record<string, string> = {
  js: "jsx",
  jsx: "jsx",
  ts: "tsx",
  tsx: "tsx",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  css: "css",
  scss: "scss",
  html: "markup",
  md: "markdown",
  mdx: "markdown",
  yml: "yaml",
  yaml: "yaml",
  sh: "bash",
  bash: "bash",
};

export function languageForPath(path: string): string {
  const ext = path.includes(".") ? path.split(".").pop()!.toLowerCase() : "";
  return EXTENSION_LANGUAGE[ext] ?? "text";
}
