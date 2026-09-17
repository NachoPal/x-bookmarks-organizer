"use strict";

/**
 * Deterministic color assignment for root categories in the sidebar tree.
 * Shared between the browser (app.js, loaded via <script>) and Vitest
 * (required directly from tree-color.test.ts).
 */
(function (root) {
  // Soft hues spread around the wheel, skipping the danger-red band (~340-20)
  // and the accent-blue band (~195-235) so root tints never fight those
  // existing meanings.
  const ROOT_HUES = [25, 45, 65, 90, 130, 155, 175, 250, 265, 285, 305, 320];

  /** djb2 string hash, unsigned 32-bit. */
  function hashString(str) {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = (hash * 33) ^ str.charCodeAt(i);
    }
    return hash >>> 0;
  }

  /**
   * Stable hue (degrees) for a root category, derived from its id so it
   * never changes across reloads or re-sorts. Cycles through ROOT_HUES when
   * there are more roots than curated colors.
   */
  function rootCategoryHue(categoryId) {
    return ROOT_HUES[hashString(String(categoryId)) % ROOT_HUES.length];
  }

  const api = { ROOT_HUES, hashString, rootCategoryHue };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.XBOTreeColor = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
