"use strict";

/**
 * Persisted list-ordering preference, plus the pure formatting of a bookmark's
 * ranking score (issue #62). Shared between the browser (app.js, loaded via
 * <script>) and Vitest (required directly from sort-order.test.ts), the same
 * way post-scale.js and theme.js are.
 *
 * Ordering is a SERVER concern - the list is paged, so sorting one page in the
 * client would only shuffle whichever 20 rows happened to arrive - which is why
 * this module's job is just to remember the choice and turn it into the query
 * parameter `/api/categories/:id/bookmarks` accepts.
 */
(function (root) {
  const SORT_ORDER_KEY = "xbo:sort-order";
  // Recency is the default and always has been. Ranking is opt-in and paid, so
  // a library that was never ranked must open exactly as it did before.
  const DEFAULT_SORT_ORDER = "recent";

  /** The offered orders. `param` is what the API's `sort` query parameter takes. */
  const SORT_ORDERS = [
    { id: "recent", label: "Newest", param: "recent" },
    { id: "score", label: "Top score", param: "score" },
  ];

  function isKnownSortOrder(id) {
    return SORT_ORDERS.some((order) => order.id === id);
  }

  /**
   * The stored order, or the default when nothing is stored, the stored value is
   * not one we offer, or storage is unavailable/throws (private mode, blocked
   * site data).
   */
  function readSortOrder(storage) {
    try {
      const raw = storage.getItem(SORT_ORDER_KEY);
      return isKnownSortOrder(raw) ? raw : DEFAULT_SORT_ORDER;
    } catch (_) {
      return DEFAULT_SORT_ORDER;
    }
  }

  /** Persist the order; an unknown id and a throwing storage are both no-ops. */
  function writeSortOrder(storage, id) {
    if (!isKnownSortOrder(id)) return;
    try {
      storage.setItem(SORT_ORDER_KEY, id);
    } catch (_) {
      /* private mode / blocked storage: ignore */
    }
  }

  /** The API `sort` value for an order id (the default's, if unknown). */
  function sortParam(id) {
    const match = SORT_ORDERS.find((order) => order.id === id);
    return match ? match.param : DEFAULT_SORT_ORDER;
  }

  /**
   * A stored 0..1 score as a compact 0..10 rating, one decimal.
   * Null for a bookmark that was never ranked - which is not a zero, and must
   * not be rendered as one.
   */
  function formatScore(score) {
    if (!score || typeof score.value !== "number" || !isFinite(score.value)) return null;
    const clamped = Math.min(1, Math.max(0, score.value));
    return (Math.round(clamped * 100) / 10).toFixed(1);
  }

  /** Human dimension names, so a tooltip reads as prose rather than as keys. */
  const DIMENSION_LABELS = {
    learning_value: "learning",
    insight_density: "substance",
    durability: "lasting",
    actionability: "actionable",
    relevance: "relevance",
  };

  /**
   * The full sentence behind a score chip: the rating, the model's confidence,
   * and the per-dimension breakdown that makes the number accountable instead
   * of an unexplained verdict. Null when there is no score to describe.
   */
  function describeScore(score) {
    const rating = formatScore(score);
    if (rating === null) return null;
    const parts = [`Learning value ${rating} of 10`];
    if (typeof score.confidence === "number" && isFinite(score.confidence)) {
      parts.push(`confidence ${Math.round(Math.min(1, Math.max(0, score.confidence)) * 100)}%`);
    }
    const dimensions = score.dimensions && typeof score.dimensions === "object" ? score.dimensions : {};
    const breakdown = Object.keys(dimensions)
      .filter((key) => typeof dimensions[key] === "number" && isFinite(dimensions[key]))
      .map((key) => `${DIMENSION_LABELS[key] || key} ${(Math.round(dimensions[key] * 100) / 10).toFixed(1)}`);
    if (breakdown.length > 0) parts.push(breakdown.join(", "));
    return `${parts.join(" · ")}.`;
  }

  const api = {
    SORT_ORDER_KEY,
    DEFAULT_SORT_ORDER,
    SORT_ORDERS,
    DIMENSION_LABELS,
    isKnownSortOrder,
    readSortOrder,
    writeSortOrder,
    sortParam,
    formatScore,
    describeScore,
  };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.XBOSortOrder = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
