"use strict";

/**
 * What a pooled card's X embed should do when the app's theme changes
 * (issue #89) - the DOM-free half, in the same style as `filter-cache.js`.
 *
 * An X embed is a cross-origin iframe whose theme is fixed at `createTweet`
 * time and cannot be changed afterwards, so following the toggle means
 * BUILDING IT AGAIN. That is expensive enough that "which cards" is a real
 * decision rather than "all of them", and it is the whole rule this module
 * holds; `app.js` owns the rebuild itself.
 */
(function (root) {
  /**
   * One of:
   *
   *  - `"rebuild"` - re-create the embed at the current theme. Only a card the
   *    owner can actually SEE earns this: the per-post pool (#67) holds every
   *    card ever loaded, and re-creating dozens of off-screen widgets would
   *    re-fetch them all for nobody.
   *  - `"restamp"` - record the new theme without touching the slot. That is
   *    right for a slot showing the text+link FALLBACK: it is the viewer's own
   *    markup and already follows the theme tokens, and re-running a
   *    `createTweet` that has already failed (or timed out) for this post is
   *    pure cost every time the toggle is pressed.
   *  - `"skip"` - leave the stale stamp alone. A HIDDEN card keeps it until a
   *    view reveals it, and is re-themed then, so a card is never shown under
   *    the wrong theme; a card already on the current theme has nothing to do.
   *
   * `stamp` is the theme the slot was built at (absent for a slot that has
   * never been mounted, which is treated as stale).
   */
  function rethemeAction(slot, theme) {
    var s = slot || {};
    if (s.stamp === theme) return "skip";
    if (s.hidden) return "skip";
    if (s.hasFallback) return "restamp";
    return "rebuild";
  }

  var api = { rethemeAction: rethemeAction };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.XBOEmbedTheme = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
