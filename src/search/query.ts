/**
 * The X/Twitter-style search syntax typed into the app's search bar (and
 * accepted by the MCP `search_bookmarks` tool, so an assistant gets the same
 * operators): plain words and `"phrases"` match any post (AND, with the
 * usual any-term fallback - see `src/db/search.ts`); `-word`/`-"phrase"`
 * excludes; `from:@user` narrows to that account's own posts; `category:`
 * and `list:` narrow to a category (and its subcategories) or an assistant
 * list; `since:`/`until:` bound the post's own date.
 *
 * This module is PURE - no DB, no network - so it is unit-testable on its
 * own. Resolving a `category:`/`list:` NAME into an id (and reporting an
 * unknown one) is a separate concern that needs the library's tree/lists and
 * lives in `src/search/engine.ts`; this module only extracts what the owner
 * typed.
 */

export interface ParsedSearchQuery {
  /** Free words/phrases that must ALL match (AND), FTS5-quoted by the caller. */
  terms: string[];
  /** Free words/phrases that must NOT match (OR among them). */
  excludeTerms: string[];
  /** `from:` values, lowercased and without a leading `@` (OR among them). */
  from: string[];
  /** `category:` values, exactly as typed (trimmed); OR among them. */
  category: string[];
  /** `list:` values, exactly as typed (trimmed); OR among them. */
  list: string[];
  /** `since:` value, `YYYY-MM-DD`, when present and well-formed. */
  since?: string;
  /** `until:` value, `YYYY-MM-DD`, when present and well-formed. */
  until?: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** `2024-05-01` and a real calendar date - rejects a well-formed but impossible one like `2024-13-99`. */
function isValidDateString(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * One token at a time: an operator (`from:`/`category:`/`list:`/`since:`/`until:`,
 * its value either a `"quoted"` chunk or a bare run of non-space characters),
 * else a `-"negated phrase"`, a `"phrase"`, a `-negated` word, or a bare word.
 * Order is the alternation order - FIRST match wins at each position - so the
 * operator form must be tried before the generic negated/bare-word forms, or
 * `from:@x` would just read as the word "from:@x".
 */
const TOKEN_RE = /(from|category|list|since|until):(?:"([^"]*)"|(\S*))|-"([^"]*)"|"([^"]*)"|-(\S+)|(\S+)/g;

/**
 * Parse a search bar's raw text into its structured operators plus whatever
 * free text is left. Never throws: a malformed or empty operator value (an
 * unparseable `since:`, a bare `from:` with nothing after the colon) is
 * dropped rather than failing the whole query, since this also runs on every
 * keystroke of a live search.
 */
export function parseSearchQuery(raw: string): ParsedSearchQuery {
  const result: ParsedSearchQuery = { terms: [], excludeTerms: [], from: [], category: [], list: [] };
  for (const m of raw.matchAll(TOKEN_RE)) {
    const [, keyword, quotedValue, bareValue, negatedPhrase, phrase, negatedWord, word] = m;
    if (keyword !== undefined) {
      const value = (quotedValue ?? bareValue ?? '').trim();
      if (!value) continue;
      switch (keyword) {
        case 'from':
          result.from.push(value.replace(/^@/, '').toLowerCase());
          break;
        case 'category':
          result.category.push(value);
          break;
        case 'list':
          result.list.push(value);
          break;
        case 'since':
          if (isValidDateString(value)) result.since = value;
          break;
        case 'until':
          if (isValidDateString(value)) result.until = value;
          break;
      }
      continue;
    }
    if (negatedPhrase !== undefined) {
      if (negatedPhrase.trim()) result.excludeTerms.push(negatedPhrase);
      continue;
    }
    if (phrase !== undefined) {
      if (phrase.trim()) result.terms.push(phrase);
      continue;
    }
    if (negatedWord !== undefined) {
      result.excludeTerms.push(negatedWord);
      continue;
    }
    if (word !== undefined) {
      result.terms.push(word);
    }
  }
  return result;
}

/**
 * Re-quote a parsed query's `terms`/`excludeTerms` back into the raw-text
 * shape `buildMatchQuery` (`src/db/search.ts`) already knows how to turn
 * into a safe FTS5 expression - a multi-word atom (a phrase the owner typed
 * in quotes) is wrapped back in quotes so it survives as one phrase; a single
 * word is left bare. Exported so the engine and its tests never have to
 * restate this join.
 */
export function joinSearchTerms(atoms: string[]): string {
  return atoms.map((t) => (t.includes(' ') ? `"${t}"` : t)).join(' ');
}
