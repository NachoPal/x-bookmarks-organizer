"use strict";

/**
 * Pure read/unread pill label logic, shared between the browser (app.js,
 * loaded via <script>) and Vitest (required directly from
 * read-toggle.test.ts).
 *
 * The pill's label is the ACTION a click performs, not the current state
 * (issue #54) - so an unread bookmark shows "Mark as read" and a read one
 * shows "Mark as unread".
 */
(function (root) {
  function readToggleLabel(read) {
    return read ? "Mark as unread" : "Mark as read";
  }

  const api = { readToggleLabel };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.XBOReadToggle = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
