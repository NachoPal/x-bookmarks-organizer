import fs from 'node:fs';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { SCHEMA_SQL } from './schema';
import type { CategoryNode, RawBookmark, StoredBookmark } from '../types';

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
}

interface CategoryRow {
  id: number;
  parent_id: number | null;
  name: string;
  created_at: string;
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
  };
}

function toCategoryNode(row: CategoryRow): CategoryNode {
  return { id: row.id, parentId: row.parent_id, name: row.name, createdAt: row.created_at };
}

const MARKER_KEY = 'newest_seen_post_id';
const REFRESH_TOKEN_KEY = 'x_refresh_token';

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
  }

  close(): void {
    this.db.close();
  }

  // --- Bookmarks ---------------------------------------------------------

  /** Post ids already stored. Used as the incremental "already seen" signal. */
  getKnownPostIds(): Set<string> {
    const rows = this.db.prepare('SELECT post_id FROM bookmarks').all() as { post_id: string }[];
    return new Set(rows.map((r) => r.post_id));
  }

  getBookmarkByPostId(postId: string): StoredBookmark | undefined {
    const row = this.db.prepare('SELECT * FROM bookmarks WHERE post_id = ?').get(postId) as
      | BookmarkRow
      | undefined;
    return row ? toStoredBookmark(row) : undefined;
  }

  getBookmarkById(id: number): StoredBookmark | undefined {
    const row = this.db.prepare('SELECT * FROM bookmarks WHERE id = ?').get(id) as
      | BookmarkRow
      | undefined;
    return row ? toStoredBookmark(row) : undefined;
  }

  /** Direct bookmarks of a category, newest-ingested first. */
  getBookmarksForCategory(categoryId: number): StoredBookmark[] {
    const rows = this.db
      .prepare(
        `SELECT b.* FROM bookmarks b
         JOIN bookmark_categories bc ON bc.bookmark_id = b.id
         WHERE bc.category_id = ?
         ORDER BY b.ingested_at DESC, b.id DESC`,
      )
      .all(categoryId) as BookmarkRow[];
    return rows.map(toStoredBookmark);
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

  // --- Categories --------------------------------------------------------

  getAllCategories(): CategoryNode[] {
    const rows = this.db.prepare('SELECT * FROM categories ORDER BY id').all() as CategoryRow[];
    return rows.map(toCategoryNode);
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
        for (const categoryId of categoryIds) {
          this.linkBookmarkToCategory(bookmarkId, categoryId);
        }
      }
    });
    tx(batch);
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

  // --- Counts (raw, per node) -------------------------------------------

  /** Map of category id -> { direct total, direct unread } for that node only. */
  getDirectCounts(): Map<number, { total: number; unread: number }> {
    const rows = this.db
      .prepare(
        `SELECT bc.category_id AS category_id,
                COUNT(*) AS total,
                SUM(CASE WHEN b.read = 0 THEN 1 ELSE 0 END) AS unread
         FROM bookmark_categories bc
         JOIN bookmarks b ON b.id = bc.bookmark_id
         GROUP BY bc.category_id`,
      )
      .all() as { category_id: number; total: number; unread: number }[];
    const map = new Map<number, { total: number; unread: number }>();
    for (const r of rows) {
      map.set(r.category_id, { total: r.total, unread: r.unread });
    }
    return map;
  }
}
