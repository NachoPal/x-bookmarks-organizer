import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from './database';
import { buildMatchQuery, SEARCH_INDEX_VERSION_KEY } from './search';
import type { RawBookmark } from '../types';

const bm = (postId: string, text: string, extra: Partial<RawBookmark> = {}): RawBookmark => ({
  postId,
  authorUsername: `user${postId}`,
  authorName: `User ${postId}`,
  text,
  url: `https://x.com/user${postId}/status/${postId}`,
  postCreatedAt: '2024-05-01T10:00:00.000Z',
  ...extra,
});

const hits = (db: Database, query: string) => db.searchBookmarks({ query, limit: 50 }).hits.map((h) => h.bookmark.postId);

describe('buildMatchQuery', () => {
  it('quotes every term so FTS5 syntax in the input is never interpreted', () => {
    expect(buildMatchQuery('rust async')).toEqual({ all: '"rust" "async"', any: '"rust" OR "async"' });
    // Colons (column filters), NOT, parentheses and stray quotes are all data.
    expect(buildMatchQuery('title: NOT (rust*')?.all).toBe('"title" "not" "rust"');
  });

  it('keeps a quoted phrase and turns a chunk the tokenizer would split into a phrase', () => {
    expect(buildMatchQuery('"prompt caching" node.js')?.all).toBe('"prompt caching" "node js"');
  });

  it('drops stop words unless nothing else is left', () => {
    expect(buildMatchQuery('is there anything about rust?')?.all).toBe('"rust"');
    expect(buildMatchQuery('the who')?.all).toBe('"the" "who"');
  });

  it('returns null when nothing searchable is left', () => {
    expect(buildMatchQuery('  ?!  ')).toBeNull();
  });
});

describe('the full-text index is kept in sync by triggers', () => {
  let db: Database;
  const when = '2024-06-01T00:00:00.000Z';

  beforeEach(() => {
    db = new Database(':memory:');
  });
  afterEach(() => db.close());

  it('indexes a stored post, its author and its quoted post', () => {
    db.storeCategorizedBatch(
      [bm('1', 'Comparing async runtimes', { quotedPostId: '99', quotedPost: { postId: '99', authorUsername: 'q', authorName: 'Quoter', text: 'wakers explained', createdAt: '' } })],
      () => [],
      when,
    );
    expect(hits(db, 'runtimes')).toEqual(['1']);
    expect(hits(db, 'user1')).toEqual(['1']);
    expect(hits(db, 'wakers')).toEqual(['1']);
  });

  it('picks up link metadata whether it is cached before or after the post', () => {
    db.saveArticleLinkMetadata({ url: 'https://t.co/aaa', status: 'card', title: 'Tokio internals', description: null, image: null, siteName: null, resolvedUrl: null, fetchedAt: when });
    db.storeCategorizedBatch([bm('1', 'read this https://t.co/aaa'), bm('2', 'and this https://t.co/bbb')], () => [], when);
    db.saveArticleLinkMetadata({ url: 'https://t.co/bbb', status: 'ok', title: 'Borrow checker deep dive', description: null, image: null, siteName: null, resolvedUrl: null, fetchedAt: when });
    expect(hits(db, 'tokio')).toEqual(['1']);
    expect(hits(db, 'borrow checker')).toEqual(['2']);
    // A failed fetch carries nothing, and an update that marks it failed removes it.
    db.saveArticleLinkMetadata({ url: 'https://t.co/bbb', status: 'failed', title: 'Borrow checker deep dive', description: null, image: null, siteName: null, resolvedUrl: null, fetchedAt: when });
    expect(hits(db, 'borrow')).toEqual([]);
  });

  it('indexes a saved summary and a cached article body as plain text, and forgets them when removed', () => {
    db.storeCategorizedBatch([bm('1', 'a post')], () => [], when);
    const id = db.getBookmarkByPostId('1')!.id;
    db.saveSummary({ bookmarkId: id, summary: 'An overview of vector databases', generatedAt: when });
    db.saveArticle({ bookmarkId: id, url: 'https://t.co/x', status: 'ok', title: 'Title', contentHtml: '<p>All about <b>quaternions</b></p><script>ignored()</script>', excerpt: null, siteName: null, reason: null, fetchedAt: when });
    expect(hits(db, 'vector')).toEqual(['1']);
    expect(hits(db, 'quaternions')).toEqual(['1']);
    expect(hits(db, 'ignored')).toEqual([]);
    expect(hits(db, 'b')).toEqual([]);
    db.deleteSummary(id);
    expect(hits(db, 'vector')).toEqual([]);
  });

  it('indexes an X Article hosted or quoted by the post', () => {
    db.storeCategorizedBatch([bm('1', 'hosts'), bm('2', 'quotes', { quotedPostId: '1' })], () => [], when);
    db.saveXArticle('1', { restId: 'r', title: 'Scaling laws', previewText: null, plainText: 'long form about chinchilla', coverUrl: null, coverWidth: null, coverHeight: null }, when);
    expect(hits(db, 'chinchilla').sort()).toEqual(['1', '2']);
  });

  it('never reindexes on a read/favorite toggle and drops a deleted bookmark', () => {
    db.storeCategorizedBatch([bm('1', 'transformers')], () => [], when);
    const id = db.getBookmarkByPostId('1')!.id;
    db.markRead(id);
    db.setFavorite(id, true);
    expect(hits(db, 'transformers')).toEqual(['1']);
    db.saveSummary({ bookmarkId: id, summary: 'summary text', generatedAt: when });
    db.deleteBookmark(id);
    expect(hits(db, 'transformers')).toEqual([]);
    expect(hits(db, 'summary')).toEqual([]);
  });

  it('is emptied by a library reset', () => {
    db.storeCategorizedBatch([bm('1', 'transformers')], () => [], when);
    db.resetLibrary();
    expect(hits(db, 'transformers')).toEqual([]);
  });
});

