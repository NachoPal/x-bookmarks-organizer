"use strict";

/**
 * Pure "is this post text long enough to clamp" logic, shared between the
 * browser (app.js, loaded via <script>) and Vitest (required directly from
 * post-text.test.ts). Character/line-count heuristic rather than a DOM
 * measurement (matches this codebase's other pure, DOM-free view helpers -
 * tree-counts.js, filter-cache.js, read-toggle.js) so it stays deterministic
 * and testable without a real layout.
 */
(function (root) {
  // Roughly the point a post stops fitting the card's ~6-line clamp at the
  // card's fixed measure (--post-card-measure) and default post font size.
  const LONG_TEXT_CHAR_THRESHOLD = 280;
  const CLAMPED_LINES = 6;

  function isLongPostText(text) {
    if (!text) return false;
    const trimmed = String(text).trim();
    if (!trimmed) return false;
    const lineBreaks = (trimmed.match(/\n/g) || []).length;
    return trimmed.length > LONG_TEXT_CHAR_THRESHOLD || lineBreaks >= CLAMPED_LINES;
  }

  const api = { isLongPostText, CLAMPED_LINES };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.XBOPostText = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
