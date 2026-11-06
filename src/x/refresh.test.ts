import BetterSqlite3 from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../db/database';
import type { RawBookmark } from '../types';
import { mapBookmarks } from './article';
import type { BookmarkPage, XClient } from './client';
import { mediaFixturePage } from './media.fixtures';
import { X_OWNED_READ_USD, X_POST_READ_USD, bookmarkReadCost } from './pricing';
import { estimateRefresh, refreshBookmarks } from './refresh';

const WHEN = '2026-09-01T00:00:00.000Z';

/** A stored copy as an older sync left it: no media, an older text. */
const stale = (postId: string, extra: Partial<RawBookmark> = {}): RawBookmark => ({
  postId,
  authorUsername: 'alice',
  authorName: 'Alice',
  text: `stale ${postId}`,
  url: `https://x.com/alice/status/${postId}`,
  postCreatedAt: '2026-10-01T10:00:00.000Z',
  ...extra,
});

/** A fake X that serves the fixture page, split into pages of `pageSize`, recording every request. */
function fakeX(pageSize = 100) {
  const page = mediaFixturePage();
  const all = mapBookmarks(page.data, page.includes, () => {}, { own: true, quoted: true });
  const requests: { token?: string; maxResults?: number }[] = [];
  const client: XClient = {
    async fetchBookmarksPage(token, options = {}): Promise<BookmarkPage> {
      requests.push({ token, maxResults: options.maxResults });
      const start = token ? Number(token) : 0;
      const size = Math.min(pageSize, options.maxResults ?? 100);
      const end = start + size;
      return { bookmarks: all.slice(start, end), nextToken: end < all.length ? String(end) : undefined };
    },
  };
  return { client, requests };
}

/** Everything the refresh must leave alone, read straight from SQLite. */
function ownerSnapshot(file: string) {
  const raw = new BetterSqlite3(file, { readonly: true });
  const q = (sql: string) => raw.prepare(sql).all();
  const snap = {
    bookmarkOwnerFields: q('SELECT id, post_id, ingested_at, read, read_at, favorite FROM bookmarks ORDER BY id'),
    categories: q('SELECT * FROM categories ORDER BY id'),
    links: q('SELECT * FROM bookmark_categories ORDER BY bookmark_id, category_id'),
    lists: q('SELECT * FROM assistant_lists ORDER BY id'),
    listItems: q('SELECT * FROM assistant_list_items ORDER BY list_id, bookmark_id'),
    scores: q('SELECT * FROM bookmark_scores ORDER BY bookmark_id'),
    summaries: q('SELECT * FROM summaries ORDER BY bookmark_id'),
    tombstones: q('SELECT * FROM deleted_bookmarks ORDER BY post_id'),
  };
  raw.close();
  return snap;
}

