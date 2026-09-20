"use strict";

/**
 * Persisted categories-sidebar open/closed state. Extracted from app.js so
 * the storage guard is testable in Node (sidebar-state.test.ts) the same way
 * theme.js / tree-color.js are.
 *
 * The sidebar is an overlay drawer at every width (issue #42), so "collapsed"
 * is purely a visibility preference - it never changes the content column's
 * layout.
 */
(function (root) {
  const SIDEBAR_KEY = "xbo:sidebar-collapsed";

  /**
   * Whether the drawer should start closed. Defaults to closed, so a first
   * visit (and any browser where storage throws) opens straight onto the
   * centered content column rather than behind an overlay.
   */
  function readCollapsed(storage) {
    try {
      return storage.getItem(SIDEBAR_KEY) !== "0";
    } catch (_) {
      return true;
    }
  }

  /** Persist the preference; silently ignored if storage throws. */
  function writeCollapsed(storage, collapsed) {
    try {
      storage.setItem(SIDEBAR_KEY, collapsed ? "1" : "0");
    } catch (_) {
      /* private mode / blocked storage: ignore */
    }
  }

  const api = { SIDEBAR_KEY, readCollapsed, writeCollapsed };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.XBOSidebarState = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
