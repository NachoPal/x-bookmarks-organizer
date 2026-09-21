import { describe, expect, it } from "vitest";

// Plain browser JS, required directly (not compiled by tsc).
const { MOVE_UNDO_MS, sameMembership, snapshotMove, canUndo, undoTargets } = require("./move-undo.js");
const { buildCategoryIndex, applyMoveDelta } = require("./tree-counts.js");

describe("snapshotMove", () => {
  it("captures the membership the move is about to overwrite", () => {
    const bm = { id: 7, categoryIds: [3, 9] };
    const snap = snapshotMove(bm, [12]);
    expect(snap).toEqual({ bookmarkId: 7, fromIds: [3, 9], toIds: [12] });
  });

  it("is unaffected by the move that follows it (it copies, not aliases)", () => {
    const bm = { id: 7, categoryIds: [3] };
    const snap = snapshotMove(bm, [12]);
    bm.categoryIds = [12]; // what the move then does to the shared bookmark
    expect(snap.fromIds).toEqual([3]);
  });

  it("normalizes away duplicates and non-ids", () => {
    const bm = { id: 1, categoryIds: [4, 4, "5", null, undefined] };
    expect(snapshotMove(bm, [2]).fromIds).toEqual([4, 5]);
  });

  it("copes with a bookmark that carries no category list", () => {
    expect(snapshotMove({ id: 1 }, [2]).fromIds).toEqual([]);
  });
});

describe("canUndo", () => {
  it("offers Undo for a post that was filed somewhere else", () => {
    expect(canUndo(snapshotMove({ id: 1, categoryIds: [3] }, [9]))).toBe(true);
  });

  it("offers Undo for a multi-labelled post the move collapsed", () => {
    expect(canUndo(snapshotMove({ id: 1, categoryIds: [3, 9] }, [9]))).toBe(true);
  });

  it("does not offer Undo for a post that was filed nowhere", () => {
    expect(canUndo(snapshotMove({ id: 1, categoryIds: [] }, [9]))).toBe(false);
  });

  it("does not offer Undo for a move that changed nothing", () => {
    expect(canUndo(snapshotMove({ id: 1, categoryIds: [9] }, [9]))).toBe(false);
  });
});

describe("sameMembership", () => {
  it("ignores order", () => {
    expect(sameMembership([3, 9], [9, 3])).toBe(true);
  });

  it("distinguishes different sets", () => {
    expect(sameMembership([3], [3, 9])).toBe(false);
  });
});

describe("the toast dwell time", () => {
  it("outlasts the delete toast's undo window - a move asks the owner to choose", () => {
    expect(MOVE_UNDO_MS).toBeGreaterThan(6000);
  });
});

describe("Undo restores the prior categories", () => {
  /**
   *   Reading                Watching
   *     |- Essays              |- Talks
   *     |- Papers
   */
  function tree() {
    const essays = { id: 2, parentId: 1, name: "Essays", total: 4, unread: 2, children: [] };
    const papers = { id: 3, parentId: 1, name: "Papers", total: 2, unread: 1, children: [] };
    const reading = {
      id: 1,
      parentId: null,
      name: "Reading",
      total: 6,
      unread: 3,
      children: [essays, papers],
    };
    const talks = { id: 5, parentId: 4, name: "Talks", total: 1, unread: 0, children: [] };
    const watching = {
      id: 4,
      parentId: null,
      name: "Watching",
      total: 1,
      unread: 0,
      children: [talks],
    };
    return buildCategoryIndex([reading, watching]);
  }

  const snapshotCounts = (index: Map<number, { total: number; unread: number }>) =>
    [...index.entries()].map(([id, node]) => [id, node.total, node.unread]);

  it("re-files a multi-labelled post back to every category it was in", () => {
    const bm = { id: 10, categoryIds: [2, 3], read: false };
    const snap = snapshotMove(bm, [5]);
    bm.categoryIds = [5]; // the move: replace-all, both memberships gone

    expect(undoTargets(snap)).toEqual([2, 3]);
    bm.categoryIds = undoTargets(snap);
    expect(bm.categoryIds).toEqual([2, 3]);
  });

  it("puts every rolled-up counter back exactly where it was", () => {
    const index = tree();
    const before = snapshotCounts(index);
    const bm = { id: 10, categoryIds: [2, 3], read: false };
    const snap = snapshotMove(bm, [5]);

    // The move, then the undo, as `refileBookmark` performs them.
    applyMoveDelta(index, snap.fromIds, snap.toIds, 1);
    expect(snapshotCounts(index)).not.toEqual(before); // it really did move
    expect(index.get(5)!.total).toBe(2);
    expect(index.get(4)!.total).toBe(2);

    applyMoveDelta(index, snap.toIds, undoTargets(snap), 1);
    expect(snapshotCounts(index)).toEqual(before);
  });

  it("counts a post shared by two siblings once in their parent", () => {
    const index = tree();
    // Undo restores BOTH Essays and Papers; Reading already counted the post
    // once and must still count it once.
    applyMoveDelta(index, [5], [2, 3], 0);
    expect(index.get(2)!.total).toBe(5);
    expect(index.get(3)!.total).toBe(3);
    expect(index.get(1)!.total).toBe(7); // +1, not +2
  });
});
