import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from './database';
import { SEARCH_INDEX_VERSION, SEARCH_INDEX_VERSION_KEY } from './search';
import type { PostMedia, RawBookmark } from '../types';

const WHEN = '2026-10-01T00:00:00.000Z';

const photo = (mediaKey: string, extra: Partial<PostMedia> = {}): PostMedia => ({
  mediaKey,
  type: 'photo',
  url: `https://pbs.twimg.com/media/${mediaKey}.jpg`,
  previewImageUrl: null,
  altText: null,
  width: 100,
  height: 100,
  ...extra,
});

const bm = (postId: string, extra: Partial<RawBookmark> = {}): RawBookmark => ({
  postId,
  authorUsername: `user${postId}`,
  authorName: `User ${postId}`,
  text: `post ${postId}`,
  url: `https://x.com/user${postId}/status/${postId}`,
  postCreatedAt: '2026-09-01T00:00:00.000Z',
  ...extra,
});

const hits = (db: Database, query: string) => db.searchBookmarks({ query, limit: 50 }).hits.map((h) => h.bookmark.postId);

describe('post_media storage', () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(':memory:');
  });
  afterEach(() => db.close());

  it('stores a bookmark\'s media and its quoted post\'s media with the bookmark', () => {
    db.storeCategorizedBatch(
      [bm('1', { media: [photo('a', { altText: 'A chart' })], quotedPostId: 'q1', quotedMedia: [photo('b')] })],
      () => [],
      WHEN,
    );
    const images = db.getBookmarkImages([db.getBookmarkByPostId('1')!]).get('1')!;
    expect(images.map((i) => [i.source, i.mediaKey, i.ocrStatus, i.altText])).toEqual([
      ['post', 'a', 'pending', 'A chart'],
      ['quoted-post', 'b', 'pending', null],
    ]);
  });

  it('marks a video or GIF skipped - only photos are read', () => {
    db.savePostMedia('1', [
      { ...photo('v'), type: 'video', url: null, previewImageUrl: 'https://pbs.twimg.com/p.jpg' },
      { ...photo('g'), type: 'animated_gif', url: null },
    ]);
    expect(db.getMediaForPosts(['1']).get('1')!.map((m) => m.ocrStatus)).toEqual(['skipped', 'skipped']);
  });

  it('keeps OCR text for an unchanged image, restarts it for a changed one, drops a removed one', () => {
    db.savePostMedia('1', [photo('a'), photo('b'), photo('c')], WHEN);
    db.setMediaOcrResult('1', 'a', { status: 'done', text: 'kept text' });
    db.setMediaOcrResult('1', 'b', { status: 'done', text: 'old text' });
    db.savePostMedia('1', [photo('b', { url: 'https://pbs.twimg.com/media/b2.jpg' }), photo('a', { altText: 'new alt' })]);
    const media = db.getMediaForPosts(['1']).get('1')!;
    expect(media.map((m) => [m.mediaKey, m.position, m.ocrStatus, m.ocrText, m.altText])).toEqual([
      ['b', 0, 'pending', null, null],
      ['a', 1, 'done', 'kept text', 'new alt'],
    ]);
  });

  it('never erases stored media when a fetch did not ask for it', () => {
    db.storeCategorizedBatch([bm('1', { media: [photo('a')] })], () => [], WHEN);
    db.storeCategorizedBatch([bm('1')], () => [], WHEN); // e.g. a legacy field set: media undefined
    expect(db.getMediaForPosts(['1']).get('1')).toHaveLength(1);
    db.writeMediaData(bm('1', { media: [] }), WHEN); // X says: no media now
    expect(db.getMediaForPosts(['1']).get('1')).toBeUndefined();
  });

  it('queues only the photos a stored bookmark shows, with bounded retries', () => {
    db.storeCategorizedBatch([bm('1', { media: [photo('a'), photo('b')] })], () => [], WHEN);
    db.savePostMedia('orphan', [photo('z')]); // a post that is not (yet) a bookmark
    const queue = () => db.getOcrQueue({ limit: 10, includeUnavailable: false, maxAttempts: 2 }).map((m) => m.mediaKey);
    expect(queue().sort()).toEqual(['a', 'b']);
    // ...unless the caller names the posts (a sync, before storing them).
    expect(db.getOcrQueue({ limit: 10, postIds: ['orphan'], includeUnavailable: false, maxAttempts: 2 })).toHaveLength(1);

    db.setMediaOcrResult('1', 'a', { status: 'failed', error: 'boom' });
    expect(queue().sort()).toEqual(['a', 'b']); // one attempt of two
    db.setMediaOcrResult('1', 'a', { status: 'failed', error: 'boom' });
    expect(queue()).toEqual(['b']);
    db.setMediaOcrResult('1', 'b', { status: 'unavailable', error: 'no engine' });
    expect(queue()).toEqual([]);
    expect(db.getOcrQueue({ limit: 10, includeUnavailable: true, maxAttempts: 2 }).map((m) => m.mediaKey)).toEqual(['b']);
  });

  it('counts how far the images have been read', () => {
    db.storeCategorizedBatch(
      [bm('1', { media: [photo('a'), photo('b'), photo('c'), { ...photo('v'), type: 'video', url: null }] })],
      () => [],
      WHEN,
    );
    db.setMediaOcrResult('1', 'a', { status: 'done', text: 'words' });
    db.setMediaOcrResult('1', 'b', { status: 'done', text: '' });
    expect(db.getImageStats(3)).toEqual({ total: 4, photos: 3, done: 2, withText: 1, pending: 1, failed: 0, unavailable: 0 });
  });

  it('is cleared by a library reset', () => {
    db.storeCategorizedBatch([bm('1', { media: [photo('a')] })], () => [], WHEN);
    db.resetLibrary();
    expect(db.getMediaForPosts(['1']).size).toBe(0);
  });
});

