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

  /**
   * Which way a card travels as it leaves the tab it no longer belongs to
   * (issue #99). The exit is direction-AWARE, not decorative: the Unread and
   * Read tabs sit side by side in that order, so a post marked read moves
   * RIGHT, towards the tab it is joining, and a post marked unread moves
   * LEFT, back the way it came. The motion says where it went.
   *
   * Anything that is not a read-state change (un-starring in Favorites) has
   * no such neighbour to move towards and keeps the original rightward
   * dismissal - hence the default.
   */
  function readExitDirection(read) {
    return read ? "right" : "left";
  }

  /**
   * The `transform` that carries a card out in `direction`, as a share of the
   * card's own width. Kept beside the direction so the sign is decided once:
   * a card that fades out while travelling the WRONG way reads as the app
   * having done the opposite of what was asked.
   */
  function exitTranslate(direction, distance) {
    return direction === "left" ? `translateX(-${distance})` : `translateX(${distance})`;
  }

  const api = { readToggleLabel, readExitDirection, exitTranslate };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.XBOReadToggle = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