describe('searchBookmarks', () => {
  let db: Database;
  const when = '2024-06-01T00:00:00.000Z';
  let ai: number;
  let agents: number;
  let cooking: number;

  beforeEach(() => {
    db = new Database(':memory:');
    ai = db.getOrCreateCategory('AI', null, when).id;
    agents = db.getOrCreateCategory('Agents', ai, when).id;
    cooking = db.getOrCreateCategory('Cooking', null, when).id;
    const home: Record<string, number> = { '1': agents, '2': ai, '3': cooking, '4': agents };
    db.storeCategorizedBatch(
      [
        bm('1', 'agent harness evaluation', { postCreatedAt: '2024-01-10T00:00:00.000Z' }),
        bm('2', 'evaluation of language models', { postCreatedAt: '2024-03-10T00:00:00.000Z' }),
        bm('3', 'sourdough evaluation notes', { postCreatedAt: '2024-05-10T00:00:00.000Z' }),
        bm('4', 'tool use for agents', { postCreatedAt: '' }),
      ],
      (b) => [home[b.postId]!],
      when,
    );
  });
  afterEach(() => db.close());

  it('ranks by relevance, reports the total and marks the match in a snippet', () => {
    const result = db.searchBookmarks({ query: 'evaluation', limit: 2 });
    expect(result.total).toBe(3);
    expect(result.mode).toBe('all');
    expect(result.hits).toHaveLength(2);
    expect(result.hits[0]!.snippet).toContain('«evaluation»');
  });

  it('narrows to a category subtree, a post-date window and a read state', () => {
    expect(db.searchBookmarks({ query: 'evaluation', categoryId: ai, limit: 10 }).hits.map((h) => h.bookmark.postId).sort()).toEqual(['1', '2']);
    const window = db.searchBookmarks({ query: 'evaluation', postedFrom: '2024-02-01T00:00:00.000Z', postedBefore: '2024-04-01T00:00:00.000Z', limit: 10 });
    expect(window.hits.map((h) => h.bookmark.postId)).toEqual(['2']);
    db.markRead(db.getBookmarkByPostId('2')!.id);
    expect(db.searchBookmarks({ query: 'evaluation', filter: 'unread', limit: 10 }).total).toBe(2);
    expect(db.searchBookmarks({ query: 'evaluation', filter: 'read', categoryId: ai, limit: 10 }).total).toBe(1);
  });

  it('falls back to any term, and says so, when nothing has every term', () => {
    const result = db.searchBookmarks({ query: 'sourdough agents', limit: 10 });
    expect(result.mode).toBe('any');
    // Stemmed: "agents" also finds the post that says "agent".
    expect(result.hits.map((h) => h.bookmark.postId).sort()).toEqual(['1', '3', '4']);
  });

  it('lists by filters alone, newest post first, with no query', () => {
    const result = db.searchBookmarks({ categoryId: cooking, limit: 10 });
    expect(result).toMatchObject({ mode: 'none', total: 1 });
    expect(result.hits[0]!.snippet).toBeNull();
    expect(db.searchBookmarks({ limit: 10 }).hits.map((h) => h.bookmark.postId)).toEqual(['3', '2', '1', '4']);
  });

  it('pages with offset and limit', () => {
    const all = db.searchBookmarks({ query: 'evaluation', limit: 10 }).hits.map((h) => h.bookmark.postId);
    const second = db.searchBookmarks({ query: 'evaluation', limit: 1, offset: 1 }).hits.map((h) => h.bookmark.postId);
    expect(second).toEqual([all[1]]);
  });
});

