"use strict";

/**
 * What a pooled card's X embed should do when the app's theme changes
 * (issues #89, #90) - the DOM-free half, in the same style as
 * `filter-cache.js`.
 *
 * An X embed is a cross-origin iframe whose theme is fixed at `createTweet`
 * time and cannot be changed afterwards, so a post shown under BOTH themes
 * needs two embeds. The first time a post is shown in a given theme that
 * variant has to be built (and loads, with the skeleton + spinner) - X gives
 * no way around it. Every time after that it is already in the DOM, hidden
 * beside its sibling, so following the toggle is just a matter of revealing
 * the right one: toggling BACK to a theme already seen must never reload.
 *
 * That is the whole rule this module holds - `app.js` owns the DOM nodes,
 * builds the variants and bounds how many are kept (see MAX_POOLED_EMBEDS).
 */
(function (root) {
  // Theme variants (each a live X iframe) kept mounted across the whole pool.
  // A post seen under both themes holds two, so this is deliberately larger
  // than `XBOFilterCache.MAX_POOLED_POSTS` (120) without being twice it: the
  // card currently showing is never released, so the headroom above the post
  // cap is what bounds the SPARE - off-screen, other-theme - variants.
  var MAX_POOLED_EMBEDS = 160;

  /**
   * What to do with one card's embed slot when the theme becomes `theme`.
   *
   * `slot` is `{ hidden, variants }`, where `hidden` is the CARD's hidden
   * state and each variant is `{ theme, fallback, visible }` in DOM order:
   * the theme it was built at, whether it settled on the text+link FALLBACK,
   * and whether it is the one currently shown.
   *
   * Returns one of:
   *
   *  - `{ action: "skip" }` - nothing to do. A HIDDEN card keeps whatever it
   *    is showing until a view reveals it, and is re-themed then, so a card
   *    is never SHOWN under the wrong theme while dozens of off-screen
   *    widgets are not rebuilt for nobody. A card already showing a variant
   *    that serves `theme` has nothing to do either.
   *  - `{ action: "reveal", index }` - show the variant at `index`; it is
   *    already built and mounted, so this costs nothing and never reloads.
   *  - `{ action: "build" }` - no variant serves `theme` yet: create one at
   *    the current theme (this is the one case that loads).
   *
   * A variant that settled on the fallback serves ANY theme: it is the
   * viewer's own markup and already follows the theme tokens, and re-running
   * a `createTweet` that has already failed for this post is pure cost every
   * time the toggle is pressed. It is only a LAST resort, though - an exact
   * theme match is always preferred, so a post whose light embed rendered and
   * whose dark one fell back still shows the real embed in light.
   */
  function rethemeAction(slot, theme) {
    var s = slot || {};
    if (s.hidden) return { action: "skip" };
    var variants = s.variants || [];
    var index = indexOf(variants, function (v) {
      return v.theme === theme;
    });
    if (index === -1) {
      index = indexOf(variants, function (v) {
        return !!v.fallback;
      });
    }
    if (index === -1) return { action: "build" };
    if (variants[index].visible) return { action: "skip" };
    return { action: "reveal", index: index };
  }

  function indexOf(list, pred) {
    for (var i = 0; i < list.length; i += 1) {
      if (pred(list[i])) return i;
    }
    return -1;
  }

  /** The pool key for one post's variant at one theme. */
  function variantKey(postId, theme) {
    return String(postId) + ":" + theme;
  }

  /** Split a {@link variantKey} back into `{ id, theme }` (`id` as a string). */
  function parseVariantKey(key) {
    var at = key.lastIndexOf(":");
    return { id: key.slice(0, at), theme: key.slice(at + 1) };
  }

  var api = {
    MAX_POOLED_EMBEDS: MAX_POOLED_EMBEDS,
    rethemeAction: rethemeAction,
    variantKey: variantKey,
    parseVariantKey: parseVariantKey,
  };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.XBOEmbedTheme = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
