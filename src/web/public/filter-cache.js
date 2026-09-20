"use strict";

/**
 * Pure, DOM-free bookkeeping for the viewer's client-side category+filter
 * cache (issue #33): switching the filter tab (or switching back
 * to a category already visited) reuses already-fetched pages and
 * already-rendered DOM instead of re-fetching and re-rendering (which used
 * to reload every X embed). app.js owns the actual DOM nodes and bookmark
 * objects; this module only decides LRU eviction order and whether a
 * bookmark id still belongs in a cached filtered id list (Unread / Read /
 * Favorites) after a read-state or favorite toggle, so that decision stays
 * unit-testable without a DOM.
 */
(function (root) {
  const MAX_CACHED_CATEGORIES = 3;

  /**
   * Move `categoryId` to the most-recently-used end of `order`, evicting the
   * oldest entries beyond `max` (default {@link MAX_CACHED_CATEGORIES}) so
   * the cache never grows unbounded across many categories. Returns a fresh
   * `{ order, evicted }` - `order` never mutates the input array.
   */
  function touchLru(order, categoryId, max) {
    const limit = max || MAX_CACHED_CATEGORIES;
    const next = order.filter((id) => id !== categoryId);
    next.push(categoryId);
    const evicted = [];
    while (next.length > limit) evicted.push(next.shift());
    return { order: next, evicted };
  }

  /**
   * Whether a bookmark in state `bm` ({ read, favorite }) belongs in a
   * cached id list for `filter` ("all" | "unread" | "read" | "favorite").
   * "all" never drops a post on a toggle - only the three filtered tabs'
   * membership can flip.
   */
  function survivesFilter(filter, bm) {
    if (filter === "unread") return !bm.read;
    if (filter === "read") return !!bm.read;
    if (filter === "favorite") return !!bm.favorite;
    return true;
  }

  /**
   * Whether a cached filtered tab's id list (`ids`, `filter` being "unread",
   * "read" or "favorite") is now stale for `bookmarkId` after a read-state
   * or favorite toggle left it in state `bm` - i.e. its cached
   * presence/absence no longer matches {@link survivesFilter}. A stale entry
   * can only be fixed by invalidating it (the correct sort position for a
   * newly-qualifying post is unknown to the client) - never by only pruning,
   * which would drop a post from the Unread cache on read but silently omit
   * it from the Read cache too until the next full fetch.
   */
  function isFilterEntryStale(ids, filter, bookmarkId, bm) {
    return ids.includes(bookmarkId) !== survivesFilter(filter, bm);
  }

  const api = {
    MAX_CACHED_CATEGORIES,
    touchLru,
    survivesFilter,
    isFilterEntryStale,
  };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.XBOFilterCache = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
