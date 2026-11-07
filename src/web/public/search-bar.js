"use strict";

/**
 * The pure, DOM-free half of the top-bar search (issue: "post search"):
 * header/empty/note copy, the debounce timing, and the operator reference
 * the info popover lists. `app.js` owns the DOM; `search-suggest.js` owns the
 * from:/category:/list: autocomplete. Shared the same way `sort-order.js` and
 * `post-scale.js` are, so this copy is unit-tested with nothing to stub.
 */
(function (root) {
  /** How long a keystroke waits before the live search re-fires (ms). */
  const DEBOUNCE_MS = 300;

  /** `singular`/`plural` wording so "1 result" never reads as "1 results". */
  function pluralize(n, singular, plural) {
    return n === 1 ? singular : plural;
  }

  /**
   * The results header: "N results for <query>" - or "N results" alone when
   * the bar is empty. The query is shown EXACTLY as typed, with no quote
   * marks of our own added around it - a `"phrase"` or a `from:"Name"` value
   * already carries its own quotes, and wrapping those again would double
   * them up into a visibly broken `""phrase""`.
   */
  function headerText(total, query) {
    const n = Math.max(0, Math.floor(total || 0));
    const noun = pluralize(n, "result", "results");
    const trimmed = (query || "").trim();
    return trimmed ? `${n} ${noun} for ${trimmed}` : `${n} ${noun}`;
  }

  /** The empty state's message, mirroring {@link headerText}'s wording. */
  function emptyMessage(query) {
    const trimmed = (query || "").trim();
    return trimmed ? `No results for ${trimmed}.` : "No results.";
  }

  /** Said out loud when the engine fell back to ANY term instead of every one - mirrors the MCP tool's note. */
  const ANY_MODE_NOTE = "No post matched every word; these match some of them.";

  /**
   * One row per operator for the info popover: the syntax, a short example,
   * and (only on the first row, where it reads as a scope statement for the
   * whole bar) what the search actually looks inside.
   */
  const HELP_OPERATORS = [
    {
      op: "keywords",
      example: "agent harness",
      detail: "Matches post text, quoted posts, linked articles, summaries, and text read from images.",
    },
    { op: '"exact phrase"', example: '"prompt caching"', detail: "Matches that exact phrase." },
    { op: "-word", example: "-sourdough", detail: "Excludes posts matching that word or phrase." },
    { op: "from:@user", example: "from:@karpathy", detail: "Only that account's own posts (not a mention or a quote)." },
    { op: "category:Name", example: 'category:"AI > Agents"', detail: "Only that category and its sub-categories." },
    { op: "list:Name", example: 'list:"Read later"', detail: "Only that assistant result list." },
    { op: "since: / until:", example: "since:2024-01-01", detail: "Bounds the post's own date (YYYY-MM-DD)." },
  ];

  const api = {
    DEBOUNCE_MS,
    headerText,
    emptyMessage,
    ANY_MODE_NOTE,
    HELP_OPERATORS,
  };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.XBOSearchBar = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
