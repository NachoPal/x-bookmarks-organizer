import fs from 'node:fs';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import {
  ARTICLE_LINK_METADATA_ADDED_COLUMNS,
  BOOKMARKS_ADDED_COLUMNS,
  CATEGORIES_ADDED_COLUMNS,
  SCHEMA_SQL,
} from './schema';
import type {
  ArticleLinkMetadata,
  ArticleRecord,
  BookmarkScoreRecord,
  CategoryNode,
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
 * How a paged bookmark list is ordered.
 *
 * `recent` is the default everywhere and is what the viewer has always done.
 * `score` orders by the opt-in ranking pass's stored score, highest first
 * (issue #62); a bookmark with no score row sorts LAST rather than as a zero,
 * because "never ranked" is not the same claim as "ranked worthless". Both
 * orders break ties on the original recency ordering, so paging is stable.
 */
export type BookmarkSortOrder = 'recent' | 'score';

/** Paging + filtering options for {@link Database.getBookmarksForCategory}. */
export interface BookmarkPageOptions {
  filter?: BookmarkFilter;
  sort?: BookmarkSortOrder;
  offset?: number;
  limit?: number;
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
    description: row.description ?? null,
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

// Mirrors `SETTINGS_KEY` in settings/settings.ts (which imports this class).
const SETTINGS_STATE_KEY = 'app_settings';
const MARKER_KEY = 'newest_seen_post_id';
const REFRESH_TOKEN_KEY = 'x_refresh_token';
const LAST_SYNCED_AT_KEY = 'last_synced_at';

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
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new BetterSqlite3(dbPath);
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
  }

  private addMissingColumns(table: string, columns: { name: string; ddl: string }[]): void {
    const existing = new Set(
      (this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name),
    );
    for (const { name, ddl } of columns) {
      if (!existing.has(name)) this.db.exec(ddl);
    }
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
    let sql = `WITH RECURSIVE subtree(id) AS (
         SELECT ?
         UNION
         SELECT c.id FROM categories c JOIN subtree s ON c.parent_id = s.id
       )
       SELECT b.* FROM bookmarks b
       ${scored ? 'LEFT JOIN bookmark_scores sc ON sc.bookmark_id = b.id' : ''}
       WHERE ${where.join(' AND ')}
       ORDER BY ${scored ? 'sc.score IS NULL, sc.score DESC, ' : ''}b.ingested_at DESC, b.id DESC`;
    const params: (number | string)[] = [categoryId];
    if (opts.limit != null) {
      sql += ' LIMIT ? OFFSET ?';
      params.push(opts.limit, opts.offset ?? 0);
    }
    const rows = this.db.prepare(sql).all(...params) as BookmarkRow[];
    return rows.map(toStoredBookmark);
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

  /**
   * Delete every category and category link, leaving bookmarks (and their read
   * state/dates) untouched. Used by re-categorization before it rebuilds the
   * taxonomy from scratch.
   */
  clearCategories(): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM bookmark_categories').run();
      this.db.prepare('DELETE FROM categories').run();
    });
    tx();
  }

  /**
   * Find a child of `parentId` by case-insensitive name, or create it.
   * `parentId` null means a root node.
   *
   * `description` is the one-line gloss the taxonomy pass emits per node
   * (issue #61). It is only ever FILLED IN, never cleared: an existing node
   * whose description is still null gains one when a later design pass supplies
   * it, but a node that already has one keeps it, so an ad-hoc `extend` node
   * created without a description is upgraded on the next `recategorize` while
   * a real description is never overwritten with nothing.
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
      if (desc && !existing.description) {
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
      description: desc,
      createdAt: when,
    };
  }

  linkBookmarkToCategory(bookmarkId: number, categoryId: number): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO bookmark_categories (bookmark_id, category_id) VALUES (?, ?)',
      )
      .run(bookmarkId, categoryId);
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
   * cursor. KEPT: the X refresh token (no re-login) and the saved
   * categorization settings. Idempotent.
   */
  resetLibrary(): void {
    const keep = [REFRESH_TOKEN_KEY, SETTINGS_STATE_KEY];
    this.db.transaction(() => {
      for (const table of [
        'bookmarks',
        'categories',
        'deleted_bookmarks',
        'article_link_metadata',
        'x_articles',
        'quoted_posts',
      ]) {
        this.db.prepare(`DELETE FROM ${table}`).run();
      }
      this.db
        .prepare(`DELETE FROM run_state WHERE key NOT IN (${keep.map(() => '?').join(',')})`)
        .run(...keep);
    })();
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
           (bookmark_id, url, status, title, content_html, excerpt, site_name, reason, fetched_at)
         VALUES (@bookmarkId, @url, @status, @title, @contentHtml, @excerpt, @siteName, @reason, @fetchedAt)
         ON CONFLICT(bookmark_id) DO UPDATE SET
           url = excluded.url,
           status = excluded.status,
           title = excluded.title,
           content_html = excluded.content_html,
           excerpt = excluded.excerpt,
           site_name = excluded.site_name,
           reason = excluded.reason,
           fetched_at = excluded.fetched_at`,
      )
      .run(record);
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

  // --- Ranking scores (issue #62) -----------------------------------------

  /** The stored ranking verdict for one bookmark, if it has been ranked. */
  getBookmarkScore(bookmarkId: number): BookmarkScoreRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM bookmark_scores WHERE bookmark_id = ?')
      .get(bookmarkId) as BookmarkScoreRow | undefined;
    return row ? toBookmarkScoreRecord(row) : undefined;
  }

  /**
   * The stored ranking verdicts for a page of bookmarks, keyed by bookmark id.
   * Absent ids simply have no entry - the viewer renders those as unranked.
   */
  getBookmarkScores(bookmarkIds: number[]): Map<number, BookmarkScoreRecord> {
    const map = new Map<number, BookmarkScoreRecord>();
    if (bookmarkIds.length === 0) return map;
    const placeholders = bookmarkIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM bookmark_scores WHERE bookmark_id IN (${placeholders})`)
      .all(...bookmarkIds) as BookmarkScoreRow[];
    for (const row of rows) map.set(row.bookmark_id, toBookmarkScoreRecord(row));
    return map;
  }

  /** Store (or replace) one bookmark's ranking verdict. */
  saveBookmarkScore(record: BookmarkScoreRecord): void {
    this.db
      .prepare(
        `INSERT INTO bookmark_scores
           (bookmark_id, score, confidence, dimensions, model, rubric_version, scored_at)
         VALUES (@bookmarkId, @score, @confidence, @dimensions, @model, @rubricVersion, @scoredAt)
         ON CONFLICT(bookmark_id) DO UPDATE SET
           score = excluded.score,
           confidence = excluded.confidence,
           dimensions = excluded.dimensions,
           model = excluded.model,
           rubric_version = excluded.rubric_version,
           scored_at = excluded.scored_at`,
      )
      .run({ ...record, dimensions: JSON.stringify(record.dimensions) });
  }

  /**
   * The bookmarks a ranking run should score, oldest-ingested first so a run
   * interrupted partway through resumes in a stable order.
   *
   * By default that is every bookmark with no score row, plus any scored by a
   * DIFFERENT rubric version - mixing two rubrics' scales in one sort would
   * make the ordering meaningless. `rescoreAll` returns every bookmark instead,
   * which is the only way to re-spend on rows that are already current.
   */
  getBookmarksToScore(opts: {
    rubricVersion: string;
    rescoreAll?: boolean;
    limit?: number;
  }): StoredBookmark[] {
    // Positional params, bound only for the clauses actually emitted:
    // better-sqlite3 rejects a bound value the statement has no slot for.
    const params: (string | number)[] = [];
    let sql = `SELECT b.* FROM bookmarks b
         LEFT JOIN bookmark_scores sc ON sc.bookmark_id = b.id`;
    if (!opts.rescoreAll) {
      sql += ' WHERE sc.bookmark_id IS NULL OR sc.rubric_version <> ?';
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

  /** How many bookmarks currently carry a ranking score. */
  countScoredBookmarks(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM bookmark_scores').get() as { n: number }).n;
  }

  /**
   * Delete every stored ranking score. Explicit-only and idempotent - the way
   * to abandon a rubric rather than a migration, mirroring `clear-summaries`.
   */
  clearBookmarkScores(): number {
    return this.db.prepare('DELETE FROM bookmark_scores').run().changes;
  }
}