describe('refreshBookmarks (in place, never a reset)', () => {
  let dir: string;
  let file: string;
  let db: Database;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbo-refresh-'));
    file = path.join(dir, 'lib.db');
    db = new Database(file);
    // Three of the fixture's four posts are stored; the fourth (…004) is
    // deleted in the app; (…003) is stored with the owner's state on it.
    db.storeCategorizedBatch(
      [stale('1900000000000000001'), stale('1900000000000000002'), stale('1900000000000000003'), stale('1900000000000000004')],
      () => [],
      WHEN,
    );
    const ids = Object.fromEntries(db.getAllBookmarks().map((b) => [b.postId, b.id]));
    const mine = db.createCategory('My research', null, WHEN)!;
    const generated = db.getOrCreateCategory('AI', null, WHEN);
    db.linkBookmarkToCategory(ids['1900000000000000001']!, mine.id);
    db.linkBookmarkToCategory(ids['1900000000000000003']!, generated.id);
    db.markRead(ids['1900000000000000001']!, WHEN);
    db.setFavorite(ids['1900000000000000003']!, true);
    db.createAssistantList({ title: 'Saved', note: 'n', bookmarkIds: [ids['1900000000000000003']!] }, WHEN);
    db.saveBookmarkScore({
      bookmarkId: ids['1900000000000000001']!,
      score: 0.7,
      confidence: 0.9,
      dimensions: { depth: 0.7 },
      model: 'jev',
      rubricVersion: 'v1',
      scoredAt: WHEN,
    });
    db.saveSummary({ bookmarkId: ids['1900000000000000003']!, summary: 'Mine.', generatedAt: WHEN });
    db.deleteBookmark(ids['1900000000000000004']!, WHEN);
  });
  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('updates X data and media while every owner field stays byte-identical', async () => {
    const before = ownerSnapshot(file);
    const { client } = fakeX();
    const summary = await refreshBookmarks(db, client, { scope: 'all' });

    expect(ownerSnapshot(file)).toEqual(before);
    expect(summary).toMatchObject({ refreshed: 3, skippedDeleted: 1, notStored: 0, imagesFound: 4 });
    expect(db.getBookmarkByPostId('1900000000000000001')!.text).toBe('Two charts from the paper https://t.co/abc');
    expect(db.getBookmarkByPostId('1900000000000000003')!.authorUsername).toBe('bob');
    const images = db.getBookmarkImages([db.getBookmarkByPostId('1900000000000000002')!]).get('1900000000000000002')!;
    expect(images.map((i) => [i.source, i.mediaKey])).toEqual([['quoted-post', '3_301']]);
    expect(summary.mediaPostIds.sort()).toEqual(['1800000000000000009', '1900000000000000001', '1900000000000000003']);
  });

  it('never re-adds a post the owner deleted, nor adds one that is not stored', async () => {
    db.deleteBookmark(db.getBookmarkByPostId('1900000000000000002')!.id, WHEN);
    const { client } = fakeX();
    const summary = await refreshBookmarks(db, client, { scope: 'all' });
    expect(summary.skippedDeleted).toBe(2);
    expect(db.getBookmarkByPostId('1900000000000000002')).toBeUndefined();
    expect(db.getBookmarkByPostId('1900000000000000004')).toBeUndefined();
    expect(db.getKnownPostIds().has('1900000000000000004')).toBe(true);
  });

  it('the test scope reads one page of at most 10, and nothing more', async () => {
    const { client, requests } = fakeX(2);
    const summary = await refreshBookmarks(db, client, { scope: 'newest' });
    expect(requests).toEqual([{ token: undefined, maxResults: 10 }]);
    expect(summary.pagesRead).toBe(1);
  });

  it('the full scope pages until every stored bookmark has been seen', async () => {
    const { client, requests } = fakeX(1);
    const summary = await refreshBookmarks(db, client, { scope: 'all' });
    // Stored: …001, …002, …003 - all seen by the third page; the fourth (deleted) is never paid for.
    expect(requests.map((r) => r.token)).toEqual([undefined, '1', '2']);
    expect(summary.postsRead).toBe(3);
  });

  it('keeps stored text when X returns a post without its author or text', async () => {
    const client: XClient = {
      async fetchBookmarksPage() {
        return {
          bookmarks: [
            { ...stale('1900000000000000001'), authorUsername: 'i', authorName: '', text: '', url: 'https://x.com/i/status/1' },
          ],
        };
      },
    };
    await refreshBookmarks(db, client, { scope: 'newest' });
    const stored = db.getBookmarkByPostId('1900000000000000001')!;
    expect([stored.authorUsername, stored.text, stored.url]).toEqual([
      'alice',
      'stale 1900000000000000001',
      'https://x.com/alice/status/1900000000000000001',
    ]);
  });
});

describe('estimateRefresh', () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(':memory:');
  });
  afterEach(() => db.close());

  it('prices owned reads, with each known quote as a possible non-owned read', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      stale(String(1000 + i), i % 3 === 0 ? { quotedPostId: `q${i}` } : {}),
    );
    db.storeCategorizedBatch(many, () => [], WHEN);
    db.deleteBookmark(db.getBookmarkByPostId('1001')!.id, WHEN);

    const all = estimateRefresh(db, 'all');
    expect(all).toMatchObject({ posts: 29, maxPostsRead: 30, quoted: 10 });
    expect(all.cost.low).toBeCloseTo(29 * X_OWNED_READ_USD);
    expect(all.cost.high).toBeCloseTo(30 * X_OWNED_READ_USD + 10 * X_POST_READ_USD);

    const test = estimateRefresh(db, 'newest');
    expect(test).toMatchObject({ posts: 10, maxPostsRead: 10 });
    expect(test.cost.low).toBeCloseTo(10 * X_OWNED_READ_USD);
    expect(test.cost.high).toBeCloseTo(10 * X_OWNED_READ_USD + test.quoted * X_POST_READ_USD);
  });

  it("matches the owner's ~303-bookmark library at about $0.30-$0.80", () => {
    // ~1 in 3 bookmarks a quote, as in the estimate the refresh was agreed on.
    const cost = bookmarkReadCost(303, 100);
    expect(cost.low).toBeCloseTo(0.303);
    expect(cost.high).toBeCloseTo(0.803);
  });

  it('a small library tests on what it has', () => {
    db.storeCategorizedBatch([stale('1'), stale('2')], () => [], WHEN);
    expect(estimateRefresh(db, 'newest')).toMatchObject({ posts: 2, maxPostsRead: 2 });
  });
});
