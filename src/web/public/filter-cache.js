"use strict";

/**
 * Pure, DOM-free bookkeeping for the viewer's client-side category+filter
 * cache (issue #33): switching the Unread/Read/All filter (or switching back
 * to a category already visited) reuses already-fetched pages and
 * already-rendered DOM instead of re-fetching and re-rendering (which used
 * to reload every X embed). app.js owns the actual DOM nodes and bookmark
 * objects; this module only decides LRU eviction order and whether a
 * bookmark id still belongs in a cached read-state-filtered id list after a
 * read-state change, so that decision stays unit-testable without a DOM.
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
   * Whether a bookmark whose read state is now `read` still belongs in a
   * cached id list for `filter` ("all" | "unread" | "read"). "all" never
   * drops a post on a read-state change - only "unread"/"read" membership
   * can flip.
   */
  function survivesReadChange(filter, read) {
    if (filter === "unread") return !read;
    if (filter === "read") return read;
    return true;
  }

  /**
   * Whether a cached filter's id list (`ids`, `filter` being "unread" or
   * "read") is now stale for `bookmarkId` after its read state became
   * `read` - i.e. its cached presence/absence no longer matches
   * {@link survivesReadChange}. A stale entry can only be fixed by
   * invalidating it (the correct sort position for a newly-qualifying post
   * is unknown to the client) - never by only pruning, which would drop a
   * post from the Unread cache on read but silently omit it from the Read
   * cache too until the next full fetch.
   */
  function isFilterEntryStale(ids, filter, bookmarkId, read) {
    return ids.includes(bookmarkId) !== survivesReadChange(filter, read);
  }

  const api = {
    MAX_CACHED_CATEGORIES,
    touchLru,
    survivesReadChange,
    isFilterEntryStale,
  };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.XBOFilterCache = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
