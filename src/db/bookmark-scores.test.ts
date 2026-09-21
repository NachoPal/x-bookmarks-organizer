import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from './database';
import type { BookmarkScoreRecord, RawBookmark } from '../types';

function bookmark(postId: string): RawBookmark {
  return {
    postId,
    authorUsername: 'alice',
    authorName: 'Alice',
    text: `text for ${postId}`,
    url: `https://x.com/alice/status/${postId}`,
    postCreatedAt: '2024-01-01T00:00:00.000Z',
  };
}

function record(bookmarkId: number, overrides: Partial<BookmarkScoreRecord> = {}): BookmarkScoreRecord {
  return {
    bookmarkId,
    score: 0.5,
    confidence: 0.7,
    dimensions: { learning_value: 0.5 },
    model: 'jev-1.13.0',
    rubricVersion: 'v1',
    scoredAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('bookmark_scores storage (issue #62)', () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(':memory:');
  });
  afterEach(() => {
    db.close();
  });

  it('round-trips a score, its confidence and its per-dimension breakdown', () => {
    db.storeCategorizedBatch([bookmark('1')], () => []);
    const id = db.getBookmarkByPostId('1')!.id;
    const saved = record(id, { dimensions: { learning_value: 0.75, durability: 0.5 } });

    db.saveBookmarkScore(saved);

    expect(db.getBookmarkScore(id)).toEqual(saved);
    expect(db.getBookmarkScores([id]).get(id)).toEqual(saved);
    expect(db.countScoredBookmarks()).toBe(1);
  });

  it('replaces an existing row rather than accumulating rows per bookmark', () => {
    db.storeCategorizedBatch([bookmark('1')], () => []);
    const id = db.getBookmarkByPostId('1')!.id;
    db.saveBookmarkScore(record(id, { score: 0.2 }));
    db.saveBookmarkScore(record(id, { score: 0.9, rubricVersion: 'v2' }));

    expect(db.countScoredBookmarks()).toBe(1);
    expect(db.getBookmarkScore(id)).toMatchObject({ score: 0.9, rubricVersion: 'v2' });
  });

  it('has no entry for an unranked bookmark, so an absent score is never read as zero', () => {
    db.storeCategorizedBatch([bookmark('1')], () => []);
    const id = db.getBookmarkByPostId('1')!.id;
    expect(db.getBookmarkScore(id)).toBeUndefined();
    expect(db.getBookmarkScores([id]).size).toBe(0);
    expect(db.getBookmarkScores([]).size).toBe(0);
  });

  it('drops a score with its bookmark', () => {
    db.storeCategorizedBatch([bookmark('1')], () => []);
    const id = db.getBookmarkByPostId('1')!.id;
    db.saveBookmarkScore(record(id));
    db.deleteBookmark(id);
    expect(db.countScoredBookmarks()).toBe(0);
  });

  it('clearBookmarkScores is explicit and idempotent', () => {
    db.storeCategorizedBatch([bookmark('1')], () => []);
    db.saveBookmarkScore(record(db.getBookmarkByPostId('1')!.id));
    expect(db.clearBookmarkScores()).toBe(1);
    expect(db.clearBookmarkScores()).toBe(0);
  });

  it('tolerates a dimensions blob this build cannot read, rather than failing the whole list', () => {
    // A row written by a future (or corrupted) rubric must not take the bookmark
    // list down with it - the score is still readable, just without a breakdown.
    const dbPath = path.join(os.tmpdir(), `xbookmarks-score-blob-${Date.now()}-${Math.random()}.db`);
    try {
      const seed = new Database(dbPath);
      seed.storeCategorizedBatch([bookmark('1')], () => []);
      const id = seed.getBookmarkByPostId('1')!.id;
      seed.saveBookmarkScore(record(id));
      seed.close();

      const raw = new BetterSqlite3(dbPath);
      raw.prepare('UPDATE bookmark_scores SET dimensions = ? WHERE bookmark_id = ?').run('not json', id);
      raw.prepare('UPDATE bookmark_scores SET score = 0.33 WHERE bookmark_id = ?').run(id);
      raw.close();

      const reopened = new Database(dbPath);
      try {
        expect(reopened.getBookmarkScore(id)).toMatchObject({ score: 0.33, dimensions: {} });
      } finally {
        reopened.close();
      }
    } finally {
      for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  describe('getBookmarksToScore', () => {
    beforeEach(() => {
      db.storeCategorizedBatch([bookmark('1')], () => [], '2024-01-01T00:00:00.000Z');
      db.storeCategorizedBatch([bookmark('2')], () => [], '2024-01-02T00:00:00.000Z');
    });

    it('selects unscored bookmarks oldest-first, so an interrupted run resumes in order', () => {
      expect(db.getBookmarksToScore({ rubricVersion: 'v1' }).map((b) => b.postId)).toEqual(['1', '2']);
    });

    it('skips a bookmark already scored under the same rubric', () => {
      db.saveBookmarkScore(record(db.getBookmarkByPostId('1')!.id));
      expect(db.getBookmarksToScore({ rubricVersion: 'v1' }).map((b) => b.postId)).toEqual(['2']);
    });

    it('re-selects a bookmark scored under a DIFFERENT rubric version', () => {
      db.saveBookmarkScore(record(db.getBookmarkByPostId('1')!.id, { rubricVersion: 'v0' }));
      expect(db.getBookmarksToScore({ rubricVersion: 'v1' }).map((b) => b.postId)).toEqual(['1', '2']);
    });

    it('returns everything with rescoreAll, and honors a limit', () => {
      db.saveBookmarkScore(record(db.getBookmarkByPostId('1')!.id));
      db.saveBookmarkScore(record(db.getBookmarkByPostId('2')!.id));
      expect(db.getBookmarksToScore({ rubricVersion: 'v1' })).toHaveLength(0);
      expect(db.getBookmarksToScore({ rubricVersion: 'v1', rescoreAll: true })).toHaveLength(2);
      expect(
        db.getBookmarksToScore({ rubricVersion: 'v1', rescoreAll: true, limit: 1 }).map((b) => b.postId),
      ).toEqual(['1']);
    });
  });

  describe('sorting a category by score', () => {
    let categoryId: number;
    beforeEach(() => {
      categoryId = db.getOrCreateCategory('AI', null, '2024-01-01T00:00:00.000Z').id;
      db.storeCategorizedBatch([bookmark('low')], () => [categoryId], '2024-01-01T00:00:00.000Z');
      db.storeCategorizedBatch([bookmark('high')], () => [categoryId], '2024-01-02T00:00:00.000Z');
      db.storeCategorizedBatch([bookmark('none')], () => [categoryId], '2024-01-03T00:00:00.000Z');
      db.saveBookmarkScore(record(db.getBookmarkByPostId('low')!.id, { score: 0.1 }));
      db.saveBookmarkScore(record(db.getBookmarkByPostId('high')!.id, { score: 0.9 }));
    });

    it('defaults to recency, untouched by any stored score', () => {
      expect(db.getBookmarksForCategory(categoryId).map((b) => b.postId)).toEqual([
        'none',
        'high',
        'low',
      ]);
    });

    it('orders by score descending and puts the UNSCORED bookmark last, not first', () => {
      // Sorting an unscored bookmark as a zero would claim it was judged
      // worthless; it was never judged at all.
      expect(db.getBookmarksForCategory(categoryId, { sort: 'score' }).map((b) => b.postId)).toEqual([
        'high',
        'low',
        'none',
      ]);
    });

    it('pages the score-ordered set server-side, consistently across pages', () => {
      const first = db.getBookmarksForCategory(categoryId, { sort: 'score', offset: 0, limit: 2 });
      const second = db.getBookmarksForCategory(categoryId, { sort: 'score', offset: 2, limit: 2 });
      expect(first.map((b) => b.postId)).toEqual(['high', 'low']);
      expect(second.map((b) => b.postId)).toEqual(['none']);
    });

    it('combines with the read-state filter', () => {
      db.markRead(db.getBookmarkByPostId('high')!.id);
      expect(
        db.getBookmarksForCategory(categoryId, { sort: 'score', filter: 'unread' }).map((b) => b.postId),
      ).toEqual(['low', 'none']);
    });

    it('flips to lowest-first on dir=asc, and STILL leaves the unscored one last', () => {
      // Issue #97. An absent score means never ranked, which is not a low
      // score - asking for the lowest scores first must not float it to the
      // top as if the model had judged it worst of all.
      expect(
        db.getBookmarksForCategory(categoryId, { sort: 'score', dir: 'asc' }).map((b) => b.postId),
      ).toEqual(['low', 'high', 'none']);
    });

    it('pages the ascending score order consistently too', () => {
      const first = db.getBookmarksForCategory(categoryId, { sort: 'score', dir: 'asc', offset: 0, limit: 2 });
      const second = db.getBookmarksForCategory(categoryId, { sort: 'score', dir: 'asc', offset: 2, limit: 2 });
      expect(first.map((b) => b.postId)).toEqual(['low', 'high']);
      expect(second.map((b) => b.postId)).toEqual(['none']);
    });

    it('reverses recency on dir=asc, and leaves it alone on the default', () => {
      expect(
        db.getBookmarksForCategory(categoryId, { sort: 'recent', dir: 'asc' }).map((b) => b.postId),
      ).toEqual(['low', 'high', 'none']);
      expect(
        db.getBookmarksForCategory(categoryId, { sort: 'recent', dir: 'desc' }).map((b) => b.postId),
      ).toEqual(['none', 'high', 'low']);
    });
  });

  it('adds bookmark_scores to a database that predates it, idempotently and without losing data', () => {
    const dbPath = path.join(os.tmpdir(), `xbookmarks-score-migration-${Date.now()}-${Math.random()}.db`);
    try {
      // A database shaped like one from before this feature: no bookmark_scores.
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
        .prepare(
          `INSERT INTO bookmarks (post_id, url, ingested_at) VALUES ('old', 'https://x.com/a/status/old', '2026-01-01')`,
        )
        .run();
      raw.close();

      const first = new Database(dbPath);
      const old = first.getBookmarkByPostId('old')!;
      expect(first.getBookmarkScore(old.id)).toBeUndefined();
      first.saveBookmarkScore(record(old.id, { score: 0.42 }));
      first.close();

      // Re-opening re-applies the same idempotent DDL: a no-op that keeps the row.
      const second = new Database(dbPath);
      try {
        expect(second.getBookmarkScore(old.id)).toMatchObject({ score: 0.42 });
        expect(second.getBookmarkByPostId('old')!.postId).toBe('old');
        const raw2 = new BetterSqlite3(dbPath);
        try {
          const tables = raw2
            .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'bookmark_scores'`)
            .all() as { name: string }[];
          expect(tables).toHaveLength(1); // created exactly once
        } finally {
          raw2.close();
        }
      } finally {
        second.close();
      }
    } finally {
      for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });
});
