"use strict";

/**
 * The floating scroll-to-top control's visibility rule (issue #99). Pure and
 * DOM-free, in the same style as post-scale.js / sort-order.js, so the one
 * decision worth getting right - when the button appears and when it goes
 * away again - is unit-tested rather than inferred from a scroll listener.
 *
 * Two thresholds, not one: a single boundary makes the button flicker on and
 * off while the list is nudged around it. Showing takes a deliberate scroll
 * (SHOW_AT), hiding only happens once the owner is genuinely back near the
 * top (HIDE_AT), so the control is steady in the band between them.
 */
(function (root) {
  /** Scrolled this far down (px): the control is worth offering. */
  const SHOW_AT = 320;
  /** Back within this far of the top (px): nothing left to scroll back to. */
  const HIDE_AT = 120;

  /**
   * Whether the control should be visible after a scroll to `scrollTop`,
   * given whether it is visible NOW. A non-finite scroll position (a pane
   * that has not been laid out yet) hides it.
   */
  function nextVisible(scrollTop, visible) {
    if (typeof scrollTop !== "number" || !Number.isFinite(scrollTop)) return false;
    return visible ? scrollTop > HIDE_AT : scrollTop > SHOW_AT;
  }

  /**
   * The scroll behavior to ask the platform for. Reduced motion gets an
   * instant jump rather than no jump at all: the destination is the point,
   * the travel is the decoration.
   */
  function scrollBehavior(reducedMotion) {
    return reducedMotion ? "auto" : "smooth";
  }

  const api = { SHOW_AT, HIDE_AT, nextVisible, scrollBehavior };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.XBOScrollTop = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
