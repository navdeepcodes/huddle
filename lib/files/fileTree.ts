export interface FileTreeNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileTreeNode[];
}

/**
 * Session files have no native directory concept (one flat doc per
 * path, see fileStore.ts) - this rebuilds the nested shape a tree UI
 * needs, purely from the `/`-delimited paths. Pure and synchronous so
 * it's cheap to rebuild on every files-array change and trivial to
 * unit test without any Firestore/React involved.
 */
export function buildFileTree(paths: string[]): FileTreeNode[] {
  const root: FileTreeNode[] = [];

  for (const path of paths) {
    const parts = path.split("/").filter(Boolean);
    let level = root;
    let currentPath = "";

    parts.forEach((part, i) => {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const isFile = i === parts.length - 1;
      let node = level.find((n) => n.name === part);

      if (!node) {
        node = isFile
          ? { name: part, path: currentPath, type: "file" }
          : { name: part, path: currentPath, type: "directory", children: [] };
        level.push(node);
      }

      if (!isFile) {
        if (!node.children) node.children = [];
        level = node.children;
      }
    });
  }

  return sortTree(root);
}

function sortTree(nodes: FileTreeNode[]): FileTreeNode[] {
  const sorted = [...nodes].sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const node of sorted) {
    if (node.children) node.children = sortTree(node.children);
  }
  return sorted;
}

/** Case-insensitive substring match against every path, flattened - a filtered tree shows only matching files plus the directories needed to reach them. */
export function filterFileTree(paths: string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return paths;
  return paths.filter((p) => p.toLowerCase().includes(q));
}

/** Phase 31: shared guard for create/rename - rejects the same shapes a real filesystem would (leading/trailing slash, empty segments, `.`/`..` traversal). Session files have no native directory concept (see fileStore.ts), so this is the only thing standing between a user-typed path and a malformed or path-traversal-shaped Firestore doc id. */
export function isValidSessionFilePath(path: string): boolean {
  if (!path || path !== path.trim() || path.startsWith("/") || path.endsWith("/")) return false;
  const parts = path.split("/");
  return parts.every((p) => p !== "" && p !== "." && p !== "..");
}

/** The marker file written for an otherwise-empty created directory - session files have no native directory concept, so an empty folder only exists as a tree node while it contains at least one file. Filtered out of the rendered tree (FileExplorer), not out of storage. */
export const DIRECTORY_PLACEHOLDER_NAME = ".gitkeep";
