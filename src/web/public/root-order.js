"use strict";

/**
 * Pure list arithmetic for reordering the ROOT categories in the sidebar
 * (issue #82). DOM-free, shared between the browser (app.js, via <script>) and
 * Vitest, the same way tree-counts.js is. The server owns persistence and the
 * final ordering; this only computes "the ids in their new order".
 */
(function (root) {
  /** Move `id` one step (delta -1 = up, +1 = down); clamps at the ends. */
  function moveBy(ids, id, delta) {
    const from = ids.indexOf(id);
    if (from === -1) return ids.slice();
    const to = Math.max(0, Math.min(ids.length - 1, from + delta));
    return moveTo(ids, id, to);
  }

  /** Move `id` so it ends up at index `to` of the result. */
  function moveTo(ids, id, to) {
    const from = ids.indexOf(id);
    if (from === -1) return ids.slice();
    const out = ids.filter((x) => x !== id);
    out.splice(Math.max(0, Math.min(out.length, to)), 0, id);
    return out;
  }

  /**
   * Where a dragged item lands given the vertical midpoints of the OTHER items
   * (top to bottom, dragged one excluded) and the pointer's Y: the number of
   * midpoints the pointer has passed, i.e. its index in the resulting list.
   */
  function dropIndex(otherMidpoints, pointerY) {
    let index = 0;
    for (const mid of otherMidpoints) if (pointerY > mid) index += 1;
    return index;
  }

  function sameOrder(a, b) {
    return a.length === b.length && a.every((x, i) => x === b[i]);
  }

  const api = { moveBy, moveTo, dropIndex, sameOrder };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.XBORootOrder = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
