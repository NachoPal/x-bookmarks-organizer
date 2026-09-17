import { describe, expect, it } from "vitest";

// Plain browser JS, required directly (not compiled by tsc).
const { buildCategoryIndex, ancestorChainIds, affectedCategoryIds, applyCountDelta } = require("./tree-counts.js");

/** AI (1) -> Evals (2), Harnesses (3); Design (4) -> UI (5). */
function sampleTree() {
  return [
    {
      id: 1,
      parentId: null,
      total: 3,
      unread: 2,
      children: [
        { id: 2, parentId: 1, total: 1, unread: 1, children: [] },
        { id: 3, parentId: 1, total: 2, unread: 1, children: [] },
      ],
    },
    {
      id: 4,
      parentId: null,
      total: 1,
      unread: 0,
      children: [{ id: 5, parentId: 4, total: 1, unread: 0, children: [] }],
    },
  ];
}

describe("buildCategoryIndex", () => {
  it("flattens every node in the tree, including descendants", () => {
    const index = buildCategoryIndex(sampleTree());
    expect([...index.keys()].sort()).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("ancestorChainIds", () => {
  it("walks from a node up to its root, nearest first", () => {
    const index = buildCategoryIndex(sampleTree());
    expect(ancestorChainIds(index, 2)).toEqual([2, 1]);
  });

  it("returns just the id for a root node", () => {
    const index = buildCategoryIndex(sampleTree());
    expect(ancestorChainIds(index, 1)).toEqual([1]);
  });

  it("returns an empty array for an unknown id", () => {
    const index = buildCategoryIndex(sampleTree());
    expect(ancestorChainIds(index, 999)).toEqual([]);
  });
});

describe("affectedCategoryIds", () => {
  it("dedupes a shared ancestor across a multi-category bookmark", () => {
    const index = buildCategoryIndex(sampleTree());
    // A bookmark filed in both Evals (2) and Harnesses (3) touches AI (1) once.
    const ids = affectedCategoryIds(index, [2, 3]);
    expect([...ids].sort()).toEqual([1, 2, 3]);
  });
});

describe("applyCountDelta", () => {
  it("adjusts a leaf and every ancestor, once each, for a single-category bookmark", () => {
    const index = buildCategoryIndex(sampleTree());
    const updated = applyCountDelta(index, [2], 0, -1); // e.g. marking a bookmark in Evals read
    expect(updated.map((n) => n.id).sort()).toEqual([1, 2]);
    expect(index.get(2).unread).toBe(0);
    expect(index.get(1).unread).toBe(1);
    expect(index.get(1).total).toBe(3); // total unchanged
  });

  it("adjusts a shared ancestor only once for a multi-category bookmark", () => {
    const index = buildCategoryIndex(sampleTree());
    const updated = applyCountDelta(index, [2, 3], -1, -1); // deleting an unread bookmark in both
    expect(updated.map((n) => n.id).sort()).toEqual([1, 2, 3]);
    expect(index.get(1).total).toBe(2); // 3 - 1, not 3 - 2
    expect(index.get(1).unread).toBe(1);
    expect(index.get(2).total).toBe(0);
    expect(index.get(3).total).toBe(1);
  });

  it("clamps at 0 instead of going negative", () => {
    const index = buildCategoryIndex(sampleTree());
    applyCountDelta(index, [5], -5, -5);
    expect(index.get(5).total).toBe(0);
    expect(index.get(5).unread).toBe(0);
    expect(index.get(4).total).toBe(0);
  });

  it("ignores category ids no longer present in the index", () => {
    const index = buildCategoryIndex(sampleTree());
    expect(() => applyCountDelta(index, [999], -1, -1)).not.toThrow();
    expect(applyCountDelta(index, [999], -1, -1)).toEqual([]);
  });
});
