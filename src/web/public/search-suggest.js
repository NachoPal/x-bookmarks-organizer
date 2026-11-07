"use strict";

/**
 * Autocomplete for the search bar's from:/category:/list: operators - pure
 * and DOM-free, like `category-picker.js`. `app.js` drives an input element
 * with this; it only ever reads the text and the caret position and returns
 * where to splice a suggestion back in.
 *
 * Detecting the "active" operator is a small, deliberately approximate
 * client-side mirror of the server's `parseSearchQuery` token regex
 * (`src/search/query.ts`) - good enough for "what is the owner typing right
 * now", not a full re-parse. It does not understand being inside an
 * unrelated quoted phrase that happens to contain the word "from:"; that is
 * a cosmetic false positive (a suggestion list appears that the owner can
 * ignore), never a wrong search - the actual query still goes through the
 * real parser server-side.
 */
(function (root) {
  const TOKEN_RE = /(from|category|list):("?)([^"]*)$/i;

  /**
   * The from:/category:/list: token the caret is currently inside (typing
   * its value), or null when the caret is elsewhere (free text, or past a
   * token's closing quote/space). `start`/`end` bound the span to replace
   * when a suggestion is applied.
   */
  function activeToken(value, caretPos) {
    const before = value.slice(0, Math.max(0, caretPos));
    const m = TOKEN_RE.exec(before);
    if (!m) return null;
    const kind = m[1].toLowerCase();
    const quoted = m[2] === '"';
    const prefix = m[3];
    // An unquoted value stops at whitespace - if the fragment up to the
    // caret already contains one, the caret is past this operator, typing a
    // later, unrelated word.
    if (!quoted && /\s/.test(prefix)) return null;
    return { kind, quoted, prefix, start: m.index, end: caretPos };
  }

  /**
   * `candidates` narrowed to `prefix` (case-insensitive): a "starts with"
   * match ranks above a mere "contains" one, each group keeping the
   * candidates' own order. An empty prefix returns the first `max` as-is -
   * a useful default list the moment the owner types the operator's colon.
   */
  function filterSuggestions(candidates, prefix, max) {
    const limit = max || 8;
    const needle = (prefix || "").toLowerCase();
    if (!needle) return (candidates || []).slice(0, limit);
    const starts = [];
    const contains = [];
    for (const c of candidates || []) {
      const low = String(c).toLowerCase();
      if (low.startsWith(needle)) starts.push(c);
      else if (low.includes(needle)) contains.push(c);
    }
    return [...starts, ...contains].slice(0, limit);
  }

  /**
   * Splice `suggestion` into `value` in place of the active token's typed
   * value, quoting it when it has a space (category/list names can; a
   * username never does, so `from:` always gets a bare `@user`). Always
   * leaves exactly one trailing space, so the owner can keep typing right
   * away, and returns where the caret belongs.
   */
  function applySuggestion(value, token, suggestion) {
    const text =
      token.kind === "from"
        ? `@${String(suggestion).replace(/^@/, "")}`
        : /\s/.test(suggestion)
          ? `"${suggestion}"`
          : suggestion;
    const replacement = `${token.kind}:${text}`;
    const before = value.slice(0, token.start);
    const after = value.slice(token.end).replace(/^\s+/, "");
    const newValue = `${before}${replacement} ${after}`;
    return { value: newValue, caret: (before + replacement + " ").length };
  }

  const api = { activeToken, filterSuggestions, applySuggestion };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.XBOSearchSuggest = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
