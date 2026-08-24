"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import { Copy, Check, Pencil, Save, X, Search as SearchIcon, ChevronUp, ChevronDown } from "lucide-react";

import { cn } from "@/lib/cn";
import { languageForPath } from "@/lib/files/languageForPath";
import { FileTypeIcon } from "@/components/workspace/fileIcon";
import { authedFetch } from "@/lib/firebase/authedFetch";

import type { SessionFile } from "@/types/session";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);

interface Props {
  sessionId: string;
  files: SessionFile[];
  openTabs: string[];
  activeTab: string | null;
  changedPaths: ReadonlySet<string>;
  canEdit: boolean;
  /** Path of the tab currently mid-edit with unsaved changes, or null - lifted to ProjectWorkspace so EVERY way of switching the active file (tab click, explorer click, changed-files click) can guard against silently discarding a draft, not just the tab strip's own close button. */
  dirtyPath: string | null;
  onDirtyChange: (path: string | null) => void;
  onSelectTab: (path: string) => void;
  onCloseTab: (path: string) => void;
}

export function CodeViewer({ sessionId, files, openTabs, activeTab, changedPaths, canEdit, dirtyPath, onDirtyChange, onSelectTab, onCloseTab }: Props) {
  const file = useMemo(() => files.find((f) => f.path === activeTab) ?? null, [files, activeTab]);

  if (openTabs.length === 0) {
    return (
      <div className="flex h-full flex-col">
        <EmptyState message="Select a file to view its contents." />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center overflow-x-auto border-b border-border">
        {openTabs.map((path) => (
          <Tab
            key={path}
            path={path}
            active={path === activeTab}
            changed={changedPaths.has(path)}
            dirty={dirtyPath === path}
            onSelect={() => onSelectTab(path)}
            onClose={() => onCloseTab(path)}
          />
        ))}
      </div>
      {file ? (
        <FileBody key={file.path} sessionId={sessionId} file={file} canEdit={canEdit} onDirtyChange={onDirtyChange} />
      ) : (
        <EmptyState message="This file was removed." />
      )}
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return <div className="flex flex-1 items-center justify-center text-xs text-fg-subtle">{message}</div>;
}

function Tab({
  path,
  active,
  changed,
  dirty,
  onSelect,
  onClose,
}: {
  path: string;
  active: boolean;
  changed: boolean;
  dirty: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const name = path.split("/").pop() ?? path;
  return (
    <div
      className={cn(
        "group flex shrink-0 cursor-pointer items-center gap-1.5 border-r border-border px-2.5 py-1.5 text-xs",
        active ? "bg-bg-raised text-fg" : "text-fg-muted hover:bg-bg-raised/50"
      )}
      onClick={onSelect}
      title={dirty ? `${path} - unsaved changes` : path}
    >
      <FileTypeIcon name={name} className="h-3 w-3 shrink-0 text-fg-subtle" />
      <span className="max-w-[140px] truncate">{name}</span>
      {changed && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        aria-label={`Close ${name}`}
        className="relative ml-0.5 flex h-3 w-3 shrink-0 items-center justify-center rounded text-fg-subtle hover:text-fg"
      >
        {/* VS Code's own convention: an unsaved dot sits where the close icon normally is, replaced by the icon itself on hover/focus so the affordance is never actually hidden. */}
        <X className="hidden h-3 w-3 group-hover:block group-focus-within:block" strokeWidth={2} />
        {dirty && <span className="h-1.5 w-1.5 rounded-full bg-fg-subtle group-hover:hidden group-focus-within:hidden" />}
      </button>
    </div>
  );
}

function FileBody({
  sessionId,
  file,
  canEdit,
  onDirtyChange,
}: {
  sessionId: string;
  file: SessionFile;
  canEdit: boolean;
  onDirtyChange: (path: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(file.content);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [query, setQuery] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const lineRefs = useRef<Map<number, HTMLElement>>(new Map());

  // Render-time state adjustment, not an effect (React's own recommended
  // pattern for "reset derived state when an input changes" - an effect
  // here would cause an extra render). `file.path` never changes for a
  // mounted instance (CodeViewer keys FileBody by path, so a different
  // file is a remount) - this only needs to catch the SAME path's
  // content changing under it (the agent rewrote the open file).
  const [prevContent, setPrevContent] = useState(file.content);
  if (file.content !== prevContent) {
    setPrevContent(file.content);
    setEditing(false);
    setDraft(file.content);
    setQuery("");
  }

  const isDirty = editing && draft !== file.content;

  // Two independent loss-prevention paths for the same fact (an
  // unsaved draft): this catches the browser tab closing/reloading;
  // ProjectWorkspace's dirtyPath guard (fed by onDirtyChange below)
  // catches switching to a different file within the app, which
  // beforeunload can't see at all.
  useEffect(() => {
    if (!isDirty) return;
    function handler(e: BeforeUnloadEvent) {
      e.preventDefault();
    }
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty]);

  useEffect(() => {
    onDirtyChange(isDirty ? file.path : null);
  }, [isDirty, file.path, onDirtyChange]);

  // Unmounting (file removed, or the tab itself closed via a path that
  // bypassed the dirty guard - e.g. a teammate deleting this exact file
  // out from under the edit) must never leave a stale dirty pointer
  // behind for a file that's no longer open.
  useEffect(() => {
    return () => onDirtyChange(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ext = file.path.includes(".") ? file.path.split(".").pop()!.toLowerCase() : "";
  const isImage = file.encoding === "base64" && IMAGE_EXTENSIONS.has(ext);

  const matchingLines = useMemo(() => {
    if (!query.trim()) return [];
    const q = query.trim().toLowerCase();
    return file.content.split("\n").reduce<number[]>((acc, line, i) => {
      if (line.toLowerCase().includes(q)) acc.push(i + 1);
      return acc;
    }, []);
  }, [query, file.content]);

  const [prevQuery, setPrevQuery] = useState(query);
  if (query !== prevQuery) {
    setPrevQuery(query);
    setMatchIndex(0);
  }

  useEffect(() => {
    if (matchingLines.length === 0) return;
    const line = matchingLines[matchIndex % matchingLines.length];
    lineRefs.current.get(line)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [matchIndex, matchingLines]);

  async function handleCopy() {
    await navigator.clipboard.writeText(file.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  async function handleSave() {
    setSaving(true);
    setSaveError(null);
    let res: Response;
    try {
      res = await authedFetch(`/api/sessions/${sessionId}/files`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: file.path, content: draft }),
      });
    } catch {
      setSaving(false);
      setSaveError("Couldn't reach the server - your draft is still here, try again.");
      return;
    }
    setSaving(false);

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      // The draft is deliberately left in place on failure (not reset to
      // file.content) - staying in edit mode is what "no accidental loss
      // of unsaved edits" actually means for a failed save, not just a
      // successful one.
      setSaveError(body.error ?? "Couldn't save - your draft is still here, try again.");
      return;
    }

    setEditing(false);
    setJustSaved(true);
    setTimeout(() => setJustSaved(false), 1500);
  }

  const currentMatchLine = matchingLines.length > 0 ? matchingLines[matchIndex % matchingLines.length] : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
        <span className="truncate text-xs text-fg-muted">{file.path}</span>
        {isDirty && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-fg-subtle" title="Unsaved changes" />}
        {justSaved && <span className="shrink-0 text-2xs text-success">Saved</span>}
        {saveError && <span className="min-w-0 truncate text-2xs text-danger">{saveError}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {!editing && !isImage && (
            <div className="flex items-center gap-1 border-r border-border pr-1.5">
              <SearchIcon className="h-3 w-3 text-fg-subtle" strokeWidth={1.75} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search in file"
                className="w-28 bg-transparent text-xs text-fg outline-none placeholder:text-fg-subtle"
              />
              {matchingLines.length > 0 && (
                <>
                  <span className="text-2xs text-fg-subtle">
                    {(matchIndex % matchingLines.length) + 1}/{matchingLines.length}
                  </span>
                  <button onClick={() => setMatchIndex((i) => i - 1)} className="text-fg-subtle hover:text-fg">
                    <ChevronUp className="h-3 w-3" strokeWidth={2} />
                  </button>
                  <button onClick={() => setMatchIndex((i) => i + 1)} className="text-fg-subtle hover:text-fg">
                    <ChevronDown className="h-3 w-3" strokeWidth={2} />
                  </button>
                </>
              )}
            </div>
          )}

          <IconButton onClick={handleCopy} label="Copy">
            {copied ? <Check className="h-3.5 w-3.5" strokeWidth={2} /> : <Copy className="h-3.5 w-3.5" strokeWidth={1.75} />}
          </IconButton>

          {canEdit && !isImage && (
            editing ? (
              <>
                <button
                  onClick={() => {
                    setEditing(false);
                    setDraft(file.content);
                    setSaveError(null);
                  }}
                  className="rounded px-2 py-1 text-xs text-fg-muted hover:bg-bg-raised"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="flex items-center gap-1 rounded bg-accent px-2 py-1 text-xs font-medium text-accent-fg disabled:opacity-50"
                >
                  <Save className="h-3 w-3" strokeWidth={2} />
                  {saving ? "Saving…" : "Save"}
                </button>
              </>
            ) : (
              <IconButton
                onClick={() => {
                  setEditing(true);
                  setJustSaved(false);
                }}
                label="Edit"
              >
                <Pencil className="h-3.5 w-3.5" strokeWidth={1.75} />
              </IconButton>
            )
          )}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {isImage ? (
          <div className="flex h-full items-center justify-center p-6">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`data:image/${ext};base64,${file.content}`} alt={file.path} className="max-h-full max-w-full object-contain" />
          </div>
        ) : editing ? (
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            className="h-full w-full resize-none bg-bg-base p-3 font-mono text-xs text-fg outline-none"
          />
        ) : (
          <SyntaxHighlighter
            language={languageForPath(file.path)}
            style={vscDarkPlus}
            showLineNumbers
            wrapLines
            wrapLongLines
            customStyle={{ margin: 0, background: "transparent", fontSize: "12px", minHeight: "100%" }}
            lineProps={(lineNumber) => ({
              ref: (el: HTMLElement | null) => {
                if (el) lineRefs.current.set(lineNumber, el);
              },
              style: { display: "block", background: lineNumber === currentMatchLine ? "rgba(34,211,238,0.15)" : undefined },
            })}
          >
            {file.content}
          </SyntaxHighlighter>
        )}
      </div>
    </div>
  );
}

function IconButton({ onClick, label, children }: { onClick: () => void; label: string; children: React.ReactNode }) {
  return (
    <button onClick={onClick} aria-label={label} title={label} className="rounded p-1 text-fg-subtle hover:bg-bg-raised hover:text-fg">
      {children}
    </button>
  );
}
