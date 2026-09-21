import { describe, expect, it } from "vitest";

const {
  filterTree,
  visibleItems,
  focusTarget,
  lateralTarget,
  isNoOp,
  pathLabel,
  ancestorIds,
} = require("./category-picker.js");

type Node = {
  id: number;
  parentId: number | null;
  name: string;
  path: string[];
  children: Node[];
};

const node = (id: number, name: string, parentId: number | null, path: string[], children: Node[] = []): Node => ({
  id,
  parentId,
  name,
  path,
  children,
});

//  1 AI
//    2 Evals
//      3 Harnesses
//    4 Agents
//  5 Design
const harnesses = node(3, "Harnesses", 2, ["AI", "Evals", "Harnesses"]);
const evals = node(2, "Evals", 1, ["AI", "Evals"], [harnesses]);
const agents = node(4, "Agents", 1, ["AI", "Agents"]);
const ai = node(1, "AI", null, ["AI"], [evals, agents]);
const design = node(5, "Design", null, ["Design"]);
const roots = [ai, design];

const index = new Map<number, Node>([
  [1, ai],
  [2, evals],
  [3, harnesses],
  [4, agents],
  [5, design],
]);

const allOpen = () => true;
const allShut = () => false;

describe("category-picker: search filter", () => {
  it("keeps a match's ancestor path and drops non-matching branches", () => {
    const out = filterTree(roots, "harness");
    expect(out.map((n: Node) => n.name)).toEqual(["AI"]);
    expect(out[0].children.map((n: Node) => n.name)).toEqual(["Evals"]);
    expect(out[0].children[0].children.map((n: Node) => n.name)).toEqual(["Harnesses"]);
  });

  it("prunes a matching node's non-matching children, exactly as the sidebar does", () => {
    const out = filterTree(roots, "evals");
    expect(out.map((n: Node) => n.name)).toEqual(["AI"]);
    expect(out[0].children.map((n: Node) => n.name)).toEqual(["Evals"]);
    expect(out[0].children[0].children).toEqual([]);
  });

  it("returns nothing when nothing matches, and never mutates the source", () => {
    expect(filterTree(roots, "zzz")).toEqual([]);
    expect(ai.children.map((n: Node) => n.name)).toEqual(["Evals", "Agents"]);
  });
});

describe("category-picker: visible items", () => {
  it("lists only what an expansion state actually reveals", () => {
    expect(visibleItems(roots, allShut).map((i: { id: number }) => i.id)).toEqual([1, 5]);
    expect(visibleItems(roots, allOpen).map((i: { id: number }) => i.id)).toEqual([1, 2, 3, 4, 5]);
    const onlyAi = (n: Node) => n.id === 1;
    expect(visibleItems(roots, onlyAi).map((i: { id: number }) => i.id)).toEqual([1, 2, 4, 5]);
  });

  it("reports depth, children and expansion per item", () => {
    const items = visibleItems(roots, allOpen);
    expect(items[0]).toMatchObject({ id: 1, depth: 0, hasChildren: true, expanded: true });
    expect(items[2]).toMatchObject({ id: 3, depth: 2, hasChildren: false, expanded: false });
  });
});

describe("category-picker: keyboard walk", () => {
  const items = () => visibleItems(roots, allOpen);

  it("moves down and up through the visible rows and stops at the ends", () => {
    expect(focusTarget(items(), 1, "ArrowDown")).toEqual({ id: 2 });
    expect(focusTarget(items(), 2, "ArrowUp")).toEqual({ id: 1 });
    expect(focusTarget(items(), 1, "ArrowUp")).toBeNull();
    expect(focusTarget(items(), 5, "ArrowDown")).toBeNull();
  });

  it("skips a collapsed node's children", () => {
    const shut = visibleItems(roots, allShut);
    expect(focusTarget(shut, 1, "ArrowDown")).toEqual({ id: 5 });
  });

  it("jumps to the ends, and answers null when already there", () => {
    expect(focusTarget(items(), 3, "Home")).toEqual({ id: 1 });
    expect(focusTarget(items(), 3, "End")).toEqual({ id: 5 });
    expect(focusTarget(items(), 1, "Home")).toBeNull();
    expect(focusTarget(items(), 5, "End")).toBeNull();
    expect(focusTarget([], 1, "Home")).toBeNull();
    expect(focusTarget(items(), 1, "PageDown")).toBeNull();
  });

  it("expands then steps in on ArrowRight, closes then climbs out on ArrowLeft", () => {
    const parentOf = (n: Node) => n.parentId;
    expect(lateralTarget(visibleItems(roots, allShut), 1, "ArrowRight", parentOf)).toEqual({
      action: "expand",
      id: 1,
    });
    expect(lateralTarget(items(), 1, "ArrowRight", parentOf)).toEqual({ action: "focus", id: 2 });
    expect(lateralTarget(items(), 3, "ArrowRight", parentOf)).toBeNull(); // a leaf
    expect(lateralTarget(items(), 2, "ArrowLeft", parentOf)).toEqual({ action: "collapse", id: 2 });
    expect(lateralTarget(items(), 3, "ArrowLeft", parentOf)).toEqual({ action: "focus", id: 2 });
    // A root: closes first, and once closed there is nowhere further out.
    expect(lateralTarget(items(), 1, "ArrowLeft", parentOf)).toEqual({ action: "collapse", id: 1 });
    expect(lateralTarget(visibleItems(roots, allShut), 1, "ArrowLeft", parentOf)).toBeNull();
  });
});

describe("category-picker: confirmability and labels", () => {
  it("has nothing to do without a selection, or when the post is already there alone", () => {
    expect(isNoOp(null, [2])).toBe(true);
    expect(isNoOp(2, [2])).toBe(true);
    expect(isNoOp(2, [2, 4])).toBe(false); // multi-category: the move collapses it
    expect(isNoOp(2, [4])).toBe(false);
    expect(isNoOp(2, [])).toBe(false);
    expect(isNoOp(2, undefined)).toBe(false);
  });

  it("renders a node's trail, falling back to its own name", () => {
    expect(pathLabel(harnesses)).toBe("AI › Evals › Harnesses");
    expect(pathLabel({ name: "Loose", path: [] })).toBe("Loose");
    expect(pathLabel(null)).toBe("");
  });

  it("lists the ancestors that must be open to reach a node", () => {
    expect(ancestorIds(index, 3)).toEqual([2, 1]);
    expect(ancestorIds(index, 1)).toEqual([]);
    expect(ancestorIds(index, 999)).toEqual([]);
  });
});
