"use client";

import { useMemo, useState } from "react";

import { useSessionDoc } from "@/hooks/useSessionDoc";
import { useSessionFiles } from "@/hooks/useSessionFiles";
import { useAgentTurn } from "@/hooks/useAgentTurn";
import { useRuntimeHost } from "@/hooks/useRuntimeHost";
import { usePresence } from "@/hooks/usePresence";
import { useCheckpoints } from "@/hooks/useCheckpoints";
import { computeCurrentTurnChanges } from "@/lib/agent/changesSummary";

import { WorkspaceHeader } from "@/components/workspace/WorkspaceHeader";
import { FileExplorer } from "@/components/workspace/FileExplorer";
import { CodeViewer } from "@/components/workspace/CodeViewer";
import { PreviewPane } from "@/components/workspace/PreviewPane";
import { SplitView } from "@/components/workspace/SplitView";
import { HuddlePanel } from "@/components/workspace/HuddlePanel";
import { ChangesSummary } from "@/components/workspace/ChangesSummary";

export function ProjectWorkspace({ sessionId }: { sessionId: string }) {
  const session = useSessionDoc(sessionId);
  const { files, loaded: filesLoaded } = useSessionFiles(sessionId);
  const turn = useAgentTurn(sessionId);
  const host = useRuntimeHost(sessionId);
  const presence = usePresence(sessionId);
  const { checkpoints, latestPaths, restore } = useCheckpoints(sessionId, turn?.active);

  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  /** Path of the tab CodeViewer is currently mid-edit on with unsaved changes, or null - see CodeViewer's own doc comment on why this lives up here instead of staying local to FileBody. */
  const [dirtyPath, setDirtyPath] = useState<string | null>(null);

  const changedPaths = useMemo(() => {
    if (!turn) return new Set<string>();
    return new Set(computeCurrentTurnChanges(turn.log, latestPaths).map((c) => c.path));
  }, [turn, latestPaths]);

  /** True if it's safe to proceed - false (and the switch aborted) if the user has an unsaved draft open and chose not to discard it. `path` is the destination, so switching to the ALREADY-dirty tab itself never prompts. */
  function confirmDiscardIfDirty(path: string): boolean {
    if (!dirtyPath || dirtyPath === path) return true;
    if (!window.confirm("You have unsaved changes. Discard them?")) return false;
    setDirtyPath(null);
    return true;
  }

  function openFile(path: string) {
    if (!confirmDiscardIfDirty(path)) return;
    setOpenTabs((tabs) => (tabs.includes(path) ? tabs : [...tabs, path]));
    setActiveTab(path);
  }

  function selectTab(path: string) {
    if (!confirmDiscardIfDirty(path)) return;
    setActiveTab(path);
  }

  function closeTab(path: string) {
    if (path === dirtyPath && !window.confirm("You have unsaved changes. Discard them?")) return;
    if (path === dirtyPath) setDirtyPath(null);
    setOpenTabs((tabs) => {
      const next = tabs.filter((t) => t !== path);
      if (activeTab === path) setActiveTab(next[next.length - 1] ?? null);
      return next;
    });
  }

  /** Keeps an open tab pointed at a renamed file/folder instead of going stale - CodeViewer would otherwise show the old path as "removed". */
  function renamePath(oldPath: string, newPath: string) {
    function retarget(path: string): string {
      if (path === oldPath) return newPath;
      if (path.startsWith(`${oldPath}/`)) return newPath + path.slice(oldPath.length);
      return path;
    }
    setOpenTabs((tabs) => tabs.map(retarget));
    setActiveTab((t) => (t ? retarget(t) : t));
  }

  /** Closes tabs for paths the user just deleted on purpose, rather than leaving them showing CodeViewer's "removed" state. */
  function removeTabs(paths: string[]) {
    const removed = new Set(paths);
    setOpenTabs((tabs) => tabs.filter((t) => !removed.has(t)));
    setActiveTab((t) => (t && removed.has(t) ? null : t));
    setDirtyPath((p) => (p && removed.has(p) ? null : p));
  }

  return (
    <div className="flex h-screen flex-col">
      <WorkspaceHeader
        sessionId={sessionId}
        session={session}
        turn={turn}
        host={host}
        presence={presence}
        checkpoints={checkpoints}
        onRestoreCheckpoint={restore}
      />

      <div className="flex flex-1 overflow-hidden">
        <aside className="flex w-60 shrink-0 flex-col border-r border-border">
          <div className="min-h-0 flex-1">
            <FileExplorer
              sessionId={sessionId}
              files={files}
              loading={!filesLoaded}
              activePath={activeTab}
              changedPaths={changedPaths}
              canMutate={!turn?.active}
              onSelect={openFile}
              onRename={renamePath}
              onDelete={removeTabs}
            />
          </div>
          <ChangesSummary turn={turn} checkpointPaths={latestPaths} onSelectPath={openFile} />
        </aside>

        <main className="min-w-0 flex-1">
          <SplitView
            code={
              <CodeViewer
                sessionId={sessionId}
                files={files}
                openTabs={openTabs}
                activeTab={activeTab}
                changedPaths={changedPaths}
                canEdit={!turn?.active}
                dirtyPath={dirtyPath}
                onDirtyChange={setDirtyPath}
                onSelectTab={selectTab}
                onCloseTab={closeTab}
              />
            }
            preview={<PreviewPane host={host} />}
          />
        </main>

        <aside className="flex w-80 shrink-0 flex-col border-l border-border">
          <HuddlePanel sessionId={sessionId} session={session} turn={turn} host={host} />
        </aside>
      </div>
    </div>
  );
}
