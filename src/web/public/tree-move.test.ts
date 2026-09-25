import { describe, expect, it } from "vitest";

const M = require("./tree-move.js");

// AI(1) > { Agents(2) > { Harnesses(3) > { Evals(4) } }, Models(5) }, Design(6), Music(7)
const n = (id: number, name: string, children: unknown[] = []) => ({ id, name, children });
const tree = () => [
  n(1, "AI", [n(2, "Agents", [n(3, "Harnesses", [n(4, "Evals")])]), n(5, "Models")]),
  n(6, "Design"),
  n(7, "Music"),
];

describe("tree-move: locate / height / ancestors", () => {
  it("finds a node with its parent, index and 1-based depth", () => {
    const here = M.locate(tree(), 3);
    expect(here.node.name).toBe("Harnesses");
    expect(here.parent.id).toBe(2);
    expect(here.index).toBe(0);
    expect(here.depth).toBe(3);
    expect(M.locate(tree(), 99)).toBeNull();
  });

  it("measures a subtree's levels and its ancestor path", () => {
    expect(M.height(M.locate(tree(), 2).node)).toBe(3);
    expect(M.height(M.locate(tree(), 4).node)).toBe(1);
    expect(M.ancestorIds(tree(), 4)).toEqual([1, 2, 3]);
    expect(M.ancestorIds(tree(), 6)).toEqual([]);
  });
});

describe("tree-move: problemFor mirrors the server's refusals", () => {
  it("allows a depth-3 category to the root and a root into a deep node", () => {
    expect(M.problemFor(tree(), 3, null, 4)).toBeNull();
    expect(M.problemFor(tree(), 7, 3, 4)).toBeNull();
  });

  it("refuses the category itself and its own descendants", () => {
    for (const parent of [2, 3, 4]) {
      expect(M.problemFor(tree(), 2, parent, 4)).toEqual({
        problem: "cycle",
        message: "“Agents” can’t go inside itself or one of its own sub-categories.",
      });
    }
  });

  it("refuses a move past the depth limit, but never one within a depth the tree already has", () => {
    expect(M.problemFor(tree(), 2, 5, 4)).toEqual({
      problem: "depth",
      message: "That would make the tree 5 levels deep; categories go at most 4 levels deep.",
    });
    expect(M.problemFor(tree(), 4, 5, 4)).toBeNull();
    // Already 4 deep (Agents' subtree ends at Evals, depth 4): limit 3 still lets it stay as deep.
    expect(M.problemFor(tree(), 3, 2, 3)).toBeNull();
  });

  it("refuses a sibling name clash, case-insensitively, under a parent or at the top", () => {
    const t = tree();
    t[0].children[1].children = [n(8, "agents")];
    expect(M.problemFor(t, 8, 1, 4)).toEqual({
      problem: "clash",
      message: "“AI” already has a category called “Agents”.",
    });
    t[1].name = "evals";
    expect(M.problemFor(t, 4, null, 4)).toEqual({
      problem: "clash",
      message: "There is already a top-level category called “evals”.",
    });
  });
});

describe("tree-move: drop zones and targets", () => {
  it("splits a row into before / inside / after", () => {
    expect(M.dropZone(100, 40, 105)).toBe("before");
    expect(M.dropZone(100, 40, 120)).toBe("inside");
    expect(M.dropZone(100, 40, 135)).toBe("after");
  });

  it("maps a zone on a row to a parent and an index that excludes the dragged node", () => {
    expect(M.dropTarget(tree(), 7, 6, "before", false)).toEqual({ parentId: null, index: 1 });
    expect(M.dropTarget(tree(), 1, 7, "after", false)).toEqual({ parentId: null, index: 2 });
    expect(M.dropTarget(tree(), 7, 3, "inside", false)).toEqual({ parentId: 3, index: 1 });
    expect(M.dropTarget(tree(), 5, 2, "before", false)).toEqual({ parentId: 1, index: 0 });
  });

  it("reads AFTER an expanded parent as its first child, and a row on itself as nothing", () => {
    expect(M.dropTarget(tree(), 7, 2, "after", true)).toEqual({ parentId: 2, index: 0 });
    expect(M.dropTarget(tree(), 7, 2, "after", false)).toEqual({ parentId: 1, index: 1 });
    expect(M.dropTarget(tree(), 2, 2, "inside", false)).toBeNull();
  });

  it("knows a no-op", () => {
    expect(M.isNoOp(tree(), 6, { parentId: null, index: 1 })).toBe(true);
    expect(M.isNoOp(tree(), 6, { parentId: null, index: 0 })).toBe(false);
    expect(M.isNoOp(tree(), 7, { parentId: null, index: 99 })).toBe(true);
    expect(M.isNoOp(tree(), 5, { parentId: null, index: 0 })).toBe(false);
  });
});

describe("tree-move: keyboard", () => {
  it("steps among siblings and stops at the ends", () => {
    expect(M.keyboardTarget(tree(), 6, "ArrowUp")).toEqual({ parentId: null, index: 0 });
    expect(M.keyboardTarget(tree(), 6, "ArrowDown")).toEqual({ parentId: null, index: 2 });
    expect(M.keyboardTarget(tree(), 1, "ArrowUp")).toBeNull();
    expect(M.keyboardTarget(tree(), 7, "ArrowDown")).toBeNull();
    expect(M.keyboardEdge(tree(), 7, "ArrowDown")).toBe("“Music” is already last.");
  });

  it("outdents to just after the parent and indents into the sibling above", () => {
    expect(M.keyboardTarget(tree(), 3, "ArrowLeft")).toEqual({ parentId: 1, index: 1 });
    expect(M.keyboardTarget(tree(), 2, "ArrowLeft")).toEqual({ parentId: null, index: 1 });
    expect(M.keyboardTarget(tree(), 1, "ArrowLeft")).toBeNull();
    expect(M.keyboardTarget(tree(), 5, "ArrowRight")).toEqual({ parentId: 2, index: 1 });
    expect(M.keyboardTarget(tree(), 2, "ArrowRight")).toBeNull();
  });

  it("describes a place and captures it for Undo", () => {
    expect(M.placeLabel(tree(), 5)).toBe("2 of 2 in “AI”");
    expect(M.placeLabel(tree(), 6)).toBe("2 of 3 at the top level");
    expect(M.currentPlace(tree(), 5)).toEqual({ parentId: 1, index: 1 });
    expect(M.currentPlace(tree(), 7)).toEqual({ parentId: null, index: 2 });
  });
});