describe('image text in the search index', () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(':memory:');
  });
  afterEach(() => db.close());

  it("finds a post by a word that exists only in its image, or in its quoted post's image", () => {
    db.storeCategorizedBatch(
      [bm('1', { media: [photo('a')] }), bm('2', { quotedPostId: 'q', quotedMedia: [photo('b', { altText: 'A memo' })] })],
      () => [],
      WHEN,
    );
    expect(hits(db, 'zephyrine')).toEqual([]);
    db.setMediaOcrResult('1', 'a', { status: 'done', text: 'Quarterly zephyrine report' });
    db.setMediaOcrResult('q', 'b', { status: 'done', text: 'Retention grew 42 percent' });
    expect(hits(db, 'zephyrine')).toEqual(['1']);
    expect(hits(db, 'retention')).toEqual(['2']);
    expect(hits(db, 'memo')).toEqual(['2']); // alt text too
    db.savePostMedia('1', []); // the image is gone from the post
    expect(hits(db, 'zephyrine')).toEqual([]);
  });
});

describe('migrating a library from before images', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbo-media-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('adds post_media and rebuilds the index with an images column, keeping every bookmark', () => {
    const file = path.join(dir, 'lib.db');
    const before = new Database(file);
    before.storeCategorizedBatch([bm('1', { text: 'diffusion models' })], () => [], WHEN);
    before.close();

    // Shape it like a database from the previous release: no post_media, a
    // five-column index built under version 1.
    const raw = new BetterSqlite3(file);
    for (const { name } of raw.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as { name: string }[]) {
      raw.exec(`DROP TRIGGER ${name}`);
    }
    raw.exec(`DROP TABLE post_media; DROP TABLE bookmark_fts;
      CREATE VIRTUAL TABLE bookmark_fts USING fts5(post, author, quoted, article, summary);`);
    raw.prepare('UPDATE run_state SET value = ? WHERE key = ?').run('1', SEARCH_INDEX_VERSION_KEY);
    raw.close();

    const db = new Database(file);
    expect(db.getState(SEARCH_INDEX_VERSION_KEY)).toBe(SEARCH_INDEX_VERSION);
    expect(hits(db, 'diffusion')).toEqual(['1']);
    db.savePostMedia('1', [photo('a')]);
    db.setMediaOcrResult('1', 'a', { status: 'done', text: 'vectorized kerning' });
    expect(hits(db, 'kerning')).toEqual(['1']);
    db.close();
  });
});
