"use strict";

/**
 * Persisted category-sidebar WIDTH (issue #99). Pure + guarded, shared
 * between the browser (app.js, loaded via <script>) and Vitest (required
 * directly from sidebar-width.test.ts), the same way sidebar-state.js is -
 * that module owns whether the drawer is open, this one owns how wide it is.
 *
 * The width is stored as a plain pixel NUMBER, not a CSS length: the drag
 * produces pixels, the keyboard steps in pixels, and the clamp below is the
 * one place the bounds are stated. `null` means "nothing chosen" and is what
 * keeps `--sidebar-width`'s own `clamp(17rem, 24vw, 21rem)` default in the
 * stylesheet rather than duplicated here.
 *
 * The bounds are not arbitrary. The floor keeps a nested tree label readable
 * beside its count; the ceiling keeps the viewer column wide enough that the
 * post measure (--content-measure, 44rem) still fits on a laptop, which is
 * what stops a resize from re-laying-out the cross-origin X embeds (the #86
 * constraint).
 */
(function (root) {
  const SIDEBAR_WIDTH_KEY = "xbo:sidebar-width";
  const MIN_SIDEBAR_WIDTH = 220;
  const MAX_SIDEBAR_WIDTH = 480;
  /** One arrow-key press; PageUp/PageDown take the coarser step. */
  const SIDEBAR_WIDTH_STEP = 16;
  const SIDEBAR_WIDTH_PAGE_STEP = 64;

  /**
   * A width held inside the bounds, rounded to a whole pixel. Anything that
   * is not a finite number (a corrupt stored value, a pointer event with no
   * coordinate) yields `null` - the caller then leaves the stylesheet's own
   * default in place rather than inventing a width.
   */
  function clampWidth(px) {
    const value = typeof px === "string" ? Number.parseFloat(px) : px;
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    return Math.round(Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, value)));
  }

  /** The stored width, or `null` when none is stored / storage throws. */
  function readWidth(storage) {
    try {
      return clampWidth(storage.getItem(SIDEBAR_WIDTH_KEY));
    } catch (_) {
      return null;
    }
  }

  /**
   * Persist a width. An unusable value is a no-op rather than a stored
   * `null`, so a stray call can never wipe a good preference; a throwing
   * storage (private mode / blocked) is ignored like everywhere else here.
   */
  function writeWidth(storage, px) {
    const value = clampWidth(px);
    if (value === null) return;
    try {
      storage.setItem(SIDEBAR_WIDTH_KEY, String(value));
    } catch (_) {
      /* private mode / blocked storage: ignore */
    }
  }

  /** Forget the preference, returning the sidebar to the stylesheet default. */
  function clearWidth(storage) {
    try {
      storage.removeItem(SIDEBAR_WIDTH_KEY);
    } catch (_) {
      /* private mode / blocked storage: ignore */
    }
  }

  /**
   * The width a keyboard press moves to. The separator's arrow keys read
   * left-to-right against the sidebar's own right edge: Right grows it,
   * Left shrinks it, Home/End go to the bounds.
   */
  function stepWidth(current, key) {
    const from = clampWidth(current);
    if (from === null) return null;
    switch (key) {
      case "ArrowRight":
        return clampWidth(from + SIDEBAR_WIDTH_STEP);
      case "ArrowLeft":
        return clampWidth(from - SIDEBAR_WIDTH_STEP);
      case "PageUp":
        return clampWidth(from + SIDEBAR_WIDTH_PAGE_STEP);
      case "PageDown":
        return clampWidth(from - SIDEBAR_WIDTH_PAGE_STEP);
      case "Home":
        return MIN_SIDEBAR_WIDTH;
      case "End":
        return MAX_SIDEBAR_WIDTH;
      default:
        return null;
    }
  }

  const api = {
    SIDEBAR_WIDTH_KEY,
    MIN_SIDEBAR_WIDTH,
    MAX_SIDEBAR_WIDTH,
    SIDEBAR_WIDTH_STEP,
    SIDEBAR_WIDTH_PAGE_STEP,
    clampWidth,
    readWidth,
    writeWidth,
    clearWidth,
    stepWidth,
  };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.XBOSidebarWidth = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
