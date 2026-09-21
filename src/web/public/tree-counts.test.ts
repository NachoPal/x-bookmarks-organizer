import { describe, expect, it } from "vitest";

// Plain browser JS, required directly (not compiled by tsc).
const {
  tabCounts,
  buildCategoryIndex,
  ancestorChainIds,
  affectedCategoryIds,
  applyCountDelta,
  applyMoveDelta,
} = require("./tree-counts.js");

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

describe("tabCounts (filter tab badges, issue #72)", () => {
  it("maps rolled-up counts to each tab, deriving read", () => {
    expect(tabCounts({ total: 10, unread: 4, favorite: 2 })).toEqual({
      unread: 4,
      read: 6,
      all: 10,
      favorite: 2,
    });
  });

  it("tracks a read toggle and a favorite toggle", () => {
    const counts = { total: 5, unread: 5, favorite: 0 };
    counts.unread -= 1; // mark one read
    counts.favorite += 1; // star one
    expect(tabCounts(counts)).toEqual({ unread: 4, read: 1, all: 5, favorite: 1 });
  });

  it("tolerates a missing favorite total", () => {
    expect(tabCounts({ total: 2, unread: 1 } as never).favorite).toBe(0);
  });
});

describe("applyMoveDelta (issue #92)", () => {
  /** AI(1) -> Evals(2), Harnesses(3); Design(4) -> UI(5). */
  const counts = (index: Map<number, { total: number; unread: number }>) =>
    [1, 2, 3, 4, 5].map((id) => [index.get(id)!.total, index.get(id)!.unread]);

  it("takes the post off the source chain and adds it to the destination chain", () => {
    const index = buildCategoryIndex(sampleTree());
    // An unread post moves from Evals (under AI) to UI (under Design).
    applyMoveDelta(index, [2], 5, 1);
    expect(counts(index)).toEqual([
      [2, 1], // AI lost it
      [0, 0], // Evals lost it
      [2, 1], // Harnesses untouched
      [2, 1], // Design gained it
      [2, 1], // UI gained it
    ]);
  });

  it("nets a shared ancestor to zero when the post never leaves its subtree", () => {
    const index = buildCategoryIndex(sampleTree());
    applyMoveDelta(index, [2], 3, 1); // Evals -> Harnesses, both under AI
    expect(counts(index)).toEqual([
      [3, 2], // AI unchanged: it counted the post once before and does now
      [0, 0],
      [3, 2],
      [1, 0],
      [1, 0],
    ]);
  });

  it("collapses a multi-category post onto the one destination", () => {
    const index = buildCategoryIndex(sampleTree());
    applyMoveDelta(index, [2, 3], 5, 0); // a READ post filed twice under AI
    expect(counts(index)).toEqual([
      [2, 2], // AI: -1 once, despite two direct categories losing it
      [0, 1], // a READ post leaves the unread tallies alone
      [1, 1],
      [2, 0],
      [2, 0],
    ]);
  });

  it("reports each moved node exactly once", () => {
    const index = buildCategoryIndex(sampleTree());
    const updated = applyMoveDelta(index, [2], 3, 1);
    const ids = updated.map((n: { id: number }) => n.id).sort();
    expect(ids).toEqual([1, 2, 3]);
  });
});
