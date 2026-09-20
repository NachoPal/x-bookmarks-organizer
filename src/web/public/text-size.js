"use strict";

/**
 * Persisted text-size preference (issue #37). Shared between the browser
 * (app.js, loaded via <script>) and Vitest (required directly from
 * text-size.test.ts), the same way theme.js is.
 *
 * The chosen step is applied as a single `--text-scale` multiplier on
 * :root; every `--text-*` token in styles.css derives from it, so one
 * value scales the whole viewer's type without touching layout metrics.
 */
(function (root) {
  const TEXT_SIZE_KEY = "xbo:text-size";
  const DEFAULT_TEXT_SIZE = "medium";

  /** The offered steps, in slider order. `scale` feeds `--text-scale`. */
  const TEXT_SIZES = [
    { id: "small", label: "Small", scale: 0.875 },
    { id: "medium", label: "Medium", scale: 1 },
    { id: "large", label: "Large", scale: 1.125 },
  ];

  function isKnownSize(id) {
    return TEXT_SIZES.some((size) => size.id === id);
  }

  /**
   * The stored step id, or the default when nothing is stored, the stored
   * value is not one we offer, or storage is unavailable/throws.
   */
  function readTextSize(storage) {
    try {
      const raw = storage.getItem(TEXT_SIZE_KEY);
      return isKnownSize(raw) ? raw : DEFAULT_TEXT_SIZE;
    } catch (_) {
      return DEFAULT_TEXT_SIZE;
    }
  }

  /** Persist the step; an unknown id and a throwing storage are both no-ops. */
  function writeTextSize(storage, id) {
    if (!isKnownSize(id)) return;
    try {
      storage.setItem(TEXT_SIZE_KEY, id);
    } catch (_) {
      /* private mode / blocked storage: ignore */
    }
  }

  /** The `--text-scale` multiplier for a step id (default's scale if unknown). */
  function scaleFor(id) {
    const match = TEXT_SIZES.find((size) => size.id === id);
    return match ? match.scale : 1;
  }

  const api = {
    TEXT_SIZE_KEY,
    DEFAULT_TEXT_SIZE,
    TEXT_SIZES,
    isKnownSize,
    readTextSize,
    writeTextSize,
    scaleFor,
  };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.XBOTextSize = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
