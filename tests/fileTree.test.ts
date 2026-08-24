import { describe, expect, it } from "vitest";
import { buildFileTree, filterFileTree } from "@/lib/files/fileTree";

describe("buildFileTree", () => {
  it("nests paths into directories", () => {
    const tree = buildFileTree(["src/App.jsx", "src/components/Header.jsx", "package.json"]);
    expect(tree.map((n) => n.name)).toEqual(["src", "package.json"]);

    const src = tree.find((n) => n.name === "src")!;
    expect(src.type).toBe("directory");
    expect(src.children?.map((c) => c.name)).toEqual(["components", "App.jsx"]);

    const components = src.children!.find((n) => n.name === "components")!;
    expect(components.children?.[0]).toEqual({ name: "Header.jsx", path: "src/components/Header.jsx", type: "file" });
  });

  it("sorts directories before files, alphabetically within each group", () => {
    const tree = buildFileTree(["z.js", "a.js", "zdir/x.js", "adir/x.js"]);
    expect(tree.map((n) => n.name)).toEqual(["adir", "zdir", "a.js", "z.js"]);
  });

  it("does not duplicate a directory referenced by multiple files", () => {
    const tree = buildFileTree(["src/a.js", "src/b.js"]);
    expect(tree).toHaveLength(1);
    expect(tree[0].children).toHaveLength(2);
  });

  it("handles an empty file list", () => {
    expect(buildFileTree([])).toEqual([]);
  });
});

describe("filterFileTree", () => {
  it("keeps only paths matching the query, case-insensitively", () => {
    const paths = ["src/Header.jsx", "src/footer.jsx", "package.json"];
    expect(filterFileTree(paths, "header")).toEqual(["src/Header.jsx"]);
  });

  it("returns everything for an empty query", () => {
    const paths = ["a.js", "b.js"];
    expect(filterFileTree(paths, "  ")).toEqual(paths);
  });
});
