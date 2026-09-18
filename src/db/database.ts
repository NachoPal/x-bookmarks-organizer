import fs from 'node:fs';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { ARTICLE_LINK_METADATA_ADDED_COLUMNS, BOOKMARKS_ADDED_COLUMNS, SCHEMA_SQL } from './schema';
import type {
  ArticleLinkMetadata,
  ArticleRecord,
  CategoryNode,
  RawBookmark,
  StoredBookmark,
  SummaryRecord,
  XArticle,
} from '../types';

/** Read-state filter for the viewer's paged bookmark list. */
export type ReadFilter = 'all' | 'unread' | 'read';

/** Paging + filtering options for {@link Database.getBookmarksForCategory}. */
export interface BookmarkPageOptions {
  filter?: ReadFilter;
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
  quoted_post_id?: string | null;
}

interface CategoryRow {
  id: number;
  parent_id: number | null;
  name: string;
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

function toCategoryNode(row: CategoryRow): CategoryNode {
  return { id: row.id, parentId: row.parent_id, name: row.name, createdAt: row.created_at };
}

interface SummaryRow {
  bookmark_id: number;
  summary: string;
  generated_at: string;
}

function toSummaryRecord(row: SummaryRow): SummaryRecord {
  return { bookmarkId: row.bookmark_id, summary: row.summary, generatedAt: row.generated_at };
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

    let sql = `WITH RECURSIVE subtree(id) AS (
         SELECT ?
         UNION
         SELECT c.id FROM categories c JOIN subtree s ON c.parent_id = s.id
       )
       SELECT b.* FROM bookmarks b
       WHERE ${where.join(' AND ')}
       ORDER BY b.ingested_at DESC, b.id DESC`;
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
   * Rolled-up counts for a category subtree: total bookmarks and how many are
   * unread. Lets the viewer show accurate totals and page the filtered set
   * without downloading every row.
   */
  getCategoryBookmarkCounts(categoryId: number): { total: number; unread: number } {
    const row = this.db
      .prepare(
        `WITH RECURSIVE subtree(id) AS (
           SELECT ?
           UNION
           SELECT c.id FROM categories c JOIN subtree s ON c.parent_id = s.id
         )
         SELECT
           COUNT(*) AS total,
           COALESCE(SUM(CASE WHEN b.read = 0 THEN 1 ELSE 0 END), 0) AS unread
         FROM bookmarks b
         WHERE b.id IN (
           SELECT bc.bookmark_id FROM bookmark_categories bc
           JOIN subtree s ON s.id = bc.category_id
         )`,
      )
      .get(categoryId) as { total: number; unread: number };
    return { total: row.total, unread: row.unread };
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
   */
  getOrCreateCategory(name: string, parentId: number | null, when: string): CategoryNode {
    const trimmed = name.trim();
    const existing =
      parentId === null
        ? (this.db
            .prepare('SELECT * FROM categories WHERE parent_id IS NULL AND name = ? COLLATE NOCASE')
            .get(trimmed) as CategoryRow | undefined)
        : (this.db
            .prepare('SELECT * FROM categories WHERE parent_id = ? AND name = ? COLLATE NOCASE')
            .get(parentId, trimmed) as CategoryRow | undefined);
    if (existing) return toCategoryNode(existing);

    const info = this.db
      .prepare('INSERT INTO categories (parent_id, name, created_at) VALUES (?, ?, ?)')
      .run(parentId, trimmed, when);
    return { id: Number(info.lastInsertRowid), parentId, name: trimmed, createdAt: when };
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
}
