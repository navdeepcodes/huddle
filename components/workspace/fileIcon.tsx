import { FileCode2, FileJson2, FileText, FileType2, Image, FileCog, File as FileIcon } from "lucide-react";

const EXTENSION_ICON: Record<string, typeof FileIcon> = {
  js: FileCode2,
  jsx: FileCode2,
  ts: FileCode2,
  tsx: FileCode2,
  mjs: FileCode2,
  cjs: FileCode2,
  json: FileJson2,
  css: FileType2,
  scss: FileType2,
  html: FileCode2,
  md: FileText,
  mdx: FileText,
  txt: FileText,
  png: Image,
  jpg: Image,
  jpeg: Image,
  gif: Image,
  svg: Image,
  webp: Image,
  yml: FileCog,
  yaml: FileCog,
  toml: FileCog,
  env: FileCog,
};

export function FileTypeIcon({ name, className }: { name: string; className?: string }) {
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  const Icon = EXTENSION_ICON[ext] ?? FileIcon;
  return <Icon className={className} strokeWidth={1.75} />;
}
