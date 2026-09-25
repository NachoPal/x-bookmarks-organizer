import fs from 'node:fs';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import {
  ARTICLE_LINK_METADATA_ADDED_COLUMNS,
  ARTICLES_ADDED_COLUMNS,
  ASSISTANT_LISTS_ADDED_COLUMNS,
  BOOKMARK_SCORES_REKEY_SQL,
  BOOKMARKS_ADDED_COLUMNS,
  CATEGORIES_ADDED_COLUMNS,
  SCHEMA_SQL,
} from './schema';
import {
  buildMatchQuery,
  dropSearchSchemaSql,
  POPULATE_SEARCH_SQL,
  SEARCH_INDEX_VERSION,
  SEARCH_INDEX_VERSION_KEY,
  SEARCH_SCHEMA_SQL,
  SEARCH_WEIGHTS,
} from './search';
import { htmlToPlainText } from '../summarize/summarizer';
import type {
  ArticleLinkMetadata,
  ArticleRecord,
  BookmarkScoreRecord,
  CategoryNode,
  CategoryOrigin,
  QuotedPost,
  RawBookmark,
  StoredBookmark,
  SummaryRecord,
  XArticle,
} from '../types';

/**
 * The viewer's tab filter for a paged bookmark list: the three read-state
 * tabs plus the owner's starred set (issue #63).
 */
export type BookmarkFilter = 'all' | 'unread' | 'read' | 'favorite';

/**
 * Rolled-up counts for a category subtree, one per tab that needs a total
 * (`all` uses `total`). Returned by
 * {@link Database.getCategoryBookmarkCounts}.
 */
export interface CategoryBookmarkCounts {
  total: number;
  unread: number;
  favorite: number;
}

/**
 * What deleting a category would remove (issue #101), as computed by
 * {@link Database.planCategoryDeletion} and carried out by
 * {@link Database.deleteCategory}.
 */
export interface CategoryDeletionPlan {
  /** Every category row the delete removes: the target plus its descendants. */
  categoryIds: number[];
  /** Descendants only - what the confirmation calls "sub-categories". */
  subcategoryCount: number;
  /**
   * The bookmarks the delete PERMANENTLY removes: those filed inside the
   * subtree and nowhere else. A bookmark also filed under a surviving
   * category is kept and only unlinked.
   */
  orphanedBookmarkIds: number[];
}

/** The same plan as counts, which is what the route and the dialog speak in. */
export interface CategoryDeletionCounts {
  /** Category rows removed, including the one the owner pressed the bin on. */
  categories: number;
  /** Of those, the descendants. */
  subcategories: number;
  /** Bookmarks permanently deleted (and tombstoned) as orphans. */
  posts: number;
}

/**
 * WHAT a paged bookmark list is ordered by.
 *
 * `recent` is the default everywhere and is what the viewer has always done.
 * `score` orders by the opt-in ranking pass's stored score (issue #62); a
 * bookmark with no score row sorts LAST rather than as a zero, because "never
 * ranked" is not the same claim as "ranked worthless". Both orders break ties
 * on the original recency ordering, so paging is stable.
 */
export type BookmarkSortOrder = 'recent' | 'score';

/**
 * WHICH WAY that field runs (issue #97).
 *
 * `desc` is the default for both fields and is what the viewer has always
 * done: newest first for `recent`, highest first for `score`. `asc` flips it
 * to oldest first / lowest first.
 *
 * The direction applies to the FIELD only. Under `score` the "unranked sorts
 * last" rule is direction-independent - an absent score means never ranked,
 * which is not a low score, so it must not float to the top when the owner
 * asks for the lowest scores first.
 */
export type BookmarkSortDirection = 'asc' | 'desc';

/** Paging + filtering options for {@link Database.getBookmarksForCategory}. */
export interface BookmarkPageOptions {
  filter?: BookmarkFilter;
  sort?: BookmarkSortOrder;
  dir?: BookmarkSortDirection;
  offset?: number;
  limit?: number;
  /**
   * Which rubric's scores `sort: 'score'` orders by - the ACTIVE preset's
   * version (issue #102). Omitted, any stored score counts, which is only
   * right for a caller with no notion of an active preset (a test, a one-off
   * script). A viewer that left this out would sort one preset's list by
   * another preset's verdicts.
   */
  rubricVersion?: string;
}

/**
 * Ordering for {@link Database.getAssistantListBookmarks}: the category
 * orders plus `list`, the order the assistant sent (the default).
 */
export interface AssistantListSortOptions {
  sort?: BookmarkSortOrder | 'list';
  dir?: BookmarkSortDirection;
  /** As {@link BookmarkPageOptions.rubricVersion}. */
  rubricVersion?: string;
}

/** Options for {@link Database.searchBookmarks}. Every filter is optional and they combine with AND. */
export interface BookmarkSearchOptions {
  /** Free text; see `buildMatchQuery`. Omitted or empty lists the filtered set, newest post first. */
  query?: string;
  /** Only bookmarks filed in this category or any of its descendants. */
  categoryId?: number;
  /** Only posts created at or after this ISO date/time (compared against `post_created_at`). */
  postedFrom?: string;
  /** Only posts created strictly before this ISO date/time. */
  postedBefore?: string;
  filter?: BookmarkFilter;
  limit: number;
  offset?: number;
}

/** One search result: the bookmark and, for a text query, the best-matching excerpt. */
export interface BookmarkSearchHit {
  bookmark: StoredBookmark;
  /** The matching passage with terms wrapped in `«»`; null when there was no text query. */
  snippet: string | null;
}

export interface BookmarkSearchResult {
  /** How many bookmarks match in total (not just this page). */
  total: number;
  /**
   * `all` - every term matched; `any` - no bookmark had every term, so these
   * match at least one (ranked by relevance); `none` - there was no text query.
   */
  mode: 'all' | 'any' | 'none';
  hits: BookmarkSearchHit[];
}

/**
 * A result list an AI assistant sent through the MCP tool `show_in_app`: a
 * named view of bookmarks, never a filing. `count` is how many of its posts
 * still exist (deleting a post takes it out of every list).
 */
export interface AssistantList {
  id: number;
  title: string;
  note: string | null;
  createdAt: string;
  count: number;
  /**
   * How many of those posts are unread. Read state is per BOOKMARK, so this is
   * the same flag a category's count reads - the two can never disagree.
   */
  unread: number;
  /** Whether the owner has opened it in the viewer yet (`assistant_lists.viewed_at`). */
  viewed: boolean;
}

/** Library-wide counts for the MCP server's `library_stats`. */
export interface LibraryStats {
  bookmarks: number;
  unread: number;
  favorites: number;
  withSummary: number;
  categories: number;
  oldestPostAt: string | null;
  newestPostAt: string | null;
}

const ASSISTANT_LIST_SELECT = `SELECT l.id, l.title, l.note, l.created_at, l.viewed_at,
       (SELECT COUNT(*) FROM assistant_list_items i WHERE i.list_id = l.id) AS count,
       (SELECT COUNT(*) FROM assistant_list_items i JOIN bookmarks b ON b.id = i.bookmark_id
         WHERE i.list_id = l.id AND b.read = 0) AS unread
  FROM assistant_lists l`;

interface AssistantListRow {
  id: number;
  title: string;
  note: string | null;
  created_at: string;
  viewed_at: string | null;
  count: number;
  unread: number;
}

function toAssistantList(r: AssistantListRow): AssistantList {
  return { id: r.id, title: r.title, note: r.note, createdAt: r.created_at, count: r.count, unread: r.unread, viewed: r.viewed_at !== null };
}

interface BookmarkRow {
  id: number;
  post_id: string;
  author_username: string;
  author_name: string;
  text: string;
  url: string;
  post_created_at: string;
  ingested_at: string;
  read: number;
  read_at: string | null;
  favorite?: number;
  quoted_post_id?: string | null;
}

interface CategoryRow {
  id: number;
  parent_id: number | null;
  name: string;
  /** Absent on a row written before the column existed - see `CATEGORIES_ADDED_COLUMNS`. */
  description?: string | null;
  created_at: string;
  origin?: string | null;
  /** Absent on a row written before the column existed. */
  position?: number | null;
}

interface ArticleRow {
  bookmark_id: number;
  url: string;
  status: string;
  title: string | null;
  content_html: string | null;
  excerpt: string | null;
  site_name: string | null;
  reason: string | null;
  fetched_at: string;
}

function toStoredBookmark(row: BookmarkRow): StoredBookmark {
  return {
    id: row.id,
    postId: row.post_id,
    authorUsername: row.author_username,
    authorName: row.author_name,
    text: row.text,
    url: row.url,
    postCreatedAt: row.post_created_at,
    ingestedAt: row.ingested_at,
    read: row.read === 1,
    readAt: row.read_at,
    favorite: row.favorite === 1,
    quotedPostId: row.quoted_post_id ?? null,
  };
}

interface XArticleRow {
  post_id: string;
  rest_id: string | null;
  title: string | null;
  preview_text: string | null;
  plain_text: string | null;
  cover_url: string | null;
  cover_w: number | null;
  cover_h: number | null;
  fetched_at: string;
}

function toXArticle(row: XArticleRow): XArticle {
  return {
    restId: row.rest_id,
    title: row.title,
    previewText: row.preview_text,
    plainText: row.plain_text,
    coverUrl: row.cover_url,
    coverWidth: row.cover_w,
    coverHeight: row.cover_h,
  };
}

