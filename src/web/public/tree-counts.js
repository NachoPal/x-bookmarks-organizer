"use strict";

/**
 * Pure sidebar-count-rollup logic for the category tree, shared between the
 * browser (app.js, loaded via <script>) and Vitest (required directly from
 * tree-counts.test.ts).
 *
 * A category's total/unread counts distinct bookmarks across itself and all
 * descendants (see src/categorize/tree.ts's assembleTree). So a read-state
 * toggle or delete on one bookmark must patch not just its direct
 * category/ies but every ancestor up each of their chains, deduplicated so a
 * shared ancestor is only adjusted once.
 */
(function (root) {
  /** Flatten a tree (array of {id, parentId, children, ...}) into id -> node. */
  function buildCategoryIndex(roots) {
    const index = new Map();
    const walk = (nodes) => {
      for (const node of nodes) {
        index.set(node.id, node);
        if (node.children && node.children.length) walk(node.children);
      }
    };
    walk(roots || []);
    return index;
  }

  /** `categoryId` followed by each of its ancestors, nearest first. */
  function ancestorChainIds(index, categoryId) {
    const ids = [];
    let node = index.get(categoryId);
    while (node) {
      ids.push(node.id);
      node = node.parentId != null ? index.get(node.parentId) : undefined;
    }
    return ids;
  }

  /** The deduplicated set of category ids affected by a bookmark filed under `directCategoryIds`. */
  function affectedCategoryIds(index, directCategoryIds) {
    const set = new Set();
    for (const id of directCategoryIds || []) {
      for (const ancestorId of ancestorChainIds(index, id)) set.add(ancestorId);
    }
    return set;
  }

  /**
   * Apply a total/unread delta to a bookmark's direct categories and all
   * their ancestors, mutating each affected node in place (clamped at 0) and
   * returning the updated nodes so the caller can patch only the
   * corresponding DOM elements instead of re-rendering the whole tree.
   */
  function applyCountDelta(index, directCategoryIds, totalDelta, unreadDelta) {
    const ids = affectedCategoryIds(index, directCategoryIds);
    const updated = [];
    for (const id of ids) {
      const node = index.get(id);
      if (!node) continue;
      node.total = Math.max(0, node.total + totalDelta);
      node.unread = Math.max(0, node.unread + unreadDelta);
      updated.push(node);
    }
    return updated;
  }

  /**
   * Per-tab badge counts for one category's rolled-up counts (issue #72).
   * Read is derived (total - unread); favorite may be absent on old payloads.
   */
  function tabCounts(counts) {
    const total = counts.total || 0;
    const unread = counts.unread || 0;
    return {
      unread,
      read: Math.max(0, total - unread),
      all: total,
      favorite: counts.favorite || 0,
    };
  }

  const api = { tabCounts, buildCategoryIndex, ancestorChainIds, affectedCategoryIds, applyCountDelta };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.XBOTreeCounts = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
