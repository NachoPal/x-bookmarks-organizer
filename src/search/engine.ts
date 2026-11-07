import { buildCategoryTree } from '../categorize/tree';
import { resolveCategoryRef } from '../categorize/category-ref';
import type { BookmarkFilter, BookmarkSearchResult, BookmarkSearchSortOrder, BookmarkSortDirection, Database } from '../db/database';
import { joinSearchTerms, parseSearchQuery, type ParsedSearchQuery } from './query';

/**
 * One place that turns a search bar's raw text (or an MCP `search_bookmarks`
 * query carrying the same syntax) into an actual `Database.searchBookmarks`
 * call: parses the operators, resolves `category:`/`list:` NAMES against the
 * live tree and the live assistant lists, and reports an unknown name the
 * way `ToolInputError`/the API's 400 can both show as-is.
 */
export class SearchQueryError extends Error {}

export interface RunSearchOptions {
  /** The bar's raw text: keywords plus from:/category:/list:/since:/until:/-exclusion. */
  raw: string;
  /**
   * A category id or name to ALSO narrow to, OR'd in with any `category:`
   * tokens already in `raw` - the MCP tool's pre-existing `category` arg,
   * kept so an existing caller is unaffected by the new syntax.
   */
  categoryRef?: string | number;
  /** ISO bounds that take precedence over a parsed `since:`/`until:` - the MCP tool's pre-existing `after`/`before` args. */
  after?: string;
  before?: string;
  filter?: BookmarkFilter;
  sort?: BookmarkSearchSortOrder;
  dir?: BookmarkSortDirection;
  rubricVersion?: string;
  limit: number;
  offset?: number;
}

export interface SearchEngineResult extends BookmarkSearchResult {
  /** What the raw text parsed to, for a caller that wants to label or echo it back. */
  parsed: ParsedSearchQuery;
}

/** `2024-05-01` -> the ISO instant to compare `post_created_at` against (start, or the day after for an exclusive end). */
function dayBoundIso(value: string, endOfDay: boolean): string {
  const day = new Date(`${value}T00:00:00.000Z`);
  if (endOfDay) day.setUTCDate(day.getUTCDate() + 1);
  return day.toISOString();
}

export function runSearch(db: Database, opts: RunSearchOptions): SearchEngineResult {
  const parsed = parseSearchQuery(opts.raw);
  const tree = buildCategoryTree(db);

  const categoryRefs: (string | number)[] = [...parsed.category];
  if (opts.categoryRef !== undefined) categoryRefs.push(opts.categoryRef);
  const categoryIds: number[] = [];
  for (const ref of categoryRefs) {
    try {
      categoryIds.push(resolveCategoryRef(tree, ref).id);
    } catch (e) {
      throw new SearchQueryError((e as Error).message);
    }
  }

  const listIds: number[] = [];
  if (parsed.list.length > 0) {
    const lists = db.getAssistantLists();
    for (const name of parsed.list) {
      const matches = lists.filter((l) => l.title.toLowerCase() === name.toLowerCase());
      if (matches.length === 0) throw new SearchQueryError(`No list matches "${name}".`);
      listIds.push(...matches.map((l) => l.id));
    }
  }

  const postedFrom = opts.after ?? (parsed.since ? dayBoundIso(parsed.since, false) : undefined);
  const postedBefore = opts.before ?? (parsed.until ? dayBoundIso(parsed.until, true) : undefined);

  const result = db.searchBookmarks({
    query: parsed.terms.length > 0 ? joinSearchTerms(parsed.terms) : undefined,
    excludeQuery: parsed.excludeTerms.length > 0 ? joinSearchTerms(parsed.excludeTerms) : undefined,
    categoryIds: categoryIds.length > 0 ? categoryIds : undefined,
    listIds: listIds.length > 0 ? listIds : undefined,
    authors: parsed.from.length > 0 ? parsed.from : undefined,
    postedFrom,
    postedBefore,
    filter: opts.filter,
    sort: opts.sort,
    dir: opts.dir,
    rubricVersion: opts.rubricVersion,
    limit: opts.limit,
    offset: opts.offset,
  });

  return { ...result, parsed };
}
