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
  // Rendered cards (each holding a live X embed iframe) kept mounted, keyed
  // by post - issue #67. Bounded so a long session never grows the DOM
  // without limit; the oldest post not on screen is released first.
  const MAX_POOLED_POSTS = 120;

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
   * Per-post LRU (issue #67): mark `ids` most recently used in `order`
   * (oldest first) and evict the oldest posts beyond `max` - never one in
   * `protectedIds` (the posts on screen), even if that leaves the pool over
   * the cap. Returns a fresh `{ order, evicted }`; the input is not mutated.
   */
  function touchPool(order, ids, max, protectedIds) {
    const limit = max || MAX_POOLED_POSTS;
    const touched = new Set(ids);
    const keep = new Set(protectedIds || []);
    const next = order.filter((id) => !touched.has(id));
    for (const id of ids) next.push(id);
    const evicted = [];
    let over = next.length - limit;
    const kept = [];
    for (const id of next) {
      if (over > 0 && !keep.has(id)) {
        evicted.push(id);
        over -= 1;
      } else {
        kept.push(id);
      }
    }
    return { order: kept, evicted };
  }

  /**
   * The ids of a complete "All" list (`allIds`, `bmById`) that belong in
   * `filter`, in the same order - the server sorts every filter the same
   * way, so an Unread/Read/Favorites view of a fully loaded category needs
   * no fetch at all.
   */
  function deriveFilterIds(filter, allIds, bmById) {
    return allIds.filter((id) => {
      const bm = bmById.get(id);
      return bm && survivesFilter(filter, bm);
    });
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

  /**
   * How to show a view that is not cached and must be fetched (issue #78).
   * Switching only the TAB of an already-open category keeps the current
   * content on screen until the new first page arrives, so there is no
   * blank/white frame in between; anything else (a new category, or nothing
   * mounted yet) shows the loading placeholder at once.
   */
  function loadingStrategy(categoryChanged, hostMounted) {
    return !categoryChanged && hostMounted ? "keep-content" : "placeholder";
  }

  const api = {
    loadingStrategy,
    MAX_CACHED_CATEGORIES,
    MAX_POOLED_POSTS,
    touchLru,
    touchPool,
    deriveFilterIds,
    survivesFilter,
    isFilterEntryStale,
  };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.XBOFilterCache = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