describe('the search index migration', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbo-search-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('builds the index for a library stored before search existed', () => {
    const file = path.join(dir, 'lib.db');
    const db = new Database(file);
    db.storeCategorizedBatch([bm('1', 'retrieval augmented generation')], () => [], '2024-06-01T00:00:00.000Z');
    const id = db.getBookmarkByPostId('1')!.id;
    db.saveArticle({ bookmarkId: id, url: 'https://t.co/x', status: 'ok', title: 't', contentHtml: '<p>chunking strategies</p>', excerpt: null, siteName: null, reason: null, fetchedAt: 'x' });
    db.close();

    // Turn it back into a pre-search database: no index, no triggers, no
    // version, and an article row with no plain-text body.
    const raw = new BetterSqlite3(file);
    for (const { name } of raw.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as { name: string }[]) {
      raw.exec(`DROP TRIGGER ${name}`);
    }
    raw.exec('DROP TABLE bookmark_fts');
    raw.exec('UPDATE articles SET content_text = NULL');
    raw.prepare('DELETE FROM run_state WHERE key = ?').run(SEARCH_INDEX_VERSION_KEY);
    raw.close();

    const reopened = new Database(file);
    expect(hits(reopened, 'retrieval')).toEqual(['1']);
    expect(hits(reopened, 'chunking')).toEqual(['1']);
    // ...and it is live from then on.
    reopened.storeCategorizedBatch([bm('2', 'retrieval evaluation')], () => [], '2024-06-02T00:00:00.000Z');
    expect(hits(reopened, 'retrieval').sort()).toEqual(['1', '2']);
    reopened.close();
  });

  it('rebuilds an index built under another version', () => {
    const file = path.join(dir, 'lib.db');
    const db = new Database(file);
    db.storeCategorizedBatch([bm('1', 'diffusion models')], () => [], '2024-06-01T00:00:00.000Z');
    db.setState(SEARCH_INDEX_VERSION_KEY, 'old');
    db.close();

    const raw = new BetterSqlite3(file);
    raw.exec('DELETE FROM bookmark_fts');
    raw.close();

    const reopened = new Database(file);
    expect(hits(reopened, 'diffusion')).toEqual(['1']);
    reopened.close();
  });
});
