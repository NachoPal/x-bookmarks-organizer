"use strict";

/**
 * The undoable half of a manual move (issues #92, #99). Pure and DOM-free,
 * required directly by move-undo.test.ts the same way tree-counts.js is.
 *
 * A move is a REPLACE, not an add: `Database.setBookmarkCategory` drops every
 * `bookmark_categories` row for the post and writes the chosen one. So the
 * only thing that can put a multi-labelled post back the way it was is a
 * snapshot of its membership taken BEFORE the write - which is what this
 * module owns. Undo is then the same re-file operation run in reverse, and
 * because `XBOTreeCounts.applyMoveDelta` is symmetric, the sidebar's rolled-up
 * counters land exactly back where they started.
 */
(function (root) {
  /**
   * How long the move toast stays. Longer than the delete toast's undo window
   * (6s) on purpose: a move offers a SECOND action ("View"), and a toast that
   * asks the owner to choose has to outlast the reading of it.
   */
  const MOVE_UNDO_MS = 10000;

  /** Distinct ids, in order, as numbers - a membership list to compare/restore. */
  function normalizeIds(ids) {
    const seen = new Set();
    const out = [];
    for (const raw of ids || []) {
      // `Number(null)` is 0 and `Number("")` is 0, and 0 is an integer - a
      // blank has to be rejected before it can be read as a category id.
      if (raw === null || raw === undefined || raw === "") continue;
      const id = Number(raw);
      if (!Number.isInteger(id) || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out;
  }

  /** Whether two membership lists name the same set of categories. */
  function sameMembership(a, b) {
    const left = normalizeIds(a);
    const right = normalizeIds(b);
    if (left.length !== right.length) return false;
    const set = new Set(right);
    return left.every((id) => set.has(id));
  }

  /**
   * Capture what a move is about to overwrite. Taken from the bookmark the
   * viewer already holds (`categoryIds` rides on every listed bookmark), so
   * it costs no round trip - but it MUST be read before the PUT, because the
   * response reports the new membership, and the old one is then gone.
   */
  function snapshotMove(bookmark, toIds) {
    return {
      bookmarkId: bookmark ? bookmark.id : null,
      fromIds: normalizeIds(bookmark ? bookmark.categoryIds : []),
      toIds: normalizeIds(toIds),
    };
  }

  /**
   * Whether the snapshot describes something worth offering Undo for: a post
   * that was filed somewhere else before. A post filed nowhere has no prior
   * state to restore (undoing would have to un-file it, which the move
   * endpoint cannot express and the owner did not ask for), and a "move" to
   * where it already was changed nothing.
   */
  function canUndo(snapshot) {
    if (!snapshot || snapshot.fromIds.length === 0) return false;
    return !sameMembership(snapshot.fromIds, snapshot.toIds);
  }

  /** The membership an Undo re-files the post back to. */
  function undoTargets(snapshot) {
    return snapshot ? snapshot.fromIds.slice() : [];
  }

  const api = {
    MOVE_UNDO_MS,
    normalizeIds,
    sameMembership,
    snapshotMove,
    canUndo,
    undoTargets,
  };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.XBOMoveUndo = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
