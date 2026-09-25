"use strict";

/**
 * Pure, DOM-free half of the sidebar's drill-down: a root page with one large
 * row per section ("Categories", then "Lists" - the result lists an AI
 * assistant sends with the MCP tool `show_in_app`), and one page per section
 * with a Back control. app.js owns the markup and focus; this owns which
 * page is open across reloads (guarded persistence, in the same style as
 * sidebar-state.js), the unviewed-list count and the words around it.
 *
 * The page is visible at first paint, so the inline `#xbo-preboot` script in
 * index.html applies the stored one before the paint; `preboot.test.ts` runs
 * that script against PAGE_KEY / readPage so the two cannot drift.
 */
(function (root) {
  const PAGE_KEY = "xbo:sidebar-page";
  const PAGES = ["root", "categories", "lists"];
  /** A first visit opens on the menu, so both sections are in view. */
  const DEFAULT_PAGE = "root";

  function isPage(page) {
    return PAGES.indexOf(page) !== -1;
  }

  function readPage(storage) {
    try {
      const page = storage.getItem(PAGE_KEY);
      return isPage(page) ? page : DEFAULT_PAGE;
    } catch (_) {
      return DEFAULT_PAGE;
    }
  }

  function writePage(storage, page) {
    if (!isPage(page)) return;
    try {
      storage.setItem(PAGE_KEY, page);
    } catch (_) {
      /* private mode / blocked storage: ignore */
    }
  }

  /**
   * How many lists the owner has not opened yet. A list waiting out its
   * delete's undo window is already gone from the page, so it is not counted.
   */
  function unviewedCount(lists, pendingIds) {
    let n = 0;
    for (const list of lists) {
      if (!list.viewed && !(pendingIds && pendingIds.has(list.id))) n += 1;
    }
    return n;
  }

  function plural(n, one, many) {
    return `${n} ${n === 1 ? one : many}`;
  }

  /** The Categories row's second line. `null` = the tree has not loaded (yet, or at all). */
  function categoriesMeta(count, failed) {
    if (count == null) return failed ? "Couldn't load" : "Loading…";
    return count === 0 ? "None yet" : plural(count, "category", "categories");
  }

  /** The Lists row's second line. */
  function listsMeta(count) {
    return count === 0 ? "None yet" : plural(count, "list", "lists");
  }

  /** The Lists row's accessible name: its visible label first (WCAG 2.5.3). */
  function listsRowLabel(count, unviewed) {
    const base = `Lists, ${listsMeta(count).toLowerCase()}`;
    return unviewed > 0 ? `${base}, ${unviewed} new` : base;
  }

  /** A page's Back control. Categories' carries the count, so new lists are never out of sight. */
  function backLabel(unviewed) {
    return unviewed > 0 ? `Back to the menu, ${plural(unviewed, "new list", "new lists")}` : "Back to the menu";
  }

  const api = {
    PAGE_KEY,
    PAGES,
    DEFAULT_PAGE,
    isPage,
    readPage,
    writePage,
    unviewedCount,
    categoriesMeta,
    listsMeta,
    listsRowLabel,
    backLabel,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.XBOSidebarNav = api;
})(typeof window !== "undefined" ? window : globalThis);
