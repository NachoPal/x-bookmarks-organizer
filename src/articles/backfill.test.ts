import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { backfillArticlePreviews } from './backfill';
import { Database } from '../db/database';
import type { ArticleFetcher, ArticleExtractionResult } from './fetch-article';
import type { RawBookmark } from '../types';

function bm(postId: string, text: string): RawBookmark {
  return {
    postId,
    authorUsername: 'a',
    authorName: 'A',
    text,
    url: `https://x.com/a/status/${postId}`,
    postCreatedAt: '2024-01-01T00:00:00.000Z',
  };
}

/** Fake fetcher driven by a fixed url -> result map; records how many times each url was fetched. */
class FakeFetcher implements ArticleFetcher {
  calls: string[] = [];
  constructor(private readonly map: Record<string, ArticleExtractionResult>) {}
  async fetch(url: string): Promise<ArticleExtractionResult> {
    this.calls.push(url);
    return this.map[url] ?? { status: 'failed', reason: 'not found' };
  }
}

/** Stores a bookmark with no categories - never touches the taxonomy. */
function storeUncategorized(db: Database, bookmark: RawBookmark): void {
  db.storeCategorizedBatch([bookmark], () => []);
}

describe('backfillArticlePreviews', () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(':memory:');
  });
  afterEach(() => {
    db.close();
  });

  it('fetches and caches metadata only for bookmarks with an article link and missing metadata', async () => {
    storeUncategorized(db, bm('1', 'no link here'));
    storeUncategorized(db, bm('2', 'check this out https://example.com/article'));
    const fetcher = new FakeFetcher({
      'https://example.com/article': {
        status: 'ok',
        title: 'A Great Article',
        contentHtml: '<p>Body</p>',
        excerpt: 'A short summary',
        siteName: 'Example',
      },
    });

    const summary = await backfillArticlePreviews(db, fetcher);

    expect(fetcher.calls).toEqual(['https://example.com/article']);
    expect(summary).toEqual({ totalLinks: 1, fetched: 1, ok: 1, failed: 0, skipped: 0 });
    const cached = db.getArticleLinkMetadata('https://example.com/article');
    expect(cached).toMatchObject({ status: 'ok', title: 'A Great Article' });
  });

  it('is idempotent: a second run does no redundant fetches for already-ok rows', async () => {
    storeUncategorized(db, bm('1', 'see https://example.com/article'));
    const fetcher = new FakeFetcher({
      'https://example.com/article': {
        status: 'ok',
        title: 'Cached Once',
        contentHtml: '',
        excerpt: null,
        siteName: null,
      },
    });

    const first = await backfillArticlePreviews(db, fetcher);
    expect(first).toEqual({ totalLinks: 1, fetched: 1, ok: 1, failed: 0, skipped: 0 });

    const second = await backfillArticlePreviews(db, fetcher);
    expect(second).toEqual({ totalLinks: 1, fetched: 0, ok: 0, failed: 0, skipped: 1 });
    expect(fetcher.calls).toEqual(['https://example.com/article']);
  });

  it('records a per-link fetch failure as failed without aborting the run', async () => {
    storeUncategorized(db, bm('1', 'broken link https://example.com/dead'));
    storeUncategorized(db, bm('2', 'good link https://example.com/ok'));
    const fetcher = new FakeFetcher({
      'https://example.com/ok': { status: 'ok', title: 'Fine', contentHtml: '', excerpt: null, siteName: null },
    });

    const summary = await backfillArticlePreviews(db, fetcher);

    expect(summary).toEqual({ totalLinks: 2, fetched: 2, ok: 1, failed: 1, skipped: 0 });
    expect(db.getArticleLinkMetadata('https://example.com/dead')).toMatchObject({ status: 'failed' });
    expect(db.getArticleLinkMetadata('https://example.com/ok')).toMatchObject({ status: 'ok' });
  });

  it('by default does not retry a previously failed url', async () => {
    storeUncategorized(db, bm('1', 'see https://example.com/dead'));
    const fetcher = new FakeFetcher({});
    await backfillArticlePreviews(db, fetcher);
    expect(fetcher.calls).toEqual(['https://example.com/dead']);

    const second = await backfillArticlePreviews(db, fetcher);
    expect(second).toEqual({ totalLinks: 1, fetched: 0, ok: 0, failed: 0, skipped: 1 });
    expect(fetcher.calls).toEqual(['https://example.com/dead']);
  });

  it('retries a previously failed url when retryFailed is set', async () => {
    storeUncategorized(db, bm('1', 'see https://example.com/flaky'));
    const failingFetcher = new FakeFetcher({});
    await backfillArticlePreviews(db, failingFetcher);

    const recoveringFetcher = new FakeFetcher({
      'https://example.com/flaky': {
        status: 'ok',
        title: 'Recovered',
        contentHtml: '',
        excerpt: null,
        siteName: null,
      },
    });
    const summary = await backfillArticlePreviews(db, recoveringFetcher, { retryFailed: true });

    expect(summary).toEqual({ totalLinks: 1, fetched: 1, ok: 1, failed: 0, skipped: 0 });
    expect(db.getArticleLinkMetadata('https://example.com/flaky')).toMatchObject({ status: 'ok', title: 'Recovered' });
  });

  it('does not modify any category or taxonomy state', async () => {
    storeUncategorized(db, bm('1', 'see https://example.com/article'));
    const fetcher = new FakeFetcher({
      'https://example.com/article': {
        status: 'ok',
        title: 'Article',
        contentHtml: '',
        excerpt: null,
        siteName: null,
      },
    });

    const categoriesBefore = db.getAllCategories();
    await backfillArticlePreviews(db, fetcher);
    const categoriesAfter = db.getAllCategories();

    expect(categoriesAfter).toEqual(categoriesBefore);
    const stored = db.getBookmarkByPostId('1');
    expect(stored?.read).toBe(false);
  });
});
