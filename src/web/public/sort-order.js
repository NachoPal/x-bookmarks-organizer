"use strict";

/**
 * Persisted list-ordering preference - the FIELD (issue #62) and, since issue
 * #97, its DIRECTION - plus the pure formatting of a bookmark's ranking score.
 * Shared between the browser (app.js, loaded via <script>) and Vitest
 * (required directly from sort-order.test.ts), the same way post-scale.js and
 * theme.js are.
 *
 * Ordering is a SERVER concern - the list is paged, so sorting one page in the
 * client would only shuffle whichever 20 rows happened to arrive - which is why
 * this module's job is just to remember the choice and turn it into the query
 * parameters `/api/categories/:id/bookmarks` accepts.
 */
(function (root) {
  const SORT_ORDER_KEY = "xbo:sort-order";
  const SORT_DIRECTION_KEY = "xbo:sort-direction";
  // Not a preference: the last observed answer to "is anything ranked?".
  // See readScoreOrderAvailable below for why a load needs it before /api/setup.
  const SCORE_AVAILABLE_KEY = "xbo:score-orderable";
  // Recency is the default and always has been. Ranking is opt-in and paid, so
  // a library that was never ranked must open exactly as it did before.
  const DEFAULT_SORT_ORDER = "recent";
  // Descending is the default for BOTH fields - newest first, highest first -
  // which is the only ordering that existed before the direction did.
  const DEFAULT_SORT_DIRECTION = "desc";

  /**
   * The offered orders. `param` is what the API's `sort` query parameter
   * takes; `desc`/`asc` are what the direction toggle SAYS for this field,
   * because "descending" means newest for a date and highest for a score and
   * neither word belongs on a button.
   */
  const SORT_ORDERS = [
    { id: "recent", label: "Newest", param: "recent", desc: "Newest first", asc: "Oldest first" },
    { id: "score", label: "Top score", param: "score", desc: "Highest first", asc: "Lowest first" },
  ];

  /** The two directions. `param` is what the API's `dir` query parameter takes. */
  const SORT_DIRECTIONS = [
    { id: "desc", param: "desc" },
    { id: "asc", param: "asc" },
  ];

  /**
   * Shown beside the disabled "Top score" option, and as its hover title.
   * Sorting by a score nothing has is a control that silently does nothing,
   * so the option is disabled until a run has stored at least one.
   */
  const SCORE_UNAVAILABLE_MESSAGE = "No ranking yet - run Rank now to sort by score.";

  function isKnownSortOrder(id) {
    return SORT_ORDERS.some((order) => order.id === id);
  }

  function isKnownSortDirection(id) {
    return SORT_DIRECTIONS.some((direction) => direction.id === id);
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

  /**
   * The stored direction, with the same fallbacks as {@link readSortOrder}.
   */
  function readSortDirection(storage) {
    try {
      const raw = storage.getItem(SORT_DIRECTION_KEY);
      return isKnownSortDirection(raw) ? raw : DEFAULT_SORT_DIRECTION;
    } catch (_) {
      return DEFAULT_SORT_DIRECTION;
    }
  }

  /** Persist the direction; an unknown id and a throwing storage are no-ops. */
  function writeSortDirection(storage, id) {
    if (!isKnownSortDirection(id)) return;
    try {
      storage.setItem(SORT_DIRECTION_KEY, id);
    } catch (_) {
      /* private mode / blocked storage: ignore */
    }
  }

  /** The API `sort` value for an order id (the default's, if unknown). */
  function sortParam(id) {
    const match = SORT_ORDERS.find((order) => order.id === id);
    return match ? match.param : DEFAULT_SORT_ORDER;
  }

  /** The API `dir` value for a direction id (the default's, if unknown). */
  function dirParam(id) {
    return isKnownSortDirection(id) ? id : DEFAULT_SORT_DIRECTION;
  }

  /** The other direction - what the toggle switches to. */
  function flipDirection(id) {
    return dirParam(id) === "asc" ? "desc" : "asc";
  }

  /**
   * One string identifying the whole ordering, which is what the persisted
   * page snapshot (`view-persist.js`) is keyed by: a snapshot paged under one
   * ordering is worthless under any other, direction included.
   */
  function sortKey(order, direction) {
    return `${sortParam(order)}:${dirParam(direction)}`;
  }

  /**
   * What the direction toggle reads for a field+direction: "Newest first" /
   * "Oldest first" for dates, "Highest first" / "Lowest first" for scores.
   */
  function directionLabel(order, direction) {
    const match = SORT_ORDERS.find((o) => o.id === order) || SORT_ORDERS[0];
    return dirParam(direction) === "asc" ? match.asc : match.desc;
  }

  /**
   * The toggle's accessible name: the state it is in, then what pressing it
   * does. It opens with the visible label, so the name still contains it
   * (WCAG 2.5.3, Label in Name).
   */
  function directionToggleLabel(order, direction) {
    return `${directionLabel(order, direction)}. Switch to ${directionLabel(
      order,
      flipDirection(direction),
    ).toLowerCase()}.`;
  }

  /**
   * Whether "Top score" can order anything, from `/api/setup`'s `ranking`
   * block. Fails CLOSED, like `ranking.js`: no readable state means the
   * option is offered as disabled rather than as a control that quietly
   * returns the recency order under another name.
   */
  function scoreOrderAvailable(ranking) {
    return !!ranking && typeof ranking.scored === "number" && ranking.scored > 0;
  }

  /**
   * The ordering actually to be requested. A stored "score" with nothing
   * ranked resolves back to recency, so the list can never be paged under an
   * ordering whose control is disabled - and the owner's stored choice is
   * left alone, so it returns by itself after the first run.
   */
  function resolveSortOrder(id, ranking) {
    const order = isKnownSortOrder(id) ? id : DEFAULT_SORT_ORDER;
    return order === "score" && !scoreOrderAvailable(ranking) ? DEFAULT_SORT_ORDER : order;
  }

  /**
   * The last answer `/api/setup` gave to {@link scoreOrderAvailable}, kept so
   * the NEXT load can resolve the stored order before the network does
   * (issue #104).
   *
   * Without it the two halves of a reload disagree: `view-persist.js` keys its
   * page snapshot by the ordering the pages were FETCHED under, which is the
   * resolved one, while the load reads back the raw stored choice. An owner
   * whose stored "score" is not orderable therefore hydrated under
   * `score:desc` against a snapshot written as `recent:desc`, missed, and
   * re-fetched every single bookmark - on every refresh.
   *
   * This is a remembered OBSERVATION, never the owner's choice: `readSortOrder`
   * still holds that, untouched, so "Top score" returns by itself after the
   * next ranking run.
   */
  function readScoreOrderAvailable(storage) {
    try {
      return storage.getItem(SCORE_AVAILABLE_KEY) === "1";
    } catch (_) {
      return false; // fails closed, like scoreOrderAvailable itself
    }
  }

  /** Persist the observation; a throwing storage is ignored as everywhere else here. */
  function writeScoreOrderAvailable(storage, available) {
    try {
      storage.setItem(SCORE_AVAILABLE_KEY, available ? "1" : "0");
    } catch (_) {
      /* private mode / blocked storage: ignore */
    }
  }

  /**
   * The remembered observation shaped as the `ranking` block
   * {@link resolveSortOrder} takes, so a caller with no `/api/setup` answer
   * yet resolves through exactly the same rule as one that has it.
   */
  function rememberedRanking(storage) {
    return { scored: readScoreOrderAvailable(storage) ? 1 : 0 };
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
    SORT_DIRECTION_KEY,
    SCORE_AVAILABLE_KEY,
    DEFAULT_SORT_ORDER,
    DEFAULT_SORT_DIRECTION,
    SORT_ORDERS,
    SORT_DIRECTIONS,
    SCORE_UNAVAILABLE_MESSAGE,
    DIMENSIONS,
    DIMENSION_LABELS,
    isKnownSortOrder,
    isKnownSortDirection,
    readSortOrder,
    writeSortOrder,
    readSortDirection,
    writeSortDirection,
    sortParam,
    dirParam,
    flipDirection,
    sortKey,
    directionLabel,
    directionToggleLabel,
    scoreOrderAvailable,
    resolveSortOrder,
    readScoreOrderAvailable,
    writeScoreOrderAvailable,
    rememberedRanking,
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
