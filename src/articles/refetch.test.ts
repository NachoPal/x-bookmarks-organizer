import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { refetchFailedArticles } from './refetch';
import { Database } from '../db/database';
import type { ArticleFetcher, ArticleExtractionResult } from './fetch-article';
import type { ArticleRecord, RawBookmark } from '../types';

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

/** Fake fetcher driven by a fixed url -> result map; records every url it was asked for. */
class FakeFetcher implements ArticleFetcher {
  calls: string[] = [];
  constructor(private readonly map: Record<string, ArticleExtractionResult>) {}
  async fetch(url: string): Promise<ArticleExtractionResult> {
    this.calls.push(url);
    return this.map[url] ?? { status: 'failed', reason: 'still unreadable' };
  }
}

const OK_RESULT: ArticleExtractionResult = {
  status: 'ok',
  title: "Don't Build Multi-Agents",
  contentHtml: '<p>Share full agent traces, not just individual messages.</p>',
  excerpt: 'Principles for reliable agents.',
  siteName: 'Example Labs',
  resolvedUrl: 'https://example.com/blog/dont-build-multi-agents',
};

function article(bookmarkId: number, url: string, status: 'ok' | 'failed'): ArticleRecord {
  return {
    bookmarkId,
    url,
    status,
    title: status === 'ok' ? 'Already readable' : null,
    contentHtml: status === 'ok' ? '<p>Existing body</p>' : null,
    excerpt: null,
    siteName: null,
    reason: status === 'ok' ? null : 'This page does not look like a readable article.',
    fetchedAt: '2026-09-17T15:33:59.420Z',
  };
}

describe('refetchFailedArticles', () => {
  let db: Database;
  let ids: number[];
  const summary = (bookmarkId: number, text: string) =>
    db.saveSummary({ bookmarkId, summary: text, generatedAt: '2026-09-17T16:00:00.000Z' });

  beforeEach(() => {
    db = new Database(':memory:');
    db.storeCategorizedBatch(
      [
        bm('1', 'a stale failure https://t.co/recovers'),
        bm('2', 'a genuine non-article https://t.co/video'),
        bm('3', 'already fine https://t.co/fine'),
      ],
      () => [],
    );
    ids = ['1', '2', '3'].map((postId) => db.getBookmarkByPostId(postId)!.id);
    db.saveArticle(article(ids[0]!, 'https://t.co/recovers', 'failed'));
    db.saveArticle(article(ids[1]!, 'https://t.co/video', 'failed'));
    db.saveArticle(article(ids[2]!, 'https://t.co/fine', 'ok'));
    summary(ids[0]!, 'The full article text is not available.');
    summary(ids[1]!, 'A video about something.');
    summary(ids[2]!, 'A good summary with the body.');
  });
  afterEach(() => {
    db.close();
  });

  it('re-fetches only failed rows and re-caches a now-readable one as ok with its body', async () => {
    const fetcher = new FakeFetcher({ 'https://t.co/recovers': OK_RESULT });

    const result = await refetchFailedArticles(db, fetcher);

    expect(fetcher.calls.sort()).toEqual(['https://t.co/recovers', 'https://t.co/video']);
    expect(result).toEqual({ retried: 2, recovered: 1, stillFailed: 1, summariesCleared: 1 });
    expect(db.getArticleForBookmark(ids[0]!)).toMatchObject({
      status: 'ok',
      title: "Don't Build Multi-Agents",
      contentHtml: OK_RESULT.status === 'ok' ? OK_RESULT.contentHtml : null,
      reason: null,
    });
  });

  it('drops only the stale summary of a recovered bookmark and keeps every other summary', async () => {
    await refetchFailedArticles(db, new FakeFetcher({ 'https://t.co/recovers': OK_RESULT }));

    expect(db.getSummaryForBookmark(ids[0]!)).toBeUndefined();
    expect(db.getSummaryForBookmark(ids[1]!)?.summary).toBe('A video about something.');
    expect(db.getSummaryForBookmark(ids[2]!)?.summary).toBe('A good summary with the body.');
    expect(db.getArticleForBookmark(ids[2]!)).toMatchObject({ status: 'ok', contentHtml: '<p>Existing body</p>' });
  });

  it('keeps a still-failing row failed, with the fresh reason', async () => {
    await refetchFailedArticles(db, new FakeFetcher({}));

    expect(db.getArticleForBookmark(ids[1]!)).toMatchObject({ status: 'failed', reason: 'still unreadable' });
  });

  it('is idempotent - a second run only retries what is still failing', async () => {
    const fetcher = new FakeFetcher({ 'https://t.co/recovers': OK_RESULT });
    await refetchFailedArticles(db, fetcher);
    fetcher.calls = [];

    const again = await refetchFailedArticles(db, fetcher);

    expect(fetcher.calls).toEqual(['https://t.co/video']);
    expect(again).toEqual({ retried: 1, recovered: 0, stillFailed: 1, summariesCleared: 0 });
  });

  it('leaves the old row in place when a fetcher throws instead of returning a typed failure', async () => {
    const throwing: ArticleFetcher = {
      fetch: async () => {
        throw new Error('boom');
      },
    };

    const result = await refetchFailedArticles(db, throwing);

    expect(result.recovered).toBe(0);
    expect(db.getArticleForBookmark(ids[0]!)).toMatchObject({ status: 'failed' });
    expect(db.getSummaryForBookmark(ids[0]!)).toBeDefined();
  });
});
