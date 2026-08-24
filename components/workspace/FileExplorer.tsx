"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronRight,
  ChevronDown,
  Folder,
  FolderOpen,
  Search,
  X,
  FilePlus,
  FolderPlus,
  Pencil,
  Trash2,
  Loader2,
} from "lucide-react";

import { buildFileTree, filterFileTree, isValidSessionFilePath, DIRECTORY_PLACEHOLDER_NAME, type FileTreeNode } from "@/lib/files/fileTree";
import { cn } from "@/lib/cn";
import { authedFetch } from "@/lib/firebase/authedFetch";
import { FileTypeIcon } from "@/components/workspace/fileIcon";

import type { SessionFile } from "@/types/session";

interface Props {
  sessionId: string;
  files: SessionFile[];
  loading: boolean;
  activePath: string | null;
  changedPaths: ReadonlySet<string>;
  /** False while the agent is actively working - mutations are still server-enforced (409), this just avoids offering an action that will predictably be rejected. */
  canMutate: boolean;
  onSelect: (path: string) => void;
  /** So an open tab follows a rename instead of going stale (CodeViewer would otherwise show it as "removed"). */
  onRename: (oldPath: string, newPath: string) => void;
  /** So open tabs for deleted paths close instead of showing "removed" for something the user just deleted on purpose. */
  onDelete: (paths: string[]) => void;
}

type EntryType = "file" | "directory";

function expandedStorageKey(sessionId: string): string {
  return `huddle:expanded-dirs:${sessionId}`;
}

