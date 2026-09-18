"use strict";

/**
 * Pure read/unread pill label logic, shared between the browser (app.js,
 * loaded via <script>) and Vitest (required directly from
 * read-toggle.test.ts).
 *
 * An unread bookmark's label is the ACTION a click performs ("Mark as
 * read"); a read bookmark's label is its STATE ("Read"), not a second
 * action label - per issue #54's owner correction, only the unread ->
 * read direction is spelled out as an action. The pill stays clickable
 * either way: clicking "Read" toggles back to unread.
 */
(function (root) {
  function readToggleLabel(read) {
    return read ? "Read" : "Mark as read";
  }

  const api = { readToggleLabel };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.XBOReadToggle = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