/**
 * The X Article a bookmark shows: the one it hosts itself, else the one hosted
 * by the post it quotes (`quoted: true`).
 */
export interface BookmarkXArticle {
  article: XArticle;
  /** The post id whose row this is - the bookmark's own, or the quoted post's. */
  postId: string;
  quoted: boolean;
}

interface QuotedPostRow {
  post_id: string;
  author_username: string;
  author_name: string;
  text: string;
  created_at: string;
  fetched_at: string;
}

function toQuotedPost(row: QuotedPostRow): QuotedPost {
  return {
    postId: row.post_id,
    authorUsername: row.author_username,
    authorName: row.author_name,
    text: row.text,
    createdAt: row.created_at,
  };
}

function toCategoryNode(row: CategoryRow): CategoryNode {
  return {
    id: row.id,
    parentId: row.parent_id,
    name: row.name,
    origin: row.origin === 'user' ? 'user' : 'generated',
    description: row.description ?? null,
    position: row.position ?? null,
    createdAt: row.created_at,
  };
}

interface SummaryRow {
  bookmark_id: number;
  summary: string;
  generated_at: string;
}

function toSummaryRecord(row: SummaryRow): SummaryRecord {
  return { bookmarkId: row.bookmark_id, summary: row.summary, generatedAt: row.generated_at };
}

interface BookmarkScoreRow {
  bookmark_id: number;
  score: number;
  confidence: number;
  dimensions: string;
  model: string;
  rubric_version: string;
  scored_at: string;
}

/**
 * Read a stored ranking row back. `dimensions` is JSON in a TEXT column so the
 * rubric can gain or drop a dimension without a migration; a row written by a
 * different rubric therefore has to be read tolerantly - anything that is not
 * a plain object of finite numbers degrades to no dimensions rather than
 * throwing and taking the whole bookmark list down with it.
 */
function toBookmarkScoreRecord(row: BookmarkScoreRow): BookmarkScoreRecord {
  return {
    bookmarkId: row.bookmark_id,
    score: row.score,
    confidence: row.confidence,
    dimensions: parseDimensions(row.dimensions),
    model: row.model,
    rubricVersion: row.rubric_version,
    scoredAt: row.scored_at,
  };
}

function parseDimensions(raw: string): Record<string, number> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

interface ArticleLinkMetadataRow {
  url: string;
  status: string;
  title: string | null;
  description: string | null;
  image: string | null;
  site_name: string | null;
  resolved_url: string | null;
  fetched_at: string;
}

function toArticleLinkMetadata(row: ArticleLinkMetadataRow): ArticleLinkMetadata {
  return {
    url: row.url,
    status: row.status === 'ok' ? 'ok' : row.status === 'card' ? 'card' : 'failed',
    title: row.title,
    description: row.description,
    image: row.image,
    siteName: row.site_name,
    resolvedUrl: row.resolved_url ?? null,
    fetchedAt: row.fetched_at,
  };
}

function toArticleRecord(row: ArticleRow): ArticleRecord {
  return {
    bookmarkId: row.bookmark_id,
    url: row.url,
    status: row.status === 'ok' ? 'ok' : 'failed',
    title: row.title,
    contentHtml: row.content_html,
    excerpt: row.excerpt,
    siteName: row.site_name,
    reason: row.reason,
    fetchedAt: row.fetched_at,
  };
}

const MARKER_KEY = 'newest_seen_post_id';
const REFRESH_TOKEN_KEY = 'x_refresh_token';
const LAST_SYNCED_AT_KEY = 'last_synced_at';

/**
 * The only `run_state` keys {@link Database.resetLibrary} removes: the
 * per-library sync state, which is meaningless once the bookmarks are gone.
 * Everything else in `run_state` is the owner's configuration and survives.
 */
const RESET_CLEARED_STATE_KEYS = [MARKER_KEY, LAST_SYNCED_AT_KEY];

/**
 * Make the database file owner-only (security review finding 7).
 *
 * It holds the long-lived X OAuth refresh token as a plain `run_state` row
 * alongside every bookmark the owner has saved, so it is a secret of the same
 * class as `credentials.json` - which the credential chain already writes
 * `0600` and refuses to read when it is looser (`src/creds/resolve.ts`). Left
 * at the default umask it is created world-readable.
 *
 * Best-effort on purpose: file modes are meaningless on Windows, and a
 * database on a filesystem that cannot represent them must still open.
 */
function restrictToOwner(dbPath: string): void {
  try {
    fs.chmodSync(dbPath, 0o600);
  } catch {
    // Nothing actionable: the database is open and usable either way.
  }
}

/**
 * Thin, well-typed wrapper over the SQLite database.
 *
 * All writes that must be atomic (e.g. storing a categorized batch) are exposed
 * as single methods that run inside a transaction, so an interrupted run never
 * leaves a bookmark stored-but-uncategorized.
 */