function loadExpanded(sessionId: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(expandedStorageKey(sessionId));
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

function nameOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

interface MenuState {
  path: string;
  type: EntryType;
  x: number;
  y: number;
  mode: "actions" | "confirmDelete";
}

interface CreatingState {
  parentPath: string;
  type: EntryType;
}

interface RenamingState {
  path: string;
  type: EntryType;
  value: string;
}

export function FileExplorer({ sessionId, files, loading, activePath, changedPaths, canMutate, onSelect, onRename, onDelete }: Props) {
  const [query, setQuery] = useState("");
  // sessionId is fixed for this component's whole lifetime - navigating
  // to a different session is a hard page reload (see app/page.tsx's own
  // comment on why), not a client-side prop change, so a mount-time
  // lazy initializer is enough; no reset-on-change effect needed.
  const [expanded, setExpanded] = useState<Set<string>>(() => loadExpanded(sessionId));

  const [menu, setMenu] = useState<MenuState | null>(null);
  const [creating, setCreating] = useState<CreatingState | null>(null);
  const [createValue, setCreateValue] = useState("");
  const [renaming, setRenaming] = useState<RenamingState | null>(null);
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    window.localStorage.setItem(expandedStorageKey(sessionId), JSON.stringify(Array.from(expanded)));
  }, [sessionId, expanded]);

  // Click-away closes the context menu - mousedown (not click) so the
  // SAME click that opens "confirm delete" inside the menu doesn't also
  // bubble to this listener and close it before the user can confirm.
  useEffect(() => {
    if (!menu) return;
    function handlePointerDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(null);
    }
    window.addEventListener("mousedown", handlePointerDown);
    return () => window.removeEventListener("mousedown", handlePointerDown);
  }, [menu]);

  const allPaths = useMemo(() => files.map((f) => f.path), [files]);
  const visiblePaths = useMemo(() => filterFileTree(allPaths, query), [allPaths, query]);
  const tree = useMemo(() => buildFileTree(visiblePaths), [visiblePaths]);
  const isFiltering = query.trim().length > 0;

  function toggle(path: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function openContextMenu(e: React.MouseEvent, path: string, type: EntryType) {
    e.preventDefault();
    if (!canMutate) return;
    setMenu({ path, type, x: e.clientX, y: e.clientY, mode: "actions" });
  }

  function startCreate(parentPath: string, type: EntryType) {
    setMenu(null);
    if (parentPath) setExpanded((prev) => new Set(prev).add(parentPath));
    setCreateValue("");
    setMutationError(null);
    setCreating({ parentPath, type });
  }

  async function submitCreate() {
    if (!creating) return;
    const name = createValue.trim();
    if (!name) {
      setCreating(null);
      return;
    }
    const path = creating.parentPath ? `${creating.parentPath}/${name}` : name;
    if (!isValidSessionFilePath(creating.type === "directory" ? `${path}/x` : path)) {
      setMutationError("That name isn't valid.");
      return;
    }

    setPendingPath(path);
    setMutationError(null);
    const res = await authedFetch(`/api/sessions/${sessionId}/files`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, isDirectory: creating.type === "directory" }),
    });
    setPendingPath(null);

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setMutationError(body.error ?? "Couldn't create that.");
      return;
    }

    setCreating(null);
    if (creating.type === "directory") {
      setExpanded((prev) => new Set(prev).add(path));
    } else {
      onSelect(path);
    }
  }

  function startRename(path: string, type: EntryType) {
    setMenu(null);
    setMutationError(null);
    setRenaming({ path, type, value: nameOf(path) });
  }

  async function submitRename() {
    if (!renaming) return;
    const name = renaming.value.trim();
    const parent = parentOf(renaming.path);
    const newPath = parent ? `${parent}/${name}` : name;
    if (!name || newPath === renaming.path) {
      setRenaming(null);
      return;
    }
    if (!isValidSessionFilePath(renaming.type === "directory" ? `${newPath}/x` : newPath)) {
      setMutationError("That name isn't valid.");
      return;
    }

    setPendingPath(renaming.path);
    setMutationError(null);
    const res = await authedFetch(`/api/sessions/${sessionId}/files/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ oldPath: renaming.path, newPath, isDirectory: renaming.type === "directory" }),
    });
    setPendingPath(null);

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setMutationError(body.error ?? "Couldn't rename that.");
      return;
    }

    if (renaming.type === "directory") {
      setExpanded((prev) => {
        const next = new Set<string>();
        for (const p of prev) {
          if (p === renaming.path) next.add(newPath);
          else if (p.startsWith(`${renaming.path}/`)) next.add(newPath + p.slice(renaming.path.length));
          else next.add(p);
        }
        return next;
      });
    }
    onRename(renaming.path, newPath);
    setRenaming(null);
  }

  function requestDelete() {
    setMenu((m) => (m ? { ...m, mode: "confirmDelete" } : m));
  }

  async function confirmDelete() {
    if (!menu) return;
    const { path, type } = menu;
    setPendingPath(path);
    setMutationError(null);
    const res = await authedFetch(`/api/sessions/${sessionId}/files`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, isDirectory: type === "directory" }),
    });
    setPendingPath(null);
    setMenu(null);

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setMutationError(body.error ?? "Couldn't delete that.");
      return;
    }

    const removedPaths = type === "directory" ? files.filter((f) => f.path.startsWith(`${path}/`)).map((f) => f.path) : [path];
    onDelete(removedPaths);
  }

  const actions: TreeActions = {
    activePath,
    changedPaths,
    expanded,
    forceOpen: isFiltering,
    canMutate,
    pendingPath,
    onToggle: toggle,
    onSelect,
    onContextMenu: openContextMenu,
    renaming,
    onRenameChange: (value) => setRenaming((r) => (r ? { ...r, value } : r)),
    onRenameSubmit: submitRename,
    onRenameCancel: () => setRenaming(null),
    creating,
    createValue,
    onCreateChange: setCreateValue,
    onCreateSubmit: submitCreate,
    onCreateCancel: () => setCreating(null),
  };

  return (
    <div className="flex h-full flex-col">
      <div className="huddle-panel-header gap-1.5 border-b border-border px-2.5">
        <Search className="h-3.5 w-3.5 shrink-0 text-fg-subtle" strokeWidth={1.75} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter files"
          className="w-full bg-transparent text-xs text-fg outline-none placeholder:text-fg-subtle"
        />
        {query && (
          <button onClick={() => setQuery("")} className="shrink-0 text-fg-subtle hover:text-fg" aria-label="Clear filter">
            <X className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
        )}
        <button
          onClick={() => startCreate("", "file")}
          disabled={!canMutate}
          aria-label="New file"
          title="New file"
          className="shrink-0 rounded p-0.5 text-fg-subtle hover:bg-bg-raised hover:text-fg disabled:opacity-30"
        >
          <FilePlus className="h-3.5 w-3.5" strokeWidth={1.75} />
        </button>
        <button
          onClick={() => startCreate("", "directory")}
          disabled={!canMutate}
          aria-label="New folder"
          title="New folder"
          className="shrink-0 rounded p-0.5 text-fg-subtle hover:bg-bg-raised hover:text-fg disabled:opacity-30"
        >
          <FolderPlus className="h-3.5 w-3.5" strokeWidth={1.75} />
        </button>
      </div>

      {mutationError && (
        <p className="border-b border-border bg-danger/10 px-2.5 py-1.5 text-xs text-danger">{mutationError}</p>
      )}

      <div className="flex-1 overflow-y-auto px-1.5 py-1.5">
        {files.length === 0 && loading ? (
          <FileTreeSkeleton />
        ) : (
          <>
            {creating?.parentPath === "" && (
              <CreateRow
                depth={0}
                type={creating.type}
                value={createValue}
                busy={pendingPath !== null}
                onChange={actions.onCreateChange}
                onSubmit={actions.onCreateSubmit}
                onCancel={actions.onCreateCancel}
              />
            )}
            {files.length === 0 && !creating ? (
              <p className="px-2 py-4 text-xs text-fg-subtle">No files yet.</p>
            ) : tree.length === 0 && isFiltering ? (
              <p className="px-2 py-4 text-xs text-fg-subtle">No files match &ldquo;{query}&rdquo;.</p>
            ) : (
              <Tree nodes={tree} depth={0} actions={actions} />
            )}
          </>
        )}
      </div>

      {menu && (
        <div
          ref={menuRef}
          className="fixed z-30 w-40 rounded-lg border border-border bg-bg-overlay py-1 shadow-lg"
          style={{ left: Math.min(menu.x, window.innerWidth - 170), top: Math.min(menu.y, window.innerHeight - 140) }}
        >
          {menu.mode === "actions" ? (
            <>
              {menu.type === "directory" && (
                <>
                  <MenuItem icon={FilePlus} label="New file" onClick={() => startCreate(menu.path, "file")} />
                  <MenuItem icon={FolderPlus} label="New folder" onClick={() => startCreate(menu.path, "directory")} />
                  <div className="my-1 border-t border-border" />
                </>
              )}
              <MenuItem icon={Pencil} label="Rename" onClick={() => startRename(menu.path, menu.type)} />
              <MenuItem icon={Trash2} label="Delete" danger onClick={requestDelete} />
            </>
          ) : (
            <div className="px-2.5 py-1.5">
              <p className="mb-2 text-xs text-fg">
                Delete {menu.type === "directory" ? "this folder and everything in it" : "this file"}?
              </p>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={confirmDelete}
                  disabled={pendingPath !== null}
                  className="rounded-md bg-danger px-2 py-1 text-2xs font-medium text-white disabled:opacity-50"
                >
                  {pendingPath !== null ? "Deleting…" : "Delete"}
                </button>
                <button onClick={() => setMenu(null)} className="rounded-md px-2 py-1 text-2xs text-fg-muted hover:bg-bg-raised">
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface TreeActions {
  activePath: string | null;
  changedPaths: ReadonlySet<string>;
  expanded: Set<string>;
  forceOpen: boolean;
  canMutate: boolean;
  pendingPath: string | null;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
  onContextMenu: (e: React.MouseEvent, path: string, type: EntryType) => void;
  renaming: RenamingState | null;
  onRenameChange: (value: string) => void;
  onRenameSubmit: () => void;
  onRenameCancel: () => void;
  creating: CreatingState | null;
  createValue: string;
  onCreateChange: (value: string) => void;
  onCreateSubmit: () => void;
  onCreateCancel: () => void;
}

function Tree({ nodes, depth, actions }: { nodes: FileTreeNode[]; depth: number; actions: TreeActions }) {
  return (
    <ul>
      {nodes.map((node) => {
        const isOpen = actions.forceOpen || actions.expanded.has(node.path);
        const isChanged = actions.changedPaths.has(node.path);
        const isRenaming = actions.renaming?.path === node.path;
        const isPending = actions.pendingPath === node.path;

        if (node.type === "directory") {
          return (
            <li key={node.path}>
              {isRenaming ? (
                <RenameRow depth={depth} icon={isOpen ? FolderOpen : Folder} actions={actions} />
              ) : (
                <button
                  onClick={() => actions.onToggle(node.path)}
                  onContextMenu={(e) => actions.onContextMenu(e, node.path, "directory")}
                  className="flex w-full items-center gap-1 rounded px-1.5 py-1 text-left text-xs text-fg-muted hover:bg-bg-raised"
                  style={{ paddingLeft: `${depth * 14 + 6}px` }}
                >
                  {isOpen ? (
                    <ChevronDown className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
                  )}
                  {isOpen ? (
                    <FolderOpen className="h-3.5 w-3.5 shrink-0 text-fg-subtle" strokeWidth={1.75} />
                  ) : (
                    <Folder className="h-3.5 w-3.5 shrink-0 text-fg-subtle" strokeWidth={1.75} />
                  )}
                  <span className="truncate">{node.name}</span>
                  {isPending && <Loader2 className="ml-auto h-3 w-3 shrink-0 animate-spin text-fg-subtle" strokeWidth={2} />}
                </button>
              )}
              {isOpen && (
                <>
                  {node.children && node.children.some((c) => c.name !== DIRECTORY_PLACEHOLDER_NAME) && (
                    <Tree nodes={node.children} depth={depth + 1} actions={actions} />
                  )}
                  {actions.creating?.parentPath === node.path && (
                    <CreateRow
                      depth={depth + 1}
                      type={actions.creating.type}
                      value={actions.createValue}
                      busy={actions.pendingPath !== null}
                      onChange={actions.onCreateChange}
                      onSubmit={actions.onCreateSubmit}
                      onCancel={actions.onCreateCancel}
                    />
                  )}
                </>
              )}
            </li>
          );
        }

        if (node.name === DIRECTORY_PLACEHOLDER_NAME) return null;

        return (
          <li key={node.path}>
            {isRenaming ? (
              <RenameRow depth={depth} icon={(p) => <FileTypeIcon name={node.name} {...p} />} actions={actions} indent={16} />
            ) : (
              <button
                onClick={() => actions.onSelect(node.path)}
                onContextMenu={(e) => actions.onContextMenu(e, node.path, "file")}
                className={cn(
                  "flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs hover:bg-bg-raised",
                  actions.activePath === node.path ? "bg-bg-raised text-fg" : "text-fg-muted"
                )}
                style={{ paddingLeft: `${depth * 14 + 22}px` }}
              >
                <FileTypeIcon name={node.name} className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
                <span className="truncate">{node.name}</span>
                {isPending && <Loader2 className="ml-auto h-3 w-3 shrink-0 animate-spin text-fg-subtle" strokeWidth={2} />}
                {!isPending && isChanged && <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-accent" title="Changed this turn" />}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function RenameRow({
  depth,
  icon: Icon,
  actions,
  indent = 6,
}: {
  depth: number;
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  actions: TreeActions;
  indent?: number;
}) {
  return (
    <div className="flex items-center gap-1.5 rounded px-1.5 py-0.5" style={{ paddingLeft: `${depth * 14 + indent}px` }}>
      <Icon className="h-3.5 w-3.5 shrink-0 text-fg-subtle" strokeWidth={1.75} />
      <input
        autoFocus
        value={actions.renaming?.value ?? ""}
        onChange={(e) => actions.onRenameChange(e.target.value)}
        onBlur={actions.onRenameSubmit}
        onKeyDown={(e) => {
          if (e.key === "Enter") actions.onRenameSubmit();
          if (e.key === "Escape") actions.onRenameCancel();
        }}
        onFocus={(e) => e.target.select()}
        className="min-w-0 flex-1 rounded border border-accent bg-bg-raised px-1 py-0.5 text-xs text-fg outline-none"
      />
    </div>
  );
}

function CreateRow({
  depth,
  type,
  value,
  busy,
  onChange,
  onSubmit,
  onCancel,
}: {
  depth: number;
  type: EntryType;
  value: string;
  busy: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const Icon = type === "directory" ? Folder : FilePlus;
  return (
    <div className="flex items-center gap-1.5 rounded px-1.5 py-0.5" style={{ paddingLeft: `${depth * 14 + 6}px` }}>
      <Icon className="h-3.5 w-3.5 shrink-0 text-fg-subtle" strokeWidth={1.75} />
      <input
        autoFocus
        value={value}
        placeholder={type === "directory" ? "Folder name" : "File name"}
        disabled={busy}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onSubmit}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSubmit();
          if (e.key === "Escape") onCancel();
        }}
        className="min-w-0 flex-1 rounded border border-accent bg-bg-raised px-1 py-0.5 text-xs text-fg outline-none disabled:opacity-50"
      />
    </div>
  );
}

function MenuItem({
  icon: Icon,
  label,
  danger,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  label: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-bg-raised",
        danger ? "text-danger" : "text-fg"
      )}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
      {label}
    </button>
  );
}

/** Shown only before the first Firestore snapshot arrives - reopening a real project must never flash "No files yet" while its files are still in flight. */
function FileTreeSkeleton() {
  const widths = ["70%", "45%", "60%", "35%", "50%"];
  return (
    <div className="space-y-1.5 px-2 py-1" aria-hidden>
      {widths.map((w, i) => (
        <div key={i} className="huddle-animate-shimmer h-3 rounded bg-bg-raised" style={{ width: w }} />
      ))}
    </div>
  );
}
