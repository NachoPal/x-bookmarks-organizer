import { describe, it, expect, afterEach, vi } from 'vitest';
import { buildArticleContext, type ArticleMetadataCache } from './link-metadata';
import { HttpArticleFetcher, type ArticleFetcher, type ArticleExtractionResult } from './fetch-article';
import type { ArticleLinkMetadata, RawBookmark } from '../types';

function bm(postId: string, text: string): RawBookmark {
  return {
    postId,
    authorUsername: 'a',
    authorName: 'A',
    text,
    url: `https://x.com/a/status/${postId}`,
    postCreatedAt: '',
  };
}

/** In-memory stand-in for the Database's URL-keyed cache methods. */
class FakeCache implements ArticleMetadataCache {
  store = new Map<string, ArticleLinkMetadata>();
  getArticleLinkMetadata(url: string): ArticleLinkMetadata | undefined {
    return this.store.get(url);
  }
  saveArticleLinkMetadata(record: ArticleLinkMetadata): void {
    this.store.set(record.url, record);
  }
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

/** A fetcher that always throws, simulating an unexpected error from a bad implementation. */
class ThrowingFetcher implements ArticleFetcher {
  async fetch(): Promise<ArticleExtractionResult> {
    throw new Error('boom');
  }
}

describe('buildArticleContext', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const xArticle = {
    restId: '777',
    title: 'Adopting the software factory model',
    previewText: 'Crawl, walk, run.',
    plainText: 'Body',
    coverUrl: null,
    coverWidth: null,
    coverHeight: null,
  };

  it('uses an X Article\'s title + preview as context (own or quoted) without fetching its link', async () => {
    const fetcher = new FakeFetcher({});
    const cache = new FakeCache();
    const ctx = await buildArticleContext(
      [
        { ...bm('1', 'https://t.co/own'), xArticle },
        { ...bm('2', 'Must read https://t.co/quoted'), quotedPostId: '9', quotedXArticle: { ...xArticle, title: 'Quoted' } },
      ],
      fetcher,
      cache,
    );
    expect(ctx.get('1')).toEqual({ title: 'Adopting the software factory model', description: 'Crawl, walk, run.' });
    expect(ctx.get('2')?.title).toBe('Quoted');
    expect(fetcher.calls).toEqual([]);
    expect(cache.store.size).toBe(0); // no pointless `failed` row for the x.com link
  });

  it('reads a stored X Article for a bookmark fetched without one (the recategorize path)', async () => {
    const fetcher = new FakeFetcher({});
    const cache = Object.assign(new FakeCache(), {
      getXArticlesForBookmarks: () => new Map([['1', { article: xArticle }]]),
    });
    const ctx = await buildArticleContext([bm('1', 'https://t.co/own')], fetcher, cache);
    expect(ctx.get('1')?.title).toBe('Adopting the software factory model');
    expect(fetcher.calls).toEqual([]);
  });

  it('returns no context for bookmarks with no link', async () => {
    const cache = new FakeCache();
    const fetcher = new FakeFetcher({});
    const context = await buildArticleContext([bm('1', 'just some text, no link')], fetcher, cache);
    expect(context.size).toBe(0);
    expect(fetcher.calls).toEqual([]);
  });

  it('fetches and includes the linked article title/description for a link post', async () => {
    const cache = new FakeCache();
    const fetcher = new FakeFetcher({
      'https://example.com/article': {
        status: 'ok',
        title: 'A Great Article',
        contentHtml: '<p>Body</p>',
        excerpt: 'A short summary',
        siteName: 'Example',
      },
    });
    const context = await buildArticleContext(
      [bm('1', 'check this out https://example.com/article')],
      fetcher,
      cache,
    );
    expect(context.get('1')).toEqual({ title: 'A Great Article', description: 'A short summary' });
  });

  it('caches the result so the same URL is never fetched twice, even across bookmarks', async () => {
    const cache = new FakeCache();
    const fetcher = new FakeFetcher({
      'https://example.com/article': { status: 'ok', title: 'Shared', contentHtml: '', excerpt: null, siteName: null },
    });
    const bookmarks = [
      bm('1', 'see https://example.com/article'),
      bm('2', 'also see https://example.com/article'),
    ];
    const context = await buildArticleContext(bookmarks, fetcher, cache);

    expect(fetcher.calls).toEqual(['https://example.com/article']);
    expect(context.get('1')).toEqual({ title: 'Shared', description: undefined });
    expect(context.get('2')).toEqual({ title: 'Shared', description: undefined });
  });

  it('reuses a previously cached record instead of re-fetching on a later call', async () => {
    const cache = new FakeCache();
    cache.saveArticleLinkMetadata({
      url: 'https://example.com/article',
      status: 'ok',
      title: 'Cached Title',
      description: null,
      image: null,
      siteName: null,
      resolvedUrl: 'https://example.com/article',
      fetchedAt: '2026-01-01T00:00:00.000Z',
    });
    const fetcher = new FakeFetcher({});
    const context = await buildArticleContext(
      [bm('1', 'https://example.com/article')],
      fetcher,
      cache,
    );
    expect(fetcher.calls).toEqual([]);
    expect(context.get('1')).toEqual({ title: 'Cached Title', description: undefined });
  });

  it('falls back to no context (today\'s behavior) on a fetch failure, and caches the failure', async () => {
    const cache = new FakeCache();
    const fetcher = new FakeFetcher({
      'https://example.com/dead': { status: 'failed', reason: 'HTTP 404' },
    });
    const context = await buildArticleContext(
      [bm('1', 'https://example.com/dead')],
      fetcher,
      cache,
    );
    expect(context.has('1')).toBe(false);
    expect(cache.getArticleLinkMetadata('https://example.com/dead')?.status).toBe('failed');

    // A second call must not re-fetch the already-cached failure.
    await buildArticleContext([bm('2', 'https://example.com/dead')], fetcher, cache);
    expect(fetcher.calls).toEqual(['https://example.com/dead']);
  });

  it('caches a usable card - and gives the categorizer its title - for a page with OG tags but no readable body (issue #45)', async () => {
    const cache = new FakeCache();
    const fetcher = new FakeFetcher({
      'https://t.co/tool': {
        status: 'failed',
        reason: 'This page does not look like a readable article.',
        preview: {
          title: 'A Tool, Not An Article',
          description: 'One place every agent plugs in.',
          image: 'https://tool.example.com/card.png',
          siteName: 'Tool',
        },
        resolvedUrl: 'https://tool.example.com/',
      },
    });

    const context = await buildArticleContext([bm('1', 'great tool https://t.co/tool')], fetcher, cache);

    expect(cache.getArticleLinkMetadata('https://t.co/tool')).toMatchObject({
      status: 'card',
      title: 'A Tool, Not An Article',
      image: 'https://tool.example.com/card.png',
      resolvedUrl: 'https://tool.example.com/',
    });
    // A card is real categorization signal too - that is the whole point of #25.
    expect(context.get('1')).toEqual({
      title: 'A Tool, Not An Article',
      description: 'One place every agent plugs in.',
    });
  });

  it('caches nothing usable as failed when the page has neither a body nor a card', async () => {
    const cache = new FakeCache();
    const fetcher = new FakeFetcher({
      'https://example.com/404': { status: 'failed', reason: 'The page returned an error (HTTP 404).' },
    });

    const context = await buildArticleContext([bm('1', 'https://example.com/404')], fetcher, cache);

    expect(context.has('1')).toBe(false);
    expect(cache.getArticleLinkMetadata('https://example.com/404')).toMatchObject({
      status: 'failed',
      title: null,
      image: null,
    });
  });

  it('prefers the card fields over the readability-derived ones for a readable article', async () => {
    const cache = new FakeCache();
    const fetcher = new FakeFetcher({
      'https://t.co/post': {
        status: 'ok',
        title: 'Readability Title | Site Chrome',
        contentHtml: '<p>Body</p>',
        excerpt: 'Readability excerpt',
        siteName: null,
        preview: {
          title: 'The Clean OG Title',
          description: 'The OG description.',
          image: 'https://example.com/cover.png',
          siteName: 'Example Times',
        },
        resolvedUrl: 'https://example.com/post',
      },
    });

    await buildArticleContext([bm('1', 'https://t.co/post')], fetcher, cache);

    expect(cache.getArticleLinkMetadata('https://t.co/post')).toMatchObject({
      status: 'ok',
      title: 'The Clean OG Title',
      description: 'The OG description.',
      image: 'https://example.com/cover.png',
      siteName: 'Example Times',
      resolvedUrl: 'https://example.com/post',
    });
  });

  it('never throws and yields no context when the fetcher itself throws', async () => {
    const cache = new FakeCache();
    const fetcher = new ThrowingFetcher();
    const context = await buildArticleContext(
      [bm('1', 'https://example.com/whatever')],
      fetcher,
      cache,
    );
    expect(context.size).toBe(0);
    expect(cache.getArticleLinkMetadata('https://example.com/whatever')?.status).toBe('failed');
  });

  it('bounds concurrency so at most N links are in flight at once', async () => {
    const cache = new FakeCache();
    let inFlight = 0;
    let maxInFlight = 0;
    class TrackingFetcher implements ArticleFetcher {
      async fetch(): Promise<ArticleExtractionResult> {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return { status: 'ok', title: 'T', contentHtml: '', excerpt: null, siteName: null };
      }
    }
    const bookmarks = Array.from({ length: 10 }, (_, i) => bm(String(i), `https://example.com/${i}`));
    await buildArticleContext(bookmarks, new TrackingFetcher(), cache, 3);
    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  it('end-to-end: a slow/hanging link times out via the real HttpArticleFetcher and ingest still completes', async () => {
    // Uses the real HttpArticleFetcher (the production default) with a stubbed
    // `fetch` that never settles until its AbortSignal fires, proving the bound
    // comes from the fetcher's own timeout and buildArticleContext completes
    // (with no context for that bookmark) rather than hanging ingest.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        (_url: string, init?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }),
      ),
    );
    const cache = new FakeCache();
    const fetcher = new HttpArticleFetcher(20);
    const context = await buildArticleContext(
      [bm('1', 'https://example.com/slow')],
      fetcher,
      cache,
    );
    expect(context.has('1')).toBe(false);
    expect(cache.getArticleLinkMetadata('https://example.com/slow')?.status).toBe('failed');
  });
});
