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

  /**
   * The rubric's dimensions (`src/rank/rubric.ts`) in the rubric's own order,
   * heaviest question first, with the two label registers the two surfaces
   * need: a terse `short` for the prose sentence a screen reader hears, and a
   * full `label` for the breakdown graph's row labels.
   *
   * The order lives here rather than being taken from a stored row's key
   * order, so the graph's rows never reshuffle between two bookmarks.
   */
  const DIMENSIONS = [
    { id: "learning_value", short: "learning", label: "Learning value" },
    { id: "insight_density", short: "substance", label: "Insight density" },
    { id: "durability", short: "lasting", label: "Durability" },
    { id: "actionability", short: "actionable", label: "Actionability" },
    { id: "relevance", short: "relevance", label: "Relevance" },
  ];

  const DIMENSION_BY_ID = {};
  for (const dimension of DIMENSIONS) DIMENSION_BY_ID[dimension.id] = dimension;

  /** Human dimension names, so a tooltip reads as prose rather than as keys. */
  const DIMENSION_LABELS = {};
  for (const dimension of DIMENSIONS) DIMENSION_LABELS[dimension.id] = dimension.short;

  function clamp01(value) {
    return Math.min(1, Math.max(0, value));
  }

  function isScored(value) {
    return typeof value === "number" && isFinite(value);
  }

  /** A 0..1 dimension value as its own 0..10 rating, one decimal. */
  function dimensionRating(value) {
    return (Math.round(clamp01(value) * 100) / 10).toFixed(1);
  }

  /**
   * A stored score unpacked into everything the chip's breakdown graph needs:
   * the overall rating, the model's confidence, and one row per rubric
   * dimension carrying its label, its 0..1 value and the 0..10 rating that
   * labels its bar.
   *
   * Pure and DOM-free on purpose - the graph is a handful of `<div>`s built
   * from this, so the arithmetic deciding what it says is unit-tested with
   * nothing to stub, the same way `tree-counts.js` is.
   *
   * A dimension the stored row does not carry is OMITTED, never zero-filled:
   * `relevance` is opt-in (`XBOOKMARKS_RANKER_INTERESTS`) and a row written
   * under an earlier rubric simply has fewer answers. A dimension this build
   * has no descriptor for still shows, labelled by its raw key, so a rubric
   * that gains a question is not silently half-rendered. Null for a bookmark
   * the ranking pass never scored - which is not a zero.
   */
  function scoreBreakdown(score) {
    const rating = formatScore(score);
    if (rating === null) return null;
    const raw = score.dimensions && typeof score.dimensions === "object" ? score.dimensions : {};
    const ids = [
      ...DIMENSIONS.map((dimension) => dimension.id),
      ...Object.keys(raw).filter((id) => !DIMENSION_BY_ID[id]),
    ].filter((id) => isScored(raw[id]));
    const confidence = isScored(score.confidence) ? clamp01(score.confidence) : null;
    return {
      rating,
      value: clamp01(score.value),
      confidence,
      confidencePercent: confidence === null ? null : Math.round(confidence * 100),
      dimensions: ids.map((id) => {
        const value = clamp01(raw[id]);
        const descriptor = DIMENSION_BY_ID[id];
        return {
          id,
          label: descriptor ? descriptor.label : id,
          short: descriptor ? descriptor.short : id,
          value,
          rating: dimensionRating(value),
          percent: Math.round(value * 100),
        };
      }),
    };
  }

  /**
   * The full sentence behind a score chip: the rating, the model's confidence,
   * and the per-dimension breakdown that makes the number accountable instead
   * of an unexplained verdict. Null when there is no score to describe.
   *
   * This is the chip's accessible NAME, and the graph the chip reveals is the
   * same facts drawn - both are built from one `scoreBreakdown`, so they can
   * never disagree about what the model said.
   */
  function describeScore(score) {
    const breakdown = scoreBreakdown(score);
    if (breakdown === null) return null;
    const parts = [`Learning value ${breakdown.rating} of 10`];
    if (breakdown.confidencePercent !== null) parts.push(`confidence ${breakdown.confidencePercent}%`);
    if (breakdown.dimensions.length > 0) {
      parts.push(breakdown.dimensions.map((dimension) => `${dimension.short} ${dimension.rating}`).join(", "));
    }
    return `${parts.join(" · ")}.`;
  }

  const api = {
    SORT_ORDER_KEY,
    DEFAULT_SORT_ORDER,
    SORT_ORDERS,
    DIMENSIONS,
    DIMENSION_LABELS,
    isKnownSortOrder,
    readSortOrder,
    writeSortOrder,
    sortParam,
    formatScore,
    scoreBreakdown,
    describeScore,
  };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.XBOSortOrder = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