export class Database {
  private readonly db: BetterSqlite3.Database;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    }
    this.db = new BetterSqlite3(dbPath);
    if (dbPath !== ':memory:') restrictToOwner(dbPath);
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA_SQL);
    this.migrate();
  }

  /**
   * Add columns introduced after a table's original release, for a database
   * that predates them. `CREATE TABLE IF NOT EXISTS` above only shapes a
   * brand-new table; an already-existing one keeps its original columns until
   * migrated here. Idempotent via `PRAGMA table_info`, so re-opening an
   * already-migrated database is a no-op.
   */
  private migrate(): void {
    this.addMissingColumns('article_link_metadata', ARTICLE_LINK_METADATA_ADDED_COLUMNS);
    this.addMissingColumns('bookmarks', BOOKMARKS_ADDED_COLUMNS);
    this.addMissingColumns('categories', CATEGORIES_ADDED_COLUMNS);
    this.addMissingColumns('articles', ARTICLES_ADDED_COLUMNS);
    if (this.addMissingColumns('assistant_lists', ASSISTANT_LISTS_ADDED_COLUMNS).includes('viewed_at')) {
      this.db.prepare('UPDATE assistant_lists SET viewed_at = created_at').run();
    }
    this.rekeyBookmarkScores();
    this.backfillArticleText();
    this.ensureSearchIndex();
  }

  /**
   * Give every cached article body its plain-text twin (`content_text`),
   * which the search index reads. Only rows cached before the column existed
   * lack it, so this is a no-op on every later open.
   */
  private backfillArticleText(): void {
    const rows = this.db
      .prepare('SELECT bookmark_id, content_html FROM articles WHERE content_text IS NULL AND content_html IS NOT NULL')
      .all() as { bookmark_id: number; content_html: string }[];
    if (rows.length === 0) return;
    const update = this.db.prepare('UPDATE articles SET content_text = ? WHERE bookmark_id = ?');
    this.db.transaction(() => {
      for (const row of rows) update.run(htmlToPlainText(row.content_html), row.bookmark_id);
    })();
  }

  /**
   * Create the full-text index and its triggers (`src/db/search.ts`), and
   * (re)build it from scratch when it was built under another version or
   * never - which is how a library that predates search gains it. Otherwise a
   * no-op: the triggers keep it current from then on.
   */
  private ensureSearchIndex(): void {
    const exists = !!this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'bookmark_fts'")
      .get();
    if (exists && this.getState(SEARCH_INDEX_VERSION_KEY) === SEARCH_INDEX_VERSION) {
      this.db.exec(SEARCH_SCHEMA_SQL);
      return;
    }
    const triggers = (
      this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as { name: string }[]
    ).map((t) => t.name);
    this.db.transaction(() => {
      this.db.exec(dropSearchSchemaSql(triggers));
      this.db.exec(SEARCH_SCHEMA_SQL);
      this.db.exec(POPULATE_SEARCH_SQL);
      this.setState(SEARCH_INDEX_VERSION_KEY, SEARCH_INDEX_VERSION);
    })();
  }

  /**
   * Widen `bookmark_scores`' primary key to `(bookmark_id, rubric_version)` on
   * a database that predates rubric presets (issue #102). Lossless - every
   * existing row is copied, so a library already ranked keeps its verdicts and
   * is not re-billed - and a no-op once done.
   *
   * Foreign keys are switched OFF around the rebuild, which is SQLite's own
   * documented procedure for a table recreation: the DROP would otherwise be
   * evaluated against the child rows that are about to be re-parented. The
   * pragma cannot be changed inside a transaction, so it brackets it.
   */
  private rekeyBookmarkScores(): void {
    const columns = this.db.prepare('PRAGMA table_info(bookmark_scores)').all() as {
      name: string;
      pk: number;
    }[];
    const version = columns.find((c) => c.name === 'rubric_version');
    if (!version || version.pk !== 0) return;

    this.db.pragma('foreign_keys = OFF');
    try {
      this.db.exec(`BEGIN; ${BOOKMARK_SCORES_REKEY_SQL} COMMIT;`);
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    } finally {
      this.db.pragma('foreign_keys = ON');
    }
  }

  /** Returns the names of the columns it had to add. */
  private addMissingColumns(table: string, columns: { name: string; ddl: string }[]): string[] {
    const existing = new Set(
      (this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name),
    );
    const added: string[] = [];
    for (const { name, ddl } of columns) {
      if (existing.has(name)) continue;
      this.db.exec(ddl);
      added.push(name);
    }
    return added;
  }

  close(): void {
    this.db.close();
  }

  // --- Bookmarks ---------------------------------------------------------

  /**
   * Post ids already stored, UNION permanently-deleted post ids. Used as the
   * incremental "already seen" signal so a deleted bookmark is never
   * re-fetched and re-stored by a later sync.
   */
  getKnownPostIds(): Set<string> {
    const rows = this.db
      .prepare('SELECT post_id FROM bookmarks UNION SELECT post_id FROM deleted_bookmarks')
      .all() as { post_id: string }[];
    return new Set(rows.map((r) => r.post_id));
  }

  getBookmarkByPostId(postId: string): StoredBookmark | undefined {
    const row = this.db.prepare('SELECT * FROM bookmarks WHERE post_id = ?').get(postId) as
      | BookmarkRow
      | undefined;
    return row ? toStoredBookmark(row) : undefined;
  }

  /** All stored bookmarks, newest-ingested first. Used by re-categorization. */
  getAllBookmarks(): StoredBookmark[] {
    const rows = this.db
      .prepare('SELECT * FROM bookmarks ORDER BY ingested_at DESC, id DESC')
      .all() as BookmarkRow[];
    return rows.map(toStoredBookmark);
  }

  /** Total number of stored bookmarks, for paging the bulk content endpoint. */
  getBookmarkCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM bookmarks').get() as { n: number }).n;
  }

  /** One page of ALL stored bookmarks, newest-ingested first. Used by the bulk content endpoint. */
  getBookmarksPage(offset: number, limit: number): StoredBookmark[] {
    const rows = this.db
      .prepare('SELECT * FROM bookmarks ORDER BY ingested_at DESC, id DESC LIMIT ? OFFSET ?')
      .all(limit, offset) as BookmarkRow[];
    return rows.map(toStoredBookmark);
  }

  getBookmarkById(id: number): StoredBookmark | undefined {
    const row = this.db.prepare('SELECT * FROM bookmarks WHERE id = ?').get(id) as
      | BookmarkRow
      | undefined;
    return row ? toStoredBookmark(row) : undefined;
  }

  /**
   * Bookmarks filed at a category node OR any of its descendants, deduplicated
   * by bookmark id and newest-ingested first. Multi-category safe: a bookmark
   * linked to several nodes in the subtree appears once.
   *
   * With no options the whole subtree is returned (used by ingestion/tests).
   * The viewer passes {@link opts} to page the read-state-filtered set so a
   * large category is never shipped to the client all at once.
   */
  getBookmarksForCategory(categoryId: number, opts: BookmarkPageOptions = {}): StoredBookmark[] {
    const where: string[] = [
      `b.id IN (
         SELECT bc.bookmark_id FROM bookmark_categories bc
         JOIN subtree s ON s.id = bc.category_id
       )`,
    ];
    if (opts.filter === 'unread') where.push('b.read = 0');
    else if (opts.filter === 'read') where.push('b.read = 1');
    else if (opts.filter === 'favorite') where.push('b.favorite = 1');

    // Sorting by score is a LEFT JOIN, not an inner one: an unranked bookmark
    // must still appear in the list, just after every ranked one.
    const scored = opts.sort === 'score';
    const asc = opts.dir === 'asc';
    // `sc.score IS NULL` is 0 for a ranked row and 1 for an unranked one, and
    // it is sorted ASCENDING in BOTH directions - which is what keeps the
    // never-ranked bookmarks last whether the owner asked for the highest
    // scores or the lowest (issue #97). Only the score itself flips.
    const scoreKeys = scored ? `sc.score IS NULL, sc.score ${asc ? 'ASC' : 'DESC'}, ` : '';
    // The join is scoped to ONE rubric, in the join condition rather than in
    // WHERE, so a bookmark scored only under some other preset stays in the
    // list and sorts as unranked - which is what it is, under these rules.
    const scoreJoin = scored
      ? `LEFT JOIN bookmark_scores sc ON sc.bookmark_id = b.id${
          opts.rubricVersion ? ' AND sc.rubric_version = ?' : ''
        }`
      : '';
    // Recency is the ordering under `recent` (so it flips with the direction)
    // and only the tie-break under `score` (where it stays newest-first, so
    // two equally-scored posts keep one stable, familiar sequence).
    const recency = scored || !asc ? 'b.ingested_at DESC, b.id DESC' : 'b.ingested_at ASC, b.id ASC';
    let sql = `WITH RECURSIVE subtree(id) AS (
         SELECT ?
         UNION
         SELECT c.id FROM categories c JOIN subtree s ON c.parent_id = s.id
       )
       SELECT b.* FROM bookmarks b
       ${scoreJoin}
       WHERE ${where.join(' AND ')}
       ORDER BY ${scoreKeys}${recency}`;
    // Parameter order follows the STATEMENT, not the call: the join's version
    // is bound after the CTE's category id and before the page window.
    const params: (number | string)[] = [categoryId];
    if (scored && opts.rubricVersion) params.push(opts.rubricVersion);
    if (opts.limit != null) {
      sql += ' LIMIT ? OFFSET ?';
      params.push(opts.limit, opts.offset ?? 0);
    }
    const rows = this.db.prepare(sql).all(...params) as BookmarkRow[];
    return rows.map(toStoredBookmark);
  }

  /**
   * Full-text search over the library (`src/db/search.ts`), narrowed by
   * category subtree, post date and read/favorite state.
   *
   * A text query first requires EVERY term; only when nothing matches all of
   * them does it fall back to ANY term, ranked by relevance - which is what a
   * question phrased in several words usually needs, without drowning a
   * precise one in partial matches.
   */
  searchBookmarks(opts: BookmarkSearchOptions): BookmarkSearchResult {
    const where: string[] = [];
    const params: (string | number)[] = [];
    let cte = '';
    if (opts.categoryId !== undefined) {
      cte = `WITH RECURSIVE subtree(id) AS (
          SELECT ? UNION SELECT c.id FROM categories c JOIN subtree s ON c.parent_id = s.id
        ) `;
      params.push(opts.categoryId);
      where.push('b.id IN (SELECT bc.bookmark_id FROM bookmark_categories bc JOIN subtree s ON s.id = bc.category_id)');
    }
    if (opts.postedFrom) {
      where.push("b.post_created_at <> '' AND b.post_created_at >= ?");
      params.push(opts.postedFrom);
    }
    if (opts.postedBefore) {
      where.push("b.post_created_at <> '' AND b.post_created_at < ?");
      params.push(opts.postedBefore);
    }
    if (opts.filter === 'unread') where.push('b.read = 0');
    else if (opts.filter === 'read') where.push('b.read = 1');
    else if (opts.filter === 'favorite') where.push('b.favorite = 1');
    const page = [opts.limit, opts.offset ?? 0];

    const trimmed = opts.query?.trim() ?? '';
    if (!trimmed) {
      const filters = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
      const total = (
        this.db.prepare(`${cte}SELECT COUNT(*) AS n FROM bookmarks b ${filters}`).get(...params) as { n: number }
      ).n;
      const rows = this.db
        .prepare(`${cte}SELECT b.* FROM bookmarks b ${filters} ORDER BY b.post_created_at DESC, b.id DESC LIMIT ? OFFSET ?`)
        .all(...params, ...page) as BookmarkRow[];
      return { total, mode: 'none', hits: rows.map((r) => ({ bookmark: toStoredBookmark(r), snippet: null })) };
    }

    const match = buildMatchQuery(trimmed);
    if (!match) return { total: 0, mode: 'all', hits: [] };
    const filters = ['bookmark_fts MATCH ?', ...where].join(' AND ');
    const from = 'FROM bookmark_fts JOIN bookmarks b ON b.id = bookmark_fts.rowid';
    // The CTE's parameter comes first in the statement, the MATCH expression next.
    const bind = (expr: string) =>
      opts.categoryId !== undefined ? [params[0]!, expr, ...params.slice(1)] : [expr, ...params];
    const run = (expr: string, mode: 'all' | 'any'): BookmarkSearchResult => {
      const total = (
        this.db.prepare(`${cte}SELECT COUNT(*) AS n ${from} WHERE ${filters}`).get(...bind(expr)) as { n: number }
      ).n;
      if (total === 0) return { total, mode, hits: [] };
      const rows = this.db
        .prepare(
          `${cte}SELECT b.*, snippet(bookmark_fts, -1, '«', '»', '…', 24) AS snippet
           ${from} WHERE ${filters}
           ORDER BY bm25(bookmark_fts, ${SEARCH_WEIGHTS.join(', ')}), b.id DESC
           LIMIT ? OFFSET ?`,
        )
        .all(...bind(expr), ...page) as (BookmarkRow & { snippet: string | null })[];
      return {
        total,
        mode,
        hits: rows.map((r) => ({ bookmark: toStoredBookmark(r), snippet: r.snippet || null })),
      };
    };
    const every = run(match.all, 'all');
    return every.total > 0 || match.any === match.all ? every : run(match.any, 'any');
  }

  /** Library-wide counts. Pure SQL over the library tables; reads nothing from `run_state`. */
  getLibraryStats(): LibraryStats {
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) AS bookmarks,
           COALESCE(SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END), 0) AS unread,
           COALESCE(SUM(CASE WHEN favorite = 1 THEN 1 ELSE 0 END), 0) AS favorites,
           MIN(NULLIF(post_created_at, '')) AS oldest,
           MAX(NULLIF(post_created_at, '')) AS newest
         FROM bookmarks`,
      )
      .get() as { bookmarks: number; unread: number; favorites: number; oldest: string | null; newest: string | null };
    const count = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      bookmarks: row.bookmarks,
      unread: row.unread,
      favorites: row.favorites,
      withSummary: count('SELECT COUNT(*) AS n FROM summaries'),
      categories: count('SELECT COUNT(*) AS n FROM categories'),
      oldestPostAt: row.oldest,
      newestPostAt: row.newest,
    };
  }

  /**
   * The category ids a bookmark is directly filed under, for each id in
   * `bookmarkIds`. Lets the viewer patch only the sidebar counters affected
   * by a read-state toggle or delete (that bookmark's categories and their
   * ancestors) instead of reloading the whole tree.
   */
  getCategoryIdsForBookmarks(bookmarkIds: number[]): Map<number, number[]> {
    const map = new Map<number, number[]>();
    if (bookmarkIds.length === 0) return map;
    const placeholders = bookmarkIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT bookmark_id, category_id FROM bookmark_categories WHERE bookmark_id IN (${placeholders})`,
      )
      .all(...bookmarkIds) as { bookmark_id: number; category_id: number }[];
    for (const row of rows) {
      const list = map.get(row.bookmark_id);
      if (list) list.push(row.category_id);
      else map.set(row.bookmark_id, [row.category_id]);
    }
    return map;
  }

  /**
   * Rolled-up counts for a category subtree: total bookmarks, how many are
   * unread and how many are favorited. Lets the viewer show accurate totals
   * for every tab and page the filtered set without downloading every row.
   */
  getCategoryBookmarkCounts(categoryId: number): CategoryBookmarkCounts {
    const row = this.db
      .prepare(
        `WITH RECURSIVE subtree(id) AS (
           SELECT ?
           UNION
           SELECT c.id FROM categories c JOIN subtree s ON c.parent_id = s.id
         )
         SELECT
           COUNT(*) AS total,
           COALESCE(SUM(CASE WHEN b.read = 0 THEN 1 ELSE 0 END), 0) AS unread,
           COALESCE(SUM(CASE WHEN b.favorite = 1 THEN 1 ELSE 0 END), 0) AS favorite
         FROM bookmarks b
         WHERE b.id IN (
           SELECT bc.bookmark_id FROM bookmark_categories bc
           JOIN subtree s ON s.id = bc.category_id
         )`,
      )
      .get(categoryId) as CategoryBookmarkCounts;
    return { total: row.total, unread: row.unread, favorite: row.favorite };
  }

  /**
   * Mark a bookmark read and record when. Idempotent: the read timestamp is set
   * only the first time, so re-opening does not overwrite the original date.
   * Returns the updated bookmark, or undefined if the id is unknown.
   */
  markRead(id: number, when: string = new Date().toISOString()): StoredBookmark | undefined {
    this.db
      .prepare(
        `UPDATE bookmarks
         SET read = 1, read_at = COALESCE(read_at, ?)
         WHERE id = ?`,
      )
      .run(when, id);
    return this.getBookmarkById(id);
  }

  /** Clear read state, so the chip's toggle can flip a bookmark back to unread. */
  markUnread(id: number): StoredBookmark | undefined {
    this.db.prepare(`UPDATE bookmarks SET read = 0, read_at = NULL WHERE id = ?`).run(id);
    return this.getBookmarkById(id);
  }

  /**
   * Star or unstar a bookmark (issue #63). A durable per-bookmark flag like
   * `read`: ingestion never overwrites an existing row and recategorization
   * only rewrites category links, so the star survives both. Returns the
   * updated bookmark, or undefined if the id is unknown.
   */
  setFavorite(id: number, favorite: boolean): StoredBookmark | undefined {
    this.db.prepare(`UPDATE bookmarks SET favorite = ? WHERE id = ?`).run(favorite ? 1 : 0, id);
    return this.getBookmarkById(id);
  }

  /**
   * Permanently remove a bookmark from the local store: the row (and its
   * category links, via ON DELETE CASCADE) is deleted, and its post id is
   * tombstoned in `deleted_bookmarks` so it can never be re-added by a later
   * incremental sync (`getKnownPostIds` includes tombstones). Returns false if
   * the id is unknown. This never touches X - it only removes the local copy.
   */
  deleteBookmark(id: number, when: string = new Date().toISOString()): boolean {
    const tx = this.db.transaction((bookmarkId: number) => {
      const row = this.db.prepare('SELECT post_id FROM bookmarks WHERE id = ?').get(bookmarkId) as
        | { post_id: string }
        | undefined;
      if (!row) return false;
      this.db
        .prepare('INSERT OR IGNORE INTO deleted_bookmarks (post_id, deleted_at) VALUES (?, ?)')
        .run(row.post_id, when);
      this.db.prepare('DELETE FROM bookmarks WHERE id = ?').run(bookmarkId);
      return true;
    });
    return tx(id);
  }

  // --- Categories --------------------------------------------------------

  getAllCategories(): CategoryNode[] {
    const rows = this.db.prepare('SELECT * FROM categories ORDER BY id').all() as CategoryRow[];
    return rows.map(toCategoryNode);
  }

  /** One category by id, or undefined - how a caller validates a target id. */
  getCategoryById(id: number): CategoryNode | undefined {
    const row = this.db.prepare('SELECT * FROM categories WHERE id = ?').get(id) as
      | CategoryRow
      | undefined;
    return row ? toCategoryNode(row) : undefined;
  }

  /**
   * Find a child of `parentId` by case-insensitive name WITHOUT creating it.
   * `parentId` null means a root node. Used by the assignment pass to resolve a
   * path against the fixed, designed tree, so an off-tree path resolves to
   * nothing rather than silently minting a new category.
   */
  findCategory(name: string, parentId: number | null): CategoryNode | undefined {
    const trimmed = name.trim();
    const row =
      parentId === null
        ? (this.db
            .prepare('SELECT * FROM categories WHERE parent_id IS NULL AND name = ? COLLATE NOCASE')
            .get(trimmed) as CategoryRow | undefined)
        : (this.db
            .prepare('SELECT * FROM categories WHERE parent_id = ? AND name = ? COLLATE NOCASE')
            .get(parentId, trimmed) as CategoryRow | undefined);
    return row ? toCategoryNode(row) : undefined;
  }

  /** The owner's own categories (`origin = 'user'`), by id. */
  getUserCategories(): CategoryNode[] {
    const rows = this.db
      .prepare("SELECT * FROM categories WHERE origin = 'user' ORDER BY id")
      .all() as CategoryRow[];
    return rows.map(toCategoryNode);
  }

  /** Whether any category the passes made exists - what decides a first run. */
  hasGeneratedCategories(): boolean {
    return !!this.db.prepare("SELECT 1 FROM categories WHERE origin = 'generated' LIMIT 1").get();
  }

  /**
   * The ids a recategorize must keep: every `user` category plus each of its
   * ancestors. An ancestor is kept even when it is `generated`, because
   * `parent_id` is `ON DELETE CASCADE` - deleting it would take the owner's
   * category with it, and re-creating it would MOVE the owner's category.
   */
  getProtectedCategoryIds(): Set<number> {
    const rows = this.db
      .prepare(
        `WITH RECURSIVE kept(id) AS (
           SELECT id FROM categories WHERE origin = 'user'
           UNION
           SELECT c.parent_id FROM categories c JOIN kept k ON c.id = k.id
            WHERE c.parent_id IS NOT NULL
         )
         SELECT id FROM kept`,
      )
      .all() as { id: number }[];
    return new Set(rows.map((r) => r.id));
  }

  /**
   * Clear the generated taxonomy before a recategorize rebuilds it, leaving
   * bookmarks (and their read state/dates) untouched.
   *
   * The owner's categories are the exception, and this is where that is
   * enforced rather than in any prompt: every `user` category survives with
   * its name, place, description and posts, together with the ancestors that
   * hold it in place ({@link getProtectedCategoryIds}). Every other category
   * is deleted, and every category link is dropped EXCEPT a link into a
   * `user` category - the rebuild re-files everything else, and a post the
   * owner's category already holds stays there. A kept generated ancestor
   * loses its links like any other generated node; the rebuild may file into
   * it again.
   */
  clearGeneratedCategories(): void {
    const tx = this.db.transaction(() => {
      const keep = [...this.getProtectedCategoryIds()];
      const placeholders = keep.map(() => '?').join(',');
      this.db
        .prepare(
          `DELETE FROM bookmark_categories
            WHERE category_id NOT IN (SELECT id FROM categories WHERE origin = 'user')`,
        )
        .run();
      this.db
        .prepare(keep.length > 0 ? `DELETE FROM categories WHERE id NOT IN (${placeholders})` : 'DELETE FROM categories')
        .run(...keep);
    });
    tx();
  }

  /**
   * Run `fn` in one transaction: everything it writes lands, or nothing does.
   * Nests (as a savepoint) inside another transaction.
   */
  inTransaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /**
   * Re-parent a category (null: make it a root). Its descendants and its
   * bookmark links ride along untouched, since both hang off its id - and so
   * does its `origin`: moving is the owner's action, never a pass's. The
   * CALLER validates the move (`planCategoryMove`) - this is only the write.
   */
  setCategoryParent(id: number, parentId: number | null): boolean {
    return this.db.prepare('UPDATE categories SET parent_id = ? WHERE id = ?').run(parentId, id).changes > 0;
  }

  /** Store `ids` (one parent's children, in the wanted order) as positions 0..n-1. */
  setCategoryPositions(ids: number[]): void {
    const stmt = this.db.prepare('UPDATE categories SET position = ? WHERE id = ?');
    this.inTransaction(() => ids.forEach((id, i) => stmt.run(i, id)));
  }

  /**
   * Mark a category as the owner's own, or hand it back to the passes. The
   * editor's toggle - the only way an existing (migrated) row becomes
   * protected. Returns false when the id is unknown.
   */
  setCategoryOrigin(id: number, origin: CategoryOrigin): boolean {
    return this.db.prepare('UPDATE categories SET origin = ? WHERE id = ?').run(origin, id).changes > 0;
  }

  /**
   * Find a child of `parentId` by case-insensitive name, or create it.
   * `parentId` null means a root node.
   *
   * `description` is the one-line gloss the taxonomy pass emits per node
   * (issue #61). It is only ever FILLED IN, never cleared: an existing node
   * whose description is still null gains one when a later design pass supplies
   * it, but a node that already has one keeps it, so a node created without a
   * description is upgraded by a later design pass while a real description
   * is never overwritten. A `user` category's
   * description is never touched at all: it is the owner's, and a pass merging
   * into it must leave it exactly as it found it.
   *
   * A row this creates is always `generated` - the passes are its only callers.
   */
  getOrCreateCategory(
    name: string,
    parentId: number | null,
    when: string,
    description?: string | null,
  ): CategoryNode {
    const trimmed = name.trim();
    const desc = description?.trim() || null;
    const existing =
      parentId === null
        ? (this.db
            .prepare('SELECT * FROM categories WHERE parent_id IS NULL AND name = ? COLLATE NOCASE')
            .get(trimmed) as CategoryRow | undefined)
        : (this.db
            .prepare('SELECT * FROM categories WHERE parent_id = ? AND name = ? COLLATE NOCASE')
            .get(parentId, trimmed) as CategoryRow | undefined);
    if (existing) {
      if (desc && !existing.description && existing.origin !== 'user') {
        this.db.prepare('UPDATE categories SET description = ? WHERE id = ?').run(desc, existing.id);
        return toCategoryNode({ ...existing, description: desc });
      }
      return toCategoryNode(existing);
    }

    const info = this.db
      .prepare('INSERT INTO categories (parent_id, name, description, created_at) VALUES (?, ?, ?, ?)')
      .run(parentId, trimmed, desc, when);
    return {
      id: Number(info.lastInsertRowid),
      parentId,
      name: trimmed,
      origin: 'generated',
      description: desc,
      createdAt: when,
    };
  }

  /**
   * Create a category under `parentId` (null for a root). Returns undefined
   * when a sibling of that name already exists - deliberately NOT a merge,
   * unlike {@link getOrCreateCategory}: the taxonomy passes want get-or-create,
   * but the owner typing a name into the category editor (issue #101) is
   * asking for a NEW node and must be told when that name is taken. The
   * comparison is case-insensitive, matching how sibling names merge
   * everywhere else, so "AI" and "ai" are the same sibling.
   *
   * The CALLER validates that `parentId` names a real category (an unknown
   * parent is a bad request, not a missing row).
   *
   * A category made here is the owner's (`origin = 'user'`), so every later
   * sync and recategorize keeps it exactly as it is.
   */
  createCategory(
    name: string,
    parentId: number | null,
    when: string = new Date().toISOString(),
  ): CategoryNode | undefined {
    const trimmed = name.trim();
    if (!trimmed) return undefined;
    if (this.findCategory(trimmed, parentId)) return undefined;
    const info = this.db
      .prepare(
        "INSERT INTO categories (parent_id, name, description, created_at, origin) VALUES (?, ?, NULL, ?, 'user')",
      )
      .run(parentId, trimmed, when);
    return {
      id: Number(info.lastInsertRowid),
      parentId,
      name: trimmed,
      origin: 'user',
      description: null,
      createdAt: when,
    };
  }

  /**
   * A category's own id followed by every descendant's. `categories.parent_id`
   * is `ON DELETE CASCADE`, so a delete only needs the subtree's root - but
   * the count the destructive confirmation shows, and the orphan test in
   * {@link planCategoryDeletion}, both need the whole set spelled out.
   */
  getCategorySubtreeIds(id: number): number[] {
    const rows = this.db
      .prepare(
        `WITH RECURSIVE subtree(id) AS (
           SELECT id FROM categories WHERE id = ?
           UNION ALL
           SELECT c.id FROM categories c JOIN subtree s ON c.parent_id = s.id
         )
         SELECT id FROM subtree`,
      )
      .all(id) as { id: number }[];
    return rows.map((r) => r.id);
  }

  /**
   * What deleting `id` would remove, computed WITHOUT mutating anything: the
   * category rows (the target plus its descendants) and the bookmarks that
   * would be left filed nowhere.
   *
   * The orphan test is the owner's decided rule on issue #101: a bookmark
   * inside the doomed subtree is deleted only when it has NO membership
   * outside it. A post that is also filed under a surviving category is kept
   * and merely loses its link to the subtree - so the number the confirmation
   * dialog states is the number of posts that really go, never "every post in
   * here". The delete runs this same plan inside its transaction, which is why
   * the preview and the delete can never disagree.
   */
  planCategoryDeletion(id: number): CategoryDeletionPlan | undefined {
    if (!this.getCategoryById(id)) return undefined;
    const categoryIds = this.getCategorySubtreeIds(id);
    const placeholders = categoryIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT DISTINCT bc.bookmark_id AS id
           FROM bookmark_categories bc
          WHERE bc.category_id IN (${placeholders})
            AND NOT EXISTS (
              SELECT 1 FROM bookmark_categories other
               WHERE other.bookmark_id = bc.bookmark_id
                 AND other.category_id NOT IN (${placeholders})
            )
          ORDER BY bc.bookmark_id`,
      )
      .all(...categoryIds, ...categoryIds) as { id: number }[];
    return {
      categoryIds,
      subcategoryCount: categoryIds.length - 1,
      orphanedBookmarkIds: rows.map((r) => r.id),
    };
  }

  /**
   * Delete a category, its descendants and the bookmarks orphaned by that -
   * the whole thing in ONE transaction, so a crash half way can never leave
   * the tree pruned but the posts still filed under nodes that are gone.
   *
   * Each orphaned bookmark goes through {@link deleteBookmark}, i.e. the same
   * tombstoning path the per-card delete and the reset use, so a post removed
   * here can never be re-added by a later incremental sync. The category rows
   * and every remaining link drop via `ON DELETE CASCADE`, which is why only
   * the subtree's root is deleted explicitly.
   *
   * Returns the counts actually removed, or undefined if the id is unknown.
   */
  deleteCategory(
    id: number,
    when: string = new Date().toISOString(),
  ): CategoryDeletionCounts | undefined {
    const tx = this.db.transaction((categoryId: number) => {
      const plan = this.planCategoryDeletion(categoryId);
      if (!plan) return undefined;
      for (const bookmarkId of plan.orphanedBookmarkIds) this.deleteBookmark(bookmarkId, when);
      this.db.prepare('DELETE FROM categories WHERE id = ?').run(categoryId);
      return {
        categories: plan.categoryIds.length,
        subcategories: plan.subcategoryCount,
        posts: plan.orphanedBookmarkIds.length,
      };
    });
    return tx(id);
  }

  linkBookmarkToCategory(bookmarkId: number, categoryId: number): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO bookmark_categories (bookmark_id, category_id) VALUES (?, ?)',
      )
      .run(bookmarkId, categoryId);
  }

  /**
   * Re-file a bookmark under exactly the given categories (issue #92): every
   * existing `bookmark_categories` row for it is dropped and the chosen ones
   * inserted, in ONE transaction, so the post is never momentarily filed
   * nowhere (or under both) if the process dies mid-write.
   *
   * "Move" is re-file, not add - the owner's decision on #92: a post that the
   * categorization pass filed under several categories collapses to the single
   * chosen one. The list form exists for exactly one caller, the move toast's
   * Undo (issue #99), which has to put a multi-labelled post back the way it
   * was; a move itself always passes one id.
   *
   * Returns false if the bookmark id is unknown; the CALLER validates that
   * each target is a real category (the route answers 400 with an actionable
   * message), because a bad target is a request error, not a missing row.
   */
  setBookmarkCategories(bookmarkId: number, categoryIds: number[]): boolean {
    const tx = this.db.transaction((id: number, targets: number[]) => {
      const exists = this.db.prepare('SELECT 1 FROM bookmarks WHERE id = ?').get(id);
      if (!exists) return false;
      this.db.prepare('DELETE FROM bookmark_categories WHERE bookmark_id = ?').run(id);
      const insert = this.db.prepare(
        'INSERT OR IGNORE INTO bookmark_categories (bookmark_id, category_id) VALUES (?, ?)',
      );
      for (const target of targets) insert.run(id, target);
      return true;
    });
    return tx(bookmarkId, categoryIds);
  }

  /** The single-target move; see `setBookmarkCategories`. */
  setBookmarkCategory(bookmarkId: number, categoryId: number): boolean {
    return this.setBookmarkCategories(bookmarkId, [categoryId]);
  }

  /**
   * Stored bookmarks NOT filed anywhere in `categoryId`'s subtree, newest-
   * ingested first - what "Find bookmarks for this category" checks. A post
   * the subtree already holds needs no second look.
   */
  getBookmarksOutsideCategory(categoryId: number): StoredBookmark[] {
    const subtree = this.getCategorySubtreeIds(categoryId);
    if (subtree.length === 0) return [];
    const placeholders = subtree.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT * FROM bookmarks b
          WHERE NOT EXISTS (
            SELECT 1 FROM bookmark_categories bc
             WHERE bc.bookmark_id = b.id AND bc.category_id IN (${placeholders})
          )
          ORDER BY b.ingested_at DESC, b.id DESC`,
      )
      .all(...subtree) as BookmarkRow[];
    return rows.map(toStoredBookmark);
  }

  /**
   * ADD `categoryId` to each bookmark's categories, never removing any link -
   * the find action's write. Returns the ids actually linked (a bookmark that
   * already had the link, or no longer exists, is left out), in one
   * transaction so a crash never half-applies a batch.
   */
  addBookmarksToCategory(categoryId: number, bookmarkIds: number[]): number[] {
    const tx = this.db.transaction((ids: number[]) => {
      const insert = this.db.prepare(
        `INSERT OR IGNORE INTO bookmark_categories (bookmark_id, category_id)
         SELECT id, ? FROM bookmarks WHERE id = ?`,
      );
      const added: number[] = [];
      for (const id of ids) if (insert.run(categoryId, id).changes > 0) added.push(id);
      return added;
    });
    return tx(bookmarkIds);
  }

  /**
   * Undo {@link addBookmarksToCategory}: drop exactly those links again. A
   * link is kept when removing it would leave the post filed nowhere (it was
   * re-filed into only this category since), because a post in no category is
   * invisible in the viewer. Returns the ids actually unlinked.
   */
  removeBookmarksFromCategory(categoryId: number, bookmarkIds: number[]): number[] {
    const tx = this.db.transaction((ids: number[]) => {
      const others = this.db.prepare(
        'SELECT 1 FROM bookmark_categories WHERE bookmark_id = ? AND category_id <> ? LIMIT 1',
      );
      const remove = this.db.prepare('DELETE FROM bookmark_categories WHERE bookmark_id = ? AND category_id = ?');
      const removed: number[] = [];
      for (const id of ids) {
        if (!others.get(id, categoryId)) continue;
        if (remove.run(id, categoryId).changes > 0) removed.push(id);
      }
      return removed;
    });
    return tx(bookmarkIds);
  }

  // --- Atomic batch write ------------------------------------------------

  /**
   * Store a batch of bookmarks together with their resolved category links in a
   * single transaction. `resolve` maps a raw bookmark to the leaf category ids
   * it should be linked to, resolving/creating tree nodes as needed. Because
   * the whole batch commits atomically, a bookmark is only ever marked "seen"
   * once it has been categorized.
   */
  storeCategorizedBatch(
    batch: RawBookmark[],
    resolve: (bookmark: RawBookmark) => number[],
    when: string = new Date().toISOString(),
  ): void {
    const insertBookmark = this.db.prepare(
      `INSERT INTO bookmarks
         (post_id, author_username, author_name, text, url, post_created_at, ingested_at)
       VALUES (@postId, @authorUsername, @authorName, @text, @url, @postCreatedAt, @ingestedAt)
       ON CONFLICT(post_id) DO NOTHING`,
    );

    const tx = this.db.transaction((items: RawBookmark[]) => {
      for (const bm of items) {
        const categoryIds = resolve(bm);
        const info = insertBookmark.run({
          postId: bm.postId,
          authorUsername: bm.authorUsername,
          authorName: bm.authorName,
          text: bm.text,
          url: bm.url,
          postCreatedAt: bm.postCreatedAt,
          ingestedAt: when,
        });
        const bookmarkId =
          info.changes > 0
            ? Number(info.lastInsertRowid)
            : this.getBookmarkByPostId(bm.postId)?.id;
        if (bookmarkId === undefined) continue;
        this.writeXArticleData(bm, when);
        for (const categoryId of categoryIds) {
          this.linkBookmarkToCategory(bookmarkId, categoryId);
        }
      }
    });
    tx(batch);
  }

  // --- X-native Articles --------------------------------------------------

  /**
   * Persist whatever X Article data a fetched bookmark carries: its own
   * Article, the quoted post id, and the quoted post's Article. Only ever
   * adds/refreshes data - a bookmark re-stored without it (e.g. by
   * `recategorize`) leaves what is already stored untouched.
   */
  private writeXArticleData(bm: RawBookmark, when: string): void {
    if (bm.xArticle) this.saveXArticle(bm.postId, bm.xArticle, when);
    if (bm.quotedPostId) this.setQuotedPostId(bm.postId, bm.quotedPostId);
    if (bm.quotedPostId && bm.quotedXArticle) this.saveXArticle(bm.quotedPostId, bm.quotedXArticle, when);
    if (bm.quotedPost) this.saveQuotedPost(bm.quotedPost, when);
  }

  /** Store (or refresh) the X Article hosted by `postId`. */
  saveXArticle(postId: string, article: XArticle, when: string = new Date().toISOString()): void {
    this.db
      .prepare(
        `INSERT INTO x_articles
           (post_id, rest_id, title, preview_text, plain_text, cover_url, cover_w, cover_h, fetched_at)
         VALUES (@postId, @restId, @title, @previewText, @plainText, @coverUrl, @coverWidth, @coverHeight, @fetchedAt)
         ON CONFLICT(post_id) DO UPDATE SET
           rest_id = excluded.rest_id,
           title = excluded.title,
           preview_text = excluded.preview_text,
           plain_text = excluded.plain_text,
           cover_url = excluded.cover_url,
           cover_w = excluded.cover_w,
           cover_h = excluded.cover_h,
           fetched_at = excluded.fetched_at`,
      )
      .run({ postId, ...article, fetchedAt: when });
  }

  /** Record which post a stored bookmark quotes. */
  setQuotedPostId(postId: string, quotedPostId: string): void {
    this.db.prepare('UPDATE bookmarks SET quoted_post_id = ? WHERE post_id = ?').run(quotedPostId, postId);
  }

  /** The X Article hosted by `postId`, if stored. */
  getXArticle(postId: string): XArticle | undefined {
    const row = this.db.prepare('SELECT * FROM x_articles WHERE post_id = ?').get(postId) as
      | XArticleRow
      | undefined;
    return row ? toXArticle(row) : undefined;
  }

  /**
   * The X Article each bookmark shows (see {@link BookmarkXArticle}), keyed by
   * the bookmark's post id; bookmarks with none are absent. One query for the
   * whole list, so the viewer's page read stays a single cheap lookup.
   */
  getXArticlesForBookmarks(
    bookmarks: Pick<RawBookmark, 'postId' | 'quotedPostId'>[],
  ): Map<string, BookmarkXArticle> {
    const result = new Map<string, BookmarkXArticle>();
    const ids = new Set<string>();
    for (const bm of bookmarks) {
      ids.add(bm.postId);
      if (bm.quotedPostId) ids.add(bm.quotedPostId);
    }
    if (ids.size === 0) return result;
    const list = [...ids];
    const rows = this.db
      .prepare(`SELECT * FROM x_articles WHERE post_id IN (${list.map(() => '?').join(',')})`)
      .all(...list) as XArticleRow[];
    const byPostId = new Map(rows.map((r) => [r.post_id, toXArticle(r)]));
    for (const bm of bookmarks) {
      const own = byPostId.get(bm.postId);
      const quoted = bm.quotedPostId ? byPostId.get(bm.quotedPostId) : undefined;
      if (own) result.set(bm.postId, { article: own, postId: bm.postId, quoted: false });
      else if (quoted && bm.quotedPostId) {
        result.set(bm.postId, { article: quoted, postId: bm.quotedPostId, quoted: true });
      }
    }
    return result;
  }

  // --- Quoted post content -------------------------------------------------

  /** Store (or refresh) the content of a quoted ordinary post, keyed by its own post id. */
  saveQuotedPost(post: QuotedPost, when: string = new Date().toISOString()): void {
    this.db
      .prepare(
        `INSERT INTO quoted_posts
           (post_id, author_username, author_name, text, created_at, fetched_at)
         VALUES (@postId, @authorUsername, @authorName, @text, @createdAt, @fetchedAt)
         ON CONFLICT(post_id) DO UPDATE SET
           author_username = excluded.author_username,
           author_name = excluded.author_name,
           text = excluded.text,
           created_at = excluded.created_at,
           fetched_at = excluded.fetched_at`,
      )
      .run({ ...post, fetchedAt: when });
  }

  /** The content of a quoted post, if stored. */
  getQuotedPost(postId: string): QuotedPost | undefined {
    const row = this.db.prepare('SELECT * FROM quoted_posts WHERE post_id = ?').get(postId) as
      | QuotedPostRow
      | undefined;
    return row ? toQuotedPost(row) : undefined;
  }

  /** The stored quoted-post content for each id in `postIds`, keyed by post id. */
  getQuotedPosts(postIds: string[]): Map<string, QuotedPost> {
    const result = new Map<string, QuotedPost>();
    if (postIds.length === 0) return result;
    const ids = [...new Set(postIds)];
    const rows = this.db
      .prepare(`SELECT * FROM quoted_posts WHERE post_id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids) as QuotedPostRow[];
    for (const row of rows) result.set(row.post_id, toQuotedPost(row));
    return result;
  }

  /**
   * Return the library to its never-synced state: every bookmark (and, by
   * cascade, its category links, article/summary/score rows), the taxonomy,
   * the URL-keyed and X-article/quote caches, delete tombstones, and the sync
   * cursor. Idempotent.
   *
   * A reset is a LIBRARY wipe, never a configuration wipe, so `run_state` is
   * cleared by NAMING the keys that are library state
   * ({@link RESET_CLEARED_STATE_KEYS}) rather than by naming the ones to keep.
   * The rule is inverted deliberately (security review finding 4): the old
   * keep-list silently destroyed the owner's hand-authored `rubric_presets`
   * and their `root_order` - and reverted the active rubric, which re-flagged
   * every score in the library as unranked and invited a paid re-rank under
   * rules the owner never chose. A `run_state` key added in the future now
   * defaults to SURVIVING a reset; anything genuinely per-sync has to opt in
   * to being cleared, right here.
   */
  resetLibrary(): void {
    this.db.transaction(() => {
      for (const table of [
        'bookmarks',
        'categories',
        'deleted_bookmarks',
        'article_link_metadata',
        'x_articles',
        'quoted_posts',
        // Every item already went with its bookmark; an emptied list is noise.
        'assistant_lists',
      ]) {
        this.db.prepare(`DELETE FROM ${table}`).run();
      }
      this.db
        .prepare(
          `DELETE FROM run_state WHERE key IN (${RESET_CLEARED_STATE_KEYS.map(() => '?').join(',')})`,
        )
        .run(...RESET_CLEARED_STATE_KEYS);
    })();
  }

  // --- Assistant result lists (MCP `show_in_app`) -------------------------

  /**
   * Store a result list: `bookmarkIds` in the order given (callers dedupe and
   * validate them). One transaction, so a list never exists half-written.
   */
  createAssistantList(
    list: { title: string; note: string | null; bookmarkIds: number[] },
    when: string = new Date().toISOString(),
  ): AssistantList {
    const id = this.db.transaction(() => {
      const listId = Number(
        this.db
          .prepare('INSERT INTO assistant_lists (title, note, created_at) VALUES (?, ?, ?)')
          .run(list.title, list.note, when).lastInsertRowid,
      );
      const insert = this.db.prepare(
        'INSERT OR IGNORE INTO assistant_list_items (list_id, bookmark_id, position) VALUES (?, ?, ?)',
      );
      list.bookmarkIds.forEach((bookmarkId, position) => insert.run(listId, bookmarkId, position));
      return listId;
    })();
    return this.getAssistantList(id)!;
  }

  /** Every list, newest first, each with how many of its posts still exist. */
  getAssistantLists(): AssistantList[] {
    const rows = this.db
      .prepare(`${ASSISTANT_LIST_SELECT} ORDER BY l.created_at DESC, l.id DESC`)
      .all() as AssistantListRow[];
    return rows.map(toAssistantList);
  }

  getAssistantList(id: number): AssistantList | undefined {
    const row = this.db.prepare(`${ASSISTANT_LIST_SELECT} WHERE l.id = ?`).get(id) as AssistantListRow | undefined;
    return row ? toAssistantList(row) : undefined;
  }

  /**
   * Record that the owner opened a list. Only the FIRST open is stamped, so
   * the answer says whether anything changed: `undefined` for an unknown id,
   * `false` for a list already viewed.
   */
  markAssistantListViewed(id: number, when: string = new Date().toISOString()): boolean | undefined {
    const changed = this.db
      .prepare('UPDATE assistant_lists SET viewed_at = ? WHERE id = ? AND viewed_at IS NULL')
      .run(when, id).changes;
    if (changed > 0) return true;
    return this.getAssistantList(id) ? false : undefined;
  }

  countAssistantLists(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM assistant_lists').get() as { n: number }).n;
  }

  /**
   * A list's bookmarks. By default in the order the assistant gave them
   * (`sort: 'list'`); `recent` and `score` order them exactly as
   * {@link getBookmarksForCategory} orders a category (unranked last in both
   * directions, scores scoped to `rubricVersion`), and `dir: 'asc'` reverses
   * the assistant's order.
   */
  getAssistantListBookmarks(id: number, opts: AssistantListSortOptions = {}): StoredBookmark[] {
    const asc = opts.dir === 'asc';
    const scored = opts.sort === 'score';
    const scoreJoin = scored
      ? `LEFT JOIN bookmark_scores sc ON sc.bookmark_id = b.id${opts.rubricVersion ? ' AND sc.rubric_version = ?' : ''}`
      : '';
    const order =
      opts.sort === 'recent'
        ? asc
          ? 'b.ingested_at ASC, b.id ASC'
          : 'b.ingested_at DESC, b.id DESC'
        : scored
          ? `sc.score IS NULL, sc.score ${asc ? 'ASC' : 'DESC'}, b.ingested_at DESC, b.id DESC`
          : asc
            ? 'i.position DESC, b.id DESC'
            : 'i.position, b.id';
    const params: (number | string)[] = [];
    if (scored && opts.rubricVersion) params.push(opts.rubricVersion);
    params.push(id);
    const rows = this.db
      .prepare(
        `SELECT b.* FROM assistant_list_items i
         JOIN bookmarks b ON b.id = i.bookmark_id
         ${scoreJoin}
         WHERE i.list_id = ?
         ORDER BY ${order}`,
      )
      .all(...params) as BookmarkRow[];
    return rows.map(toStoredBookmark);
  }

  /** Whether any assistant list holds this bookmark (so its read state moves a list's count). */
  isInAssistantList(bookmarkId: number): boolean {
    return !!this.db.prepare('SELECT 1 FROM assistant_list_items WHERE bookmark_id = ? LIMIT 1').get(bookmarkId);
  }

  /** Delete one list (never its posts). False when the id is unknown. */
  deleteAssistantList(id: number): boolean {
    return this.db.prepare('DELETE FROM assistant_lists WHERE id = ?').run(id).changes > 0;
  }

  /** Delete every list (never a post); returns how many went. */
  clearAssistantLists(): number {
    return this.db.prepare('DELETE FROM assistant_lists').run().changes;
  }

  // --- Run state ---------------------------------------------------------

  getState(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM run_state WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  setState(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO run_state (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  getNewestSeenPostId(): string | undefined {
    return this.getState(MARKER_KEY);
  }

  setNewestSeenPostId(postId: string): void {
    this.setState(MARKER_KEY, postId);
  }

  getRefreshToken(): string | undefined {
    return this.getState(REFRESH_TOKEN_KEY);
  }

  setRefreshToken(token: string): void {
    this.setState(REFRESH_TOKEN_KEY, token);
  }

  /** ISO timestamp of the last successful sync with X, or undefined if never synced. */
  getLastSyncedAt(): string | undefined {
    return this.getState(LAST_SYNCED_AT_KEY);
  }

  setLastSyncedAt(when: string): void {
    this.setState(LAST_SYNCED_AT_KEY, when);
  }

  // --- Counts (raw, per node) -------------------------------------------

  /**
   * Map of category id -> the bookmarks linked directly to that node (id +
   * read flag). The tree builder rolls these up into distinct-bookmark totals
   * across each subtree, so a bookmark linked to several nodes under a shared
   * ancestor is counted once at that ancestor.
   */
  getDirectMembership(): Map<number, { id: number; read: boolean }[]> {
    const rows = this.db
      .prepare(
        `SELECT bc.category_id AS category_id, b.id AS bookmark_id, b.read AS read
         FROM bookmark_categories bc
         JOIN bookmarks b ON b.id = bc.bookmark_id`,
      )
      .all() as { category_id: number; bookmark_id: number; read: number }[];
    const map = new Map<number, { id: number; read: boolean }[]>();
    for (const r of rows) {
      const list = map.get(r.category_id);
      const entry = { id: r.bookmark_id, read: r.read === 1 };
      if (list) list.push(entry);
      else map.set(r.category_id, [entry]);
    }
    return map;
  }

  // --- Article reader cache ------------------------------------------------

  /** The cached reader-view extraction for a bookmark, if one has been fetched. */
  getArticleForBookmark(bookmarkId: number): ArticleRecord | undefined {
    const row = this.db.prepare('SELECT * FROM articles WHERE bookmark_id = ?').get(bookmarkId) as
      | ArticleRow
      | undefined;
    return row ? toArticleRecord(row) : undefined;
  }

  /**
   * Every cached article extraction that yielded no body, for the explicit
   * `refetch-articles` command - a `failed` row is otherwise served from
   * cache forever, even after the fetcher/extractor that produced it is fixed.
   */
  getFailedArticles(): ArticleRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM articles WHERE status = 'failed' ORDER BY bookmark_id")
      .all() as ArticleRow[];
    return rows.map(toArticleRecord);
  }

  /**
   * Store (or replace) the reader-view extraction result for a bookmark, so
   * the reader is served from cache on later opens instead of re-fetching.
   */
  saveArticle(record: ArticleRecord): void {
    this.db
      .prepare(
        `INSERT INTO articles
           (bookmark_id, url, status, title, content_html, content_text, excerpt, site_name, reason, fetched_at)
         VALUES (@bookmarkId, @url, @status, @title, @contentHtml, @contentText, @excerpt, @siteName, @reason, @fetchedAt)
         ON CONFLICT(bookmark_id) DO UPDATE SET
           url = excluded.url,
           status = excluded.status,
           title = excluded.title,
           content_html = excluded.content_html,
           content_text = excluded.content_text,
           excerpt = excluded.excerpt,
           site_name = excluded.site_name,
           reason = excluded.reason,
           fetched_at = excluded.fetched_at`,
      )
      .run({ ...record, contentText: record.contentHtml ? htmlToPlainText(record.contentHtml) : null });
  }

  // --- Article link metadata cache (categorization input, issue #25) -------

  /** The cached title/description for a link, if it has been fetched. */
  getArticleLinkMetadata(url: string): ArticleLinkMetadata | undefined {
    const row = this.db
      .prepare('SELECT * FROM article_link_metadata WHERE url = ?')
      .get(url) as ArticleLinkMetadataRow | undefined;
    return row ? toArticleLinkMetadata(row) : undefined;
  }

  /**
   * Store (or replace) the fetched metadata for a link, keyed by URL so it is
   * reused across bookmarks that share a link and across runs (a dead link is
   * not re-fetched every time either, since failures are cached too).
   */
  saveArticleLinkMetadata(record: ArticleLinkMetadata): void {
    this.db
      .prepare(
        `INSERT INTO article_link_metadata
           (url, status, title, description, image, site_name, resolved_url, fetched_at)
         VALUES (@url, @status, @title, @description, @image, @siteName, @resolvedUrl, @fetchedAt)
         ON CONFLICT(url) DO UPDATE SET
           status = excluded.status,
           title = excluded.title,
           description = excluded.description,
           image = excluded.image,
           site_name = excluded.site_name,
           resolved_url = excluded.resolved_url,
           fetched_at = excluded.fetched_at`,
      )
      .run(record);
  }

  // --- Summary cache -------------------------------------------------------

  /** The cached on-demand summary for a bookmark, if one has been generated. */
  getSummaryForBookmark(bookmarkId: number): SummaryRecord | undefined {
    const row = this.db.prepare('SELECT * FROM summaries WHERE bookmark_id = ?').get(bookmarkId) as
      | SummaryRow
      | undefined;
    return row ? toSummaryRecord(row) : undefined;
  }

  /**
   * Store (or replace) the generated summary for a bookmark, so later opens
   * are served from cache instead of re-generating.
   */
  saveSummary(record: SummaryRecord): void {
    this.db
      .prepare(
        `INSERT INTO summaries (bookmark_id, summary, generated_at)
         VALUES (@bookmarkId, @summary, @generatedAt)
         ON CONFLICT(bookmark_id) DO UPDATE SET
           summary = excluded.summary,
           generated_at = excluded.generated_at`,
      )
      .run(record);
  }

  /**
   * Which of `bookmarkIds` already have a saved summary - a cheap existence
   * check (no summary text) so the viewer can render "Summary" vs
   * "Summarize" per card without an extra round trip.
   */
  getSummarizedBookmarkIds(bookmarkIds: number[]): Set<number> {
    if (bookmarkIds.length === 0) return new Set();
    const placeholders = bookmarkIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT bookmark_id FROM summaries WHERE bookmark_id IN (${placeholders})`)
      .all(...bookmarkIds) as { bookmark_id: number }[];
    return new Set(rows.map((row) => row.bookmark_id));
  }

  /**
   * Delete every cached summary, so they regenerate cleanly under the
   * current logic (e.g. after a bug cached bad/garbage summaries). Returns
   * the number of rows removed. Never called automatically - only via the
   * explicit `clear-summaries` command.
   */
  clearSummaries(): number {
    return this.db.prepare('DELETE FROM summaries').run().changes;
  }

  /** Delete one bookmark's cached summary; true when there was one to remove. */
  deleteSummary(bookmarkId: number): boolean {
    return this.db.prepare('DELETE FROM summaries WHERE bookmark_id = ?').run(bookmarkId).changes > 0;
  }

  // --- Ranking scores (issues #62, #102) ----------------------------------
  //
  // Every read below takes an OPTIONAL `rubricVersion`. Passing one is what a
  // consumer that shows or sorts scores must do: a row exists per (bookmark,
  // rubric), and a verdict from a preset that is not active is not this
  // library's current opinion of that bookmark. Omitting it means "whatever
  // this bookmark was last scored as, under any rubric", which is only useful
  // to a caller that genuinely does not care which scale it gets - a count of
  // rows, a test, a cleanup.

  /** The stored ranking verdict for one bookmark, under a rubric (or the latest). */
  getBookmarkScore(bookmarkId: number, rubricVersion?: string): BookmarkScoreRecord | undefined {
    const row = rubricVersion
      ? (this.db
          .prepare('SELECT * FROM bookmark_scores WHERE bookmark_id = ? AND rubric_version = ?')
          .get(bookmarkId, rubricVersion) as BookmarkScoreRow | undefined)
      : (this.db
          .prepare(
            'SELECT * FROM bookmark_scores WHERE bookmark_id = ? ORDER BY scored_at DESC LIMIT 1',
          )
          .get(bookmarkId) as BookmarkScoreRow | undefined);
    return row ? toBookmarkScoreRecord(row) : undefined;
  }

  /**
   * The stored ranking verdicts for a page of bookmarks, keyed by bookmark id.
   * Absent ids simply have no entry - the viewer renders those as unranked,
   * which under a given `rubricVersion` is exactly what a bookmark scored only
   * by some OTHER preset is.
   */
  getBookmarkScores(bookmarkIds: number[], rubricVersion?: string): Map<number, BookmarkScoreRecord> {
    const map = new Map<number, BookmarkScoreRecord>();
    if (bookmarkIds.length === 0) return map;
    const placeholders = bookmarkIds.map(() => '?').join(',');
    // Newest last with no version filter, so the most recent verdict wins the
    // slot - the same "latest" rule the single-bookmark read applies.
    const sql = rubricVersion
      ? `SELECT * FROM bookmark_scores
           WHERE bookmark_id IN (${placeholders}) AND rubric_version = ?`
      : `SELECT * FROM bookmark_scores
           WHERE bookmark_id IN (${placeholders}) ORDER BY scored_at ASC`;
    const params = rubricVersion ? [...bookmarkIds, rubricVersion] : bookmarkIds;
    const rows = this.db.prepare(sql).all(...params) as BookmarkScoreRow[];
    for (const row of rows) map.set(row.bookmark_id, toBookmarkScoreRecord(row));
    return map;
  }

  /** Store (or replace) one bookmark's ranking verdict under its rubric. */
  saveBookmarkScore(record: BookmarkScoreRecord): void {
    this.db
      .prepare(
        `INSERT INTO bookmark_scores
           (bookmark_id, score, confidence, dimensions, model, rubric_version, scored_at)
         VALUES (@bookmarkId, @score, @confidence, @dimensions, @model, @rubricVersion, @scoredAt)
         ON CONFLICT(bookmark_id, rubric_version) DO UPDATE SET
           score = excluded.score,
           confidence = excluded.confidence,
           dimensions = excluded.dimensions,
           model = excluded.model,
           scored_at = excluded.scored_at`,
      )
      .run({ ...record, dimensions: JSON.stringify(record.dimensions) });
  }

  /**
   * The bookmarks a ranking run should score, oldest-ingested first so a run
   * interrupted partway through resumes in a stable order.
   *
   * By default that is every bookmark with no row under THIS rubric version -
   * mixing two rubrics' scales in one sort would make the ordering meaningless,
   * and since issue #102 a bookmark may well hold a perfectly good verdict from
   * a different preset that simply does not answer the active one's questions.
   * `rescoreAll` returns every bookmark instead, which is the only way to
   * re-spend on rows that are already current.
   */
  getBookmarksToScore(opts: {
    rubricVersion: string;
    rescoreAll?: boolean;
    limit?: number;
  }): StoredBookmark[] {
    // Positional params, bound only for the clauses actually emitted:
    // better-sqlite3 rejects a bound value the statement has no slot for.
    const params: (string | number)[] = [];
    let sql = 'SELECT b.* FROM bookmarks b';
    if (!opts.rescoreAll) {
      // NOT EXISTS rather than a LEFT JOIN: with the version in the key a
      // bookmark can hold several rows, and a join would return it once per
      // rubric it has ever been scored under.
      sql += ` WHERE NOT EXISTS (
         SELECT 1 FROM bookmark_scores sc
          WHERE sc.bookmark_id = b.id AND sc.rubric_version = ?
       )`;
      params.push(opts.rubricVersion);
    }
    sql += ' ORDER BY b.ingested_at ASC, b.id ASC';
    if (opts.limit != null) {
      sql += ' LIMIT ?';
      params.push(opts.limit);
    }
    const rows = this.db.prepare(sql).all(...params) as BookmarkRow[];
    return rows.map(toStoredBookmark);
  }

  /**
   * How many bookmarks carry a ranking score under `rubricVersion` - or, with
   * none given, under any rubric at all. The viewer passes the ACTIVE preset's
   * version, which is what makes "N of M unranked" (issue #98) a statement
   * about the rules currently in force rather than about the table.
   */
  countScoredBookmarks(rubricVersion?: string): number {
    const sql = rubricVersion
      ? 'SELECT COUNT(*) AS n FROM bookmark_scores WHERE rubric_version = ?'
      : 'SELECT COUNT(DISTINCT bookmark_id) AS n FROM bookmark_scores';
    const params = rubricVersion ? [rubricVersion] : [];
    return (this.db.prepare(sql).get(...params) as { n: number }).n;
  }

  /**
   * Delete every stored ranking score. Explicit-only and idempotent - the way
   * to abandon a rubric rather than a migration, mirroring `clear-summaries`.
   */
  clearBookmarkScores(rubricVersion?: string): number {
    return rubricVersion
      ? this.db.prepare('DELETE FROM bookmark_scores WHERE rubric_version = ?').run(rubricVersion)
          .changes
      : this.db.prepare('DELETE FROM bookmark_scores').run().changes;
  }
}
