import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from './database';
import type { RawBookmark } from '../types';

function bookmark(postId: string, overrides: Partial<RawBookmark> = {}): RawBookmark {
  return {
    postId,
    authorUsername: 'alice',
    authorName: 'Alice',
    text: `text for ${postId}`,
    url: `https://x.com/alice/status/${postId}`,
    postCreatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('Database', () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(':memory:');
  });
  afterEach(() => {
    db.close();
  });

  it('creates a schema and starts empty', () => {
    expect(db.getKnownPostIds().size).toBe(0);
    expect(db.getAllCategories()).toHaveLength(0);
  });

  describe('getOrCreateCategory', () => {
    it('reuses an existing node instead of duplicating it', () => {
      const when = new Date().toISOString();
      const a1 = db.getOrCreateCategory('AI', null, when);
      const a2 = db.getOrCreateCategory('AI', null, when);
      expect(a2.id).toBe(a1.id);
      expect(db.getAllCategories()).toHaveLength(1);
    });

    it('matches names case-insensitively and trims whitespace', () => {
      const when = new Date().toISOString();
      const a1 = db.getOrCreateCategory('AI', null, when);
      const a2 = db.getOrCreateCategory('  ai ', null, when);
      expect(a2.id).toBe(a1.id);
    });

    it('nests children under the right parent and allows same name under different parents', () => {
      const when = new Date().toISOString();
      const ai = db.getOrCreateCategory('AI', null, when);
      const gamedev = db.getOrCreateCategory('Game Dev', null, when);
      const aiTools = db.getOrCreateCategory('Tools', ai.id, when);
      const gdTools = db.getOrCreateCategory('Tools', gamedev.id, when);
      expect(aiTools.id).not.toBe(gdTools.id);
      expect(aiTools.parentId).toBe(ai.id);
      expect(gdTools.parentId).toBe(gamedev.id);
    });
  });

  describe('markRead', () => {
    it('marks read and records the timestamp only once (idempotent date)', () => {
      db.storeCategorizedBatch([bookmark('1')], () => []);
      const stored = db.getBookmarkByPostId('1')!;
      expect(stored.read).toBe(false);
      expect(stored.readAt).toBeNull();

      const first = db.markRead(stored.id, '2024-05-01T00:00:00.000Z')!;
      expect(first.read).toBe(true);
      expect(first.readAt).toBe('2024-05-01T00:00:00.000Z');

      const second = db.markRead(stored.id, '2024-06-01T00:00:00.000Z')!;
      expect(second.readAt).toBe('2024-05-01T00:00:00.000Z'); // unchanged
    });

    it('returns undefined for an unknown id', () => {
      expect(db.markRead(999)).toBeUndefined();
    });
  });

  describe('markUnread', () => {
    it('clears read and read_at, so the chip can toggle back', () => {
      db.storeCategorizedBatch([bookmark('1')], () => []);
      const stored = db.getBookmarkByPostId('1')!;
      db.markRead(stored.id, '2024-05-01T00:00:00.000Z');

      const cleared = db.markUnread(stored.id)!;
      expect(cleared.read).toBe(false);
      expect(cleared.readAt).toBeNull();

      // Marking read again after an unread starts a fresh read_at, not the old one.
      const reread = db.markRead(stored.id, '2024-07-01T00:00:00.000Z')!;
      expect(reread.readAt).toBe('2024-07-01T00:00:00.000Z');
    });
  });

  describe('deleteBookmark', () => {
    it('removes the bookmark and its category links', () => {
      const when = new Date().toISOString();
      const cat = db.getOrCreateCategory('AI', null, when);
      db.storeCategorizedBatch([bookmark('1'), bookmark('2')], () => [cat.id]);
      const b1 = db.getBookmarkByPostId('1')!;

      expect(db.deleteBookmark(b1.id)).toBe(true);
      expect(db.getBookmarkByPostId('1')).toBeUndefined();
      expect(db.getBookmarksForCategory(cat.id).map((b) => b.postId)).toEqual(['2']);
    });

    it('returns false for an unknown id', () => {
      expect(db.deleteBookmark(999)).toBe(false);
    });

    it('tombstones the post id so it never counts as new again', () => {
      db.storeCategorizedBatch([bookmark('1')], () => []);
      const b1 = db.getBookmarkByPostId('1')!;
      expect(db.getKnownPostIds()).toEqual(new Set(['1']));

      db.deleteBookmark(b1.id);

      // Gone from storage, but still "known" - a later incremental sync must
      // never mistake it for new and re-fetch/re-store it.
      expect(db.getBookmarkByPostId('1')).toBeUndefined();
      expect(db.getKnownPostIds()).toEqual(new Set(['1']));
    });
  });

  describe('storeCategorizedBatch', () => {
    it('stores bookmarks and links them to categories atomically', () => {
      const when = new Date().toISOString();
      const ai = db.getOrCreateCategory('AI', null, when);
      const evals = db.getOrCreateCategory('Evals', ai.id, when);

      db.storeCategorizedBatch([bookmark('1'), bookmark('2')], (bm) =>
        bm.postId === '1' ? [ai.id, evals.id] : [evals.id],
      );

      expect(db.getKnownPostIds()).toEqual(new Set(['1', '2']));
      expect(db.getBookmarksForCategory(evals.id).map((b) => b.postId).sort()).toEqual(['1', '2']);
      // The parent surfaces its own direct bookmark plus its descendants',
      // deduplicated: bm '1' is linked to both AI and Evals but appears once.
      expect(db.getBookmarksForCategory(ai.id).map((b) => b.postId).sort()).toEqual(['1', '2']);
    });

    it('does not duplicate a bookmark that is already stored', () => {
      const when = new Date().toISOString();
      const cat = db.getOrCreateCategory('X', null, when);
      db.storeCategorizedBatch([bookmark('1')], () => [cat.id]);
      db.storeCategorizedBatch([bookmark('1')], () => [cat.id]);
      expect(db.getKnownPostIds().size).toBe(1);
    });
  });

  describe('run state', () => {
    it('persists and reads the newest-seen marker and refresh token', () => {
      db.setNewestSeenPostId('abc');
      expect(db.getNewestSeenPostId()).toBe('abc');
      db.setRefreshToken('rt-1');
      expect(db.getRefreshToken()).toBe('rt-1');
      db.setRefreshToken('rt-2');
      expect(db.getRefreshToken()).toBe('rt-2');
    });

    it('reports no last-sync timestamp until one is set', () => {
      expect(db.getLastSyncedAt()).toBeUndefined();
      db.setLastSyncedAt('2026-09-16T10:00:00.000Z');
      expect(db.getLastSyncedAt()).toBe('2026-09-16T10:00:00.000Z');
      db.setLastSyncedAt('2026-09-17T08:00:00.000Z');
      expect(db.getLastSyncedAt()).toBe('2026-09-17T08:00:00.000Z');
    });
  });

  describe('getDirectMembership', () => {
    it('lists the direct bookmarks of a node with their read flags', () => {
      const when = new Date().toISOString();
      const cat = db.getOrCreateCategory('X', null, when);
      db.storeCategorizedBatch([bookmark('1'), bookmark('2')], () => [cat.id]);
      const b1 = db.getBookmarkByPostId('1')!;
      db.markRead(b1.id);

      const members = db.getDirectMembership().get(cat.id)!;
      expect(members).toHaveLength(2);
      expect(members.find((m) => m.id === b1.id)!.read).toBe(true);
      const b2 = db.getBookmarkByPostId('2')!;
      expect(members.find((m) => m.id === b2.id)!.read).toBe(false);
    });
  });

  describe('getBookmarksForCategory across a subtree', () => {
    it('returns a node and its descendants, deduplicated by bookmark id', () => {
      const when = new Date().toISOString();
      const ai = db.getOrCreateCategory('AI', null, when);
      const evals = db.getOrCreateCategory('Evals', ai.id, when);
      const harnesses = db.getOrCreateCategory('Harnesses', ai.id, when);
      // bm '1' lives in two sibling branches under AI; it must appear once.
      db.storeCategorizedBatch([bookmark('1'), bookmark('2')], (bm) =>
        bm.postId === '1' ? [evals.id, harnesses.id] : [harnesses.id],
      );

      expect(db.getBookmarksForCategory(ai.id).map((b) => b.postId).sort()).toEqual(['1', '2']);
      expect(db.getBookmarksForCategory(evals.id).map((b) => b.postId)).toEqual(['1']);
    });
  });

  describe('getCategoryIdsForBookmarks', () => {
    it('maps each bookmark to the categories it is directly filed under', () => {
      const when = new Date().toISOString();
      const ai = db.getOrCreateCategory('AI', null, when);
      const evals = db.getOrCreateCategory('Evals', ai.id, when);
      const harnesses = db.getOrCreateCategory('Harnesses', ai.id, when);
      db.storeCategorizedBatch([bookmark('1'), bookmark('2')], (bm) =>
        bm.postId === '1' ? [evals.id, harnesses.id] : [harnesses.id],
      );
      const b1 = db.getBookmarkByPostId('1')!;
      const b2 = db.getBookmarkByPostId('2')!;

      const map = db.getCategoryIdsForBookmarks([b1.id, b2.id]);
      expect(map.get(b1.id)?.sort()).toEqual([evals.id, harnesses.id].sort());
      expect(map.get(b2.id)).toEqual([harnesses.id]);
    });

    it('returns an empty map for an empty input', () => {
      expect(db.getCategoryIdsForBookmarks([])).toEqual(new Map());
    });
  });

  describe('paging and counts for the viewer', () => {
    function seedEvals(count: number, readCount = 0) {
      const when = new Date().toISOString();
      const ai = db.getOrCreateCategory('AI', null, when);
      const evals = db.getOrCreateCategory('Evals', ai.id, when);
      const batch = Array.from({ length: count }, (_, i) => bookmark(String(i + 1)));
      db.storeCategorizedBatch(batch, () => [evals.id]);
      for (let i = 1; i <= readCount; i++) db.markRead(db.getBookmarkByPostId(String(i))!.id);
      return evals.id;
    }

    it('limits and offsets a subtree page without shipping everything', () => {
      const id = seedEvals(25);
      const first = db.getBookmarksForCategory(id, { limit: 20, offset: 0 });
      const second = db.getBookmarksForCategory(id, { limit: 20, offset: 20 });
      expect(first).toHaveLength(20);
      expect(second).toHaveLength(5);
      // Pages are disjoint and together cover the whole set.
      const ids = new Set([...first, ...second].map((b) => b.id));
      expect(ids.size).toBe(25);
    });

    it('filters a page by read state', () => {
      const id = seedEvals(25, 10);
      const unread = db.getBookmarksForCategory(id, { filter: 'unread', limit: 100 });
      const read = db.getBookmarksForCategory(id, { filter: 'read', limit: 100 });
      expect(unread).toHaveLength(15);
      expect(unread.every((b) => b.read === false)).toBe(true);
      expect(read).toHaveLength(10);
      expect(read.every((b) => b.read === true)).toBe(true);
    });

    it('reports rolled-up total and unread counts for a subtree', () => {
      const id = seedEvals(25, 10);
      expect(db.getCategoryBookmarkCounts(id)).toEqual({ total: 25, unread: 15 });
    });

    it('with no options still returns the whole subtree (back-compat)', () => {
      const id = seedEvals(3);
      expect(db.getBookmarksForCategory(id)).toHaveLength(3);
    });
  });

  describe('article reader cache', () => {
    function seedBookmark(): number {
      db.storeCategorizedBatch([bookmark('1')], () => []);
      return db.getBookmarkByPostId('1')!.id;
    }

    it('has no cached article for a bookmark until one is saved', () => {
      const id = seedBookmark();
      expect(db.getArticleForBookmark(id)).toBeUndefined();
    });

    it('round-trips a successful extraction', () => {
      const id = seedBookmark();
      db.saveArticle({
        bookmarkId: id,
        url: 'https://example.com/article',
        status: 'ok',
        title: 'A Great Article',
        contentHtml: '<p>Body</p>',
        excerpt: 'Body',
        siteName: 'Example',
        reason: null,
        fetchedAt: '2026-09-17T00:00:00.000Z',
      });
      expect(db.getArticleForBookmark(id)).toEqual({
        bookmarkId: id,
        url: 'https://example.com/article',
        status: 'ok',
        title: 'A Great Article',
        contentHtml: '<p>Body</p>',
        excerpt: 'Body',
        siteName: 'Example',
        reason: null,
        fetchedAt: '2026-09-17T00:00:00.000Z',
      });
    });

    it('round-trips a failed extraction', () => {
      const id = seedBookmark();
      db.saveArticle({
        bookmarkId: id,
        url: 'https://example.com/dead',
        status: 'failed',
        title: null,
        contentHtml: null,
        excerpt: null,
        siteName: null,
        reason: 'The page returned an error (HTTP 404).',
        fetchedAt: '2026-09-17T00:00:00.000Z',
      });
      const cached = db.getArticleForBookmark(id);
      expect(cached?.status).toBe('failed');
      expect(cached?.reason).toBe('The page returned an error (HTTP 404).');
    });

    it('overwrites the previous record for the same bookmark rather than duplicating it', () => {
      const id = seedBookmark();
      db.saveArticle({
        bookmarkId: id,
        url: 'https://example.com/a',
        status: 'failed',
        title: null,
        contentHtml: null,
        excerpt: null,
        siteName: null,
        reason: 'first attempt failed',
        fetchedAt: '2026-09-17T00:00:00.000Z',
      });
      db.saveArticle({
        bookmarkId: id,
        url: 'https://example.com/a',
        status: 'ok',
        title: 'Now it works',
        contentHtml: '<p>Body</p>',
        excerpt: null,
        siteName: null,
        reason: null,
        fetchedAt: '2026-09-17T01:00:00.000Z',
      });
      expect(db.getArticleForBookmark(id)?.status).toBe('ok');
      expect(db.getArticleForBookmark(id)?.title).toBe('Now it works');
    });

    it('deletes the cached article when its bookmark is deleted (cascade)', () => {
      const id = seedBookmark();
      db.saveArticle({
        bookmarkId: id,
        url: 'https://example.com/a',
        status: 'ok',
        title: 'T',
        contentHtml: '<p>T</p>',
        excerpt: null,
        siteName: null,
        reason: null,
        fetchedAt: '2026-09-17T00:00:00.000Z',
      });
      db.deleteBookmark(id);
      expect(db.getArticleForBookmark(id)).toBeUndefined();
    });
  });

  describe('article link metadata cache (categorization input, issue #25)', () => {
    it('has no cached metadata for a url until one is saved', () => {
      expect(db.getArticleLinkMetadata('https://example.com/article')).toBeUndefined();
    });

    it('round-trips a successful fetch, keyed by url with no bookmark required', () => {
      db.saveArticleLinkMetadata({
        url: 'https://example.com/article',
        status: 'ok',
        title: 'A Great Article',
        description: 'A short summary',
        image: 'https://example.com/cover.png',
        siteName: 'Example',
        resolvedUrl: 'https://example.com/article',
        fetchedAt: '2026-09-17T00:00:00.000Z',
      });
      expect(db.getArticleLinkMetadata('https://example.com/article')).toEqual({
        url: 'https://example.com/article',
        status: 'ok',
        title: 'A Great Article',
        description: 'A short summary',
        image: 'https://example.com/cover.png',
        siteName: 'Example',
        resolvedUrl: 'https://example.com/article',
        fetchedAt: '2026-09-17T00:00:00.000Z',
      });
    });

    it('round-trips a failed fetch', () => {
      db.saveArticleLinkMetadata({
        url: 'https://example.com/dead',
        status: 'failed',
        title: null,
        description: null,
        image: null,
        siteName: null,
        resolvedUrl: null,
        fetchedAt: '2026-09-17T00:00:00.000Z',
      });
      expect(db.getArticleLinkMetadata('https://example.com/dead')?.status).toBe('failed');
    });

    it('overwrites the previous record for the same url rather than duplicating it', () => {
      db.saveArticleLinkMetadata({
        url: 'https://example.com/a',
        status: 'failed',
        title: null,
        description: null,
        image: null,
        siteName: null,
        resolvedUrl: null,
        fetchedAt: '2026-09-17T00:00:00.000Z',
      });
      db.saveArticleLinkMetadata({
        url: 'https://example.com/a',
        status: 'ok',
        title: 'Now it works',
        description: null,
        image: null,
        siteName: null,
        resolvedUrl: 'https://example.com/a',
        fetchedAt: '2026-09-17T01:00:00.000Z',
      });
      expect(db.getArticleLinkMetadata('https://example.com/a')?.status).toBe('ok');
      expect(db.getArticleLinkMetadata('https://example.com/a')?.title).toBe('Now it works');
    });

    it('round-trips a card-only record (preview card, no readable body - issue #45)', () => {
      db.saveArticleLinkMetadata({
        url: 'https://t.co/abc',
        status: 'card',
        title: 'A Tool, Not An Article',
        description: 'Short pitch.',
        image: null,
        siteName: 'Tool',
        resolvedUrl: 'https://tool.example.com/',
        fetchedAt: '2026-09-17T00:00:00.000Z',
      });
      const record = db.getArticleLinkMetadata('https://t.co/abc');
      expect(record?.status).toBe('card');
      expect(record?.resolvedUrl).toBe('https://tool.example.com/');
    });

    it('migrates a database created before image/siteName/resolvedUrl existed (issues #26/#45) without losing data', () => {
      const dbPath = path.join(os.tmpdir(), `xbookmarks-migration-test-${Date.now()}-${Math.random()}.db`);
      try {
        // Simulate a pre-#26 database: the original article_link_metadata
        // shape, with no `image`/`site_name` columns, already holding a row.
        const raw = new BetterSqlite3(dbPath);
        raw.exec(`
          CREATE TABLE article_link_metadata (
            url         TEXT PRIMARY KEY,
            status      TEXT NOT NULL,
            title       TEXT,
            description TEXT,
            fetched_at  TEXT NOT NULL
          );
        `);
        raw
          .prepare(
            `INSERT INTO article_link_metadata (url, status, title, description, fetched_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run('https://example.com/pre-existing', 'ok', 'Pre-existing Title', 'Pre-existing summary', '2026-01-01T00:00:00.000Z');
        raw.close();

        const migrated = new Database(dbPath);
        try {
          // The pre-existing row survived, with the new columns defaulting to null.
          expect(migrated.getArticleLinkMetadata('https://example.com/pre-existing')).toEqual({
            url: 'https://example.com/pre-existing',
            status: 'ok',
            title: 'Pre-existing Title',
            description: 'Pre-existing summary',
            image: null,
            siteName: null,
            resolvedUrl: null,
            fetchedAt: '2026-01-01T00:00:00.000Z',
          });

          // The new columns are now writable, and re-opening again is a no-op.
          migrated.saveArticleLinkMetadata({
            url: 'https://example.com/new',
            status: 'ok',
            title: 'New',
            description: null,
            image: 'https://example.com/new.png',
            siteName: 'Example',
            resolvedUrl: 'https://example.com/new',
            fetchedAt: '2026-01-02T00:00:00.000Z',
          });
          expect(migrated.getArticleLinkMetadata('https://example.com/new')?.image).toBe(
            'https://example.com/new.png',
          );
        } finally {
          migrated.close();
        }
        const reopened = new Database(dbPath);
        try {
          expect(reopened.getArticleLinkMetadata('https://example.com/new')?.siteName).toBe('Example');
        } finally {
          reopened.close();
        }
      } finally {
        for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
          try {
            fs.rmSync(f);
          } catch {
            /* not present */
          }
        }
      }
    });
  });
});

describe('Summary cache', () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(':memory:');
  });
  afterEach(() => {
    db.close();
  });

  function seedBookmarks(): { id1: number; id2: number } {
    db.storeCategorizedBatch([bookmark('1'), bookmark('2')], () => []);
    const id1 = db.getBookmarkByPostId('1')!.id;
    const id2 = db.getBookmarkByPostId('2')!.id;
    return { id1, id2 };
  }

  describe('getSummarizedBookmarkIds', () => {
    it('returns only the ids that have a saved summary', () => {
      const { id1, id2 } = seedBookmarks();
      db.saveSummary({ bookmarkId: id1, summary: 'A summary.', generatedAt: new Date().toISOString() });

      const summarized = db.getSummarizedBookmarkIds([id1, id2]);
      expect(summarized.has(id1)).toBe(true);
      expect(summarized.has(id2)).toBe(false);
    });

    it('returns an empty set for an empty input, without querying', () => {
      expect(db.getSummarizedBookmarkIds([])).toEqual(new Set());
    });
  });

  describe('clearSummaries', () => {
    it('deletes every saved summary and reports how many were removed', () => {
      const { id1, id2 } = seedBookmarks();
      db.saveSummary({ bookmarkId: id1, summary: 'One.', generatedAt: new Date().toISOString() });
      db.saveSummary({ bookmarkId: id2, summary: 'Two.', generatedAt: new Date().toISOString() });

      expect(db.clearSummaries()).toBe(2);
      expect(db.getSummaryForBookmark(id1)).toBeUndefined();
      expect(db.getSummaryForBookmark(id2)).toBeUndefined();
    });

    it('is idempotent - a second run removes 0', () => {
      const { id1 } = seedBookmarks();
      db.saveSummary({ bookmarkId: id1, summary: 'One.', generatedAt: new Date().toISOString() });

      db.clearSummaries();
      expect(db.clearSummaries()).toBe(0);
    });
  });
});

describe('Database X-native Articles', () => {
  const article = {
    restId: '777',
    title: 'An X Article',
    previewText: 'Preview text',
    plainText: 'Full body',
    coverUrl: 'https://pbs.twimg.com/media/c.jpg',
    coverWidth: 1500,
    coverHeight: 600,
  };

  it('stores a bookmark\'s own and quoted Article atomically with the bookmark', () => {
    const db = new Database(':memory:');
    try {
      const cat = db.getOrCreateCategory('AI', null, new Date().toISOString());
      db.storeCategorizedBatch(
        [
          bookmark('1', { xArticle: article }),
          bookmark('2', { quotedPostId: '99', quotedXArticle: { ...article, restId: '888', title: 'Quoted' } }),
          bookmark('3'),
        ],
        () => [cat.id],
      );
      expect(db.getXArticle('1')).toEqual(article);
      expect(db.getXArticle('99')?.title).toBe('Quoted');
      expect(db.getBookmarkByPostId('2')?.quotedPostId).toBe('99');

      const map = db.getXArticlesForBookmarks(db.getAllBookmarks());
      expect(map.get('1')).toEqual({ article, postId: '1', quoted: false });
      expect(map.get('2')).toMatchObject({ postId: '99', quoted: true });
      expect(map.has('3')).toBe(false);

      // Re-storing without Article data (e.g. recategorize) keeps what is stored.
      db.storeCategorizedBatch([bookmark('1')], () => [cat.id]);
      expect(db.getXArticle('1')).toEqual(article);
    } finally {
      db.close();
    }
  });

  it('migrates a pre-existing bookmarks table (adds quoted_post_id) idempotently, keeping its rows', () => {
    const dbPath = path.join(os.tmpdir(), `xbookmarks-xarticle-migration-${Date.now()}-${Math.random()}.db`);
    try {
      const raw = new BetterSqlite3(dbPath);
      raw.exec(`
        CREATE TABLE bookmarks (
          id INTEGER PRIMARY KEY AUTOINCREMENT, post_id TEXT NOT NULL UNIQUE,
          author_username TEXT NOT NULL DEFAULT '', author_name TEXT NOT NULL DEFAULT '',
          text TEXT NOT NULL DEFAULT '', url TEXT NOT NULL, post_created_at TEXT NOT NULL DEFAULT '',
          ingested_at TEXT NOT NULL, read INTEGER NOT NULL DEFAULT 0, read_at TEXT
        );
      `);
      raw
        .prepare(`INSERT INTO bookmarks (post_id, url, ingested_at) VALUES ('old', 'https://x.com/a/status/old', '2026-01-01')`)
        .run();
      raw.close();

      const first = new Database(dbPath);
      expect(first.getBookmarkByPostId('old')?.quotedPostId).toBeNull();
      first.setQuotedPostId('old', '42');
      first.saveXArticle('42', article);
      first.close();

      const second = new Database(dbPath); // re-opening re-runs the guarded migration: a no-op
      try {
        expect(second.getBookmarkByPostId('old')?.quotedPostId).toBe('42');
        expect(second.getXArticle('42')).toEqual(article);
      } finally {
        second.close();
      }
    } finally {
      for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        try {
          fs.rmSync(f);
        } catch {
          /* not present */
        }
      }
    }
  });
});
