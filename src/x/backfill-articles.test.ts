import { describe, expect, it } from 'vitest';
import { Database } from '../db/database';
import { backfillXArticles } from './backfill-articles';
import type { XPostLookupClient } from './client';
import type { FetchedPost } from './article';
import type { RawBookmark, XArticle } from '../types';

const article = (title: string): XArticle => ({
  restId: '5',
  title,
  previewText: 'p',
  plainText: 'body',
  coverUrl: null,
  coverWidth: null,
  coverHeight: null,
});

function post(postId: string, overrides: Partial<FetchedPost> = {}): FetchedPost {
  return {
    postId,
    xArticle: null,
    articleUnrecognized: false,
    quotedPostId: null,
    quotedXArticle: null,
    quotedArticleUnrecognized: false,
    ...overrides,
  };
}

/** Fake, offline X lookup client: no network, no credentials. */
class FakeLookup implements XPostLookupClient {
  calls: string[][] = [];
  constructor(private readonly posts: FetchedPost[]) {}
  async fetchPostsByIds(ids: string[]): Promise<FetchedPost[]> {
    this.calls.push(ids);
    return this.posts.filter((p) => ids.includes(p.postId));
  }
}

function seed(): Database {
  const db = new Database(':memory:');
  const cat = db.getOrCreateCategory('Uncategorized', null, new Date().toISOString());
  const bm = (postId: string, link: string): RawBookmark => ({
    postId,
    authorUsername: 'a',
    authorName: 'A',
    text: link,
    url: `https://x.com/a/status/${postId}`,
    postCreatedAt: '',
  });
  db.storeCategorizedBatch(
    [
      bm('1', 'https://t.co/art'), // hosts an Article
      bm('2', 'quote https://t.co/qa'), // quotes an Article post
      bm('3', 'quote https://t.co/qn'), // quotes an ordinary post
      bm('4', 'https://t.co/ext'), // external link
      bm('5', 'https://t.co/unres'), // link never resolved
      bm('6', 'https://t.co/art6'), // hosts an Article whose shape is unrecognized
    ],
    () => [cat.id],
  );
  const meta = (url: string, resolvedUrl: string | null) =>
    db.saveArticleLinkMetadata({ url, status: 'failed', title: null, description: null, image: null, siteName: null, resolvedUrl, fetchedAt: '' });
  meta('https://t.co/art', 'https://x.com/i/article/100');
  meta('https://t.co/qa', 'https://x.com/someone/status/20');
  meta('https://t.co/qn', 'https://x.com/other/status/30');
  meta('https://t.co/ext', 'https://example.com/post');
  meta('https://t.co/unres', null);
  meta('https://t.co/art6', 'https://x.com/i/article/600');
  return db;
}

describe('backfillXArticles', () => {
  it('reads only the bookmarks that link or quote an X post, stores Articles, and is idempotent', async () => {
    const db = seed();
    const lookup = new FakeLookup([
      post('1', { xArticle: article('Own') }),
      post('20', { xArticle: article('Quoted') }),
      post('30'),
      post('6', { articleUnrecognized: true }),
    ]);
    let connects = 0;
    const connect = async () => {
      connects++;
      return lookup;
    };

    const summary = await backfillXArticles(db, connect);
    expect(lookup.calls.map((ids) => [...ids].sort())).toEqual([['1', '20', '30', '6']]);
    expect(summary).toMatchObject({ direct: 2, quoted: 2, requested: 4, stored: 2, quotedNonArticle: 1, unrecognized: 1, unresolved: 1 });
    expect(db.getXArticle('1')?.title).toBe('Own');
    expect(db.getXArticle('20')?.title).toBe('Quoted');
    expect(db.getBookmarkByPostId('2')?.quotedPostId).toBe('20');
    expect(db.getBookmarkByPostId('3')?.quotedPostId).toBe('30');
    expect(db.getXArticlesForBookmarks(db.getAllBookmarks()).get('2')?.quoted).toBe(true);

    // Second run: only the unrecognized one is still missing.
    const again = await backfillXArticles(db, connect);
    expect(lookup.calls[1]).toEqual(['6']);
    expect(again.stored).toBe(0);
    expect(connects).toBe(2);
    db.close();
  });

  it('never connects to X on a dry run or when nothing is missing', async () => {
    const db = seed();
    let connects = 0;
    const connect = async () => {
      connects++;
      return new FakeLookup([]);
    };
    const logs: string[] = [];
    const summary = await backfillXArticles(db, connect, { dryRun: true, logger: (m) => logs.push(m) });
    expect(connects).toBe(0);
    expect(summary.requested).toBe(0);
    expect(logs.join('\n')).toMatch(/estimated one-time cost ~\$0\.020/);

    const empty = new Database(':memory:');
    await backfillXArticles(empty, connect);
    expect(connects).toBe(0);
    empty.close();
    db.close();
  });
});
