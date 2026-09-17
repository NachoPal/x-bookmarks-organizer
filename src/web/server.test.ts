import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildServer } from './server';
import { Database } from '../db/database';
import type { FastifyInstance } from 'fastify';
import type { RawBookmark } from '../types';
import type { ArticleFetcher, ArticleExtractionResult } from '../articles/fetch-article';
import type { SummaryGenerator, SummaryInput } from '../summarize/summarizer';

const bm = (postId: string): RawBookmark => ({
  postId,
  authorUsername: 'a',
  authorName: 'A',
  text: `t-${postId}`,
  url: `https://x.com/a/status/${postId}`,
  postCreatedAt: '',
});

/** A fake, offline article fetcher - mirrors the fake XClient/Categorizer pattern used elsewhere. */
class FakeArticleFetcher implements ArticleFetcher {
  calls: string[] = [];
  constructor(private readonly result: ArticleExtractionResult) {}
  async fetch(url: string): Promise<ArticleExtractionResult> {
    this.calls.push(url);
    return this.result;
  }
}

/** A fake, offline summary generator - no LLM/network involved. */
class FakeSummaryGenerator implements SummaryGenerator {
  calls: SummaryInput[] = [];
  constructor(private readonly result: string | Error) {}
  async summarize(input: SummaryInput): Promise<string> {
    this.calls.push(input);
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}

describe('web server API', () => {
  let db: Database;
  let app: FastifyInstance;

  beforeEach(async () => {
    db = new Database(':memory:');
    const when = new Date().toISOString();
    const ai = db.getOrCreateCategory('AI', null, when);
    const evals = db.getOrCreateCategory('Evals', ai.id, when);
    db.storeCategorizedBatch([bm('1'), bm('2')], () => [evals.id]);
    app = buildServer(db);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it('GET /api/tree returns the counted tree', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/tree' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { tree: { name: string; total: number; unread: number; children: unknown[] }[] };
    const ai = body.tree.find((n) => n.name === 'AI')!;
    expect(ai.total).toBe(2);
    expect(ai.unread).toBe(2);
    expect(ai.children).toHaveLength(1);
  });

  it('GET /api/categories/:id/bookmarks lists that node bookmarks', async () => {
    const evals = db.getAllCategories().find((c) => c.name === 'Evals')!;
    const res = await app.inject({ method: 'GET', url: `/api/categories/${evals.id}/bookmarks` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { bookmarks: { postId: string; read: boolean }[] };
    expect(body.bookmarks.map((b) => b.postId).sort()).toEqual(['1', '2']);
    expect(body.bookmarks.every((b) => b.read === false)).toBe(true);
  });

  it('GET /api/categories/:id/bookmarks includes each bookmark\'s directly filed category ids', async () => {
    const evals = db.getAllCategories().find((c) => c.name === 'Evals')!;
    const res = await app.inject({ method: 'GET', url: `/api/categories/${evals.id}/bookmarks` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { bookmarks: { postId: string; categoryIds: number[] }[] };
    for (const b of body.bookmarks) expect(b.categoryIds).toEqual([evals.id]);
  });

  it('GET /api/categories/:id/bookmarks on a parent returns descendants deduplicated', async () => {
    // AI has bookmarks only in its child Evals; the parent must still list them
    // and its badge (rolled-up total) must match that list.
    const ai = db.getAllCategories().find((c) => c.name === 'AI')!;
    const res = await app.inject({ method: 'GET', url: `/api/categories/${ai.id}/bookmarks` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { bookmarks: { postId: string }[] };
    expect(body.bookmarks.map((b) => b.postId).sort()).toEqual(['1', '2']);

    const tree = (await app.inject({ method: 'GET', url: '/api/tree' })).json() as {
      tree: { name: string; total: number }[];
    };
    expect(tree.tree.find((n) => n.name === 'AI')!.total).toBe(body.bookmarks.length);
  });

  it('POST /api/bookmarks/:id/read marks it read and reflects in the tree count', async () => {
    const b1 = db.getBookmarkByPostId('1')!;
    const res = await app.inject({ method: 'POST', url: `/api/bookmarks/${b1.id}/read` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { bookmark: { read: boolean; readAt: string | null } };
    expect(body.bookmark.read).toBe(true);
    expect(body.bookmark.readAt).not.toBeNull();

    const tree = (await app.inject({ method: 'GET', url: '/api/tree' })).json() as {
      tree: { name: string; unread: number }[];
    };
    expect(tree.tree.find((n) => n.name === 'AI')!.unread).toBe(1);
  });

  it('returns 404 for an unknown bookmark and 400 for a bad id', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/bookmarks/9999/read' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/bookmarks/abc/read' })).statusCode).toBe(400);
  });

  it('POST /api/bookmarks/:id/read with { read: false } clears read state (the chip toggle)', async () => {
    const b1 = db.getBookmarkByPostId('1')!;
    await app.inject({ method: 'POST', url: `/api/bookmarks/${b1.id}/read` });

    const res = await app.inject({
      method: 'POST',
      url: `/api/bookmarks/${b1.id}/read`,
      payload: { read: false },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { bookmark: { read: boolean; readAt: string | null } };
    expect(body.bookmark.read).toBe(false);
    expect(body.bookmark.readAt).toBeNull();

    const tree = (await app.inject({ method: 'GET', url: '/api/tree' })).json() as {
      tree: { name: string; unread: number }[];
    };
    expect(tree.tree.find((n) => n.name === 'AI')!.unread).toBe(2);
  });

  it('DELETE /api/bookmarks/:id permanently removes it and updates category counts', async () => {
    const b1 = db.getBookmarkByPostId('1')!;
    const res = await app.inject({ method: 'DELETE', url: `/api/bookmarks/${b1.id}` });
    expect(res.statusCode).toBe(204);
    expect(db.getBookmarkByPostId('1')).toBeUndefined();

    const tree = (await app.inject({ method: 'GET', url: '/api/tree' })).json() as {
      tree: { name: string; total: number }[];
    };
    expect(tree.tree.find((n) => n.name === 'AI')!.total).toBe(1);
  });

  it('DELETE /api/bookmarks/:id returns 404 for an unknown id and 400 for a bad id', async () => {
    expect((await app.inject({ method: 'DELETE', url: '/api/bookmarks/9999' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: '/api/bookmarks/abc' })).statusCode).toBe(400);
  });
});

describe('GET /api/sync-status', () => {
  let db: Database;
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it('returns null when the database has never been synced', async () => {
    db = new Database(':memory:');
    app = buildServer(db);
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/sync-status' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ lastSyncedAt: null });
  });

  it('returns the last-synced timestamp once one is recorded', async () => {
    db = new Database(':memory:');
    db.setLastSyncedAt('2026-09-16T10:00:00.000Z');
    app = buildServer(db);
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/sync-status' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ lastSyncedAt: '2026-09-16T10:00:00.000Z' });
  });
});

describe('web server bookmark paging & filtering', () => {
  let db: Database;
  let app: FastifyInstance;
  let evalsId: number;

  beforeEach(async () => {
    db = new Database(':memory:');
    const when = new Date().toISOString();
    const ai = db.getOrCreateCategory('AI', null, when);
    const evals = db.getOrCreateCategory('Evals', ai.id, when);
    evalsId = evals.id;
    // 25 bookmarks; mark 10 of them read to exercise the read-state filter.
    const batch = Array.from({ length: 25 }, (_, i) => bm(String(i + 1)));
    db.storeCategorizedBatch(batch, () => [evals.id]);
    for (let i = 1; i <= 10; i++) db.markRead(db.getBookmarkByPostId(String(i))!.id);
    app = buildServer(db, { pageSize: 20 });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it('returns a first page capped at the page size with paging metadata', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/categories/${evalsId}/bookmarks` });
    const body = res.json() as {
      bookmarks: unknown[];
      counts: { total: number; unread: number };
      total: number;
      hasMore: boolean;
      offset: number;
      limit: number;
    };
    expect(body.bookmarks).toHaveLength(20);
    expect(body.counts).toEqual({ total: 25, unread: 15 });
    expect(body.total).toBe(25);
    expect(body.hasMore).toBe(true);
    expect(body.offset).toBe(0);
    expect(body.limit).toBe(20);
  });

  it('serves the next page at an offset and reports the end of the list', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/categories/${evalsId}/bookmarks?offset=20`,
    });
    const body = res.json() as { bookmarks: unknown[]; hasMore: boolean; offset: number };
    expect(body.bookmarks).toHaveLength(5);
    expect(body.hasMore).toBe(false);
    expect(body.offset).toBe(20);
  });

  it('pages the read-state-filtered set (unread) with a matching total', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/categories/${evalsId}/bookmarks?filter=unread`,
    });
    const body = res.json() as {
      bookmarks: { read: boolean }[];
      total: number;
      hasMore: boolean;
    };
    expect(body.total).toBe(15);
    expect(body.bookmarks).toHaveLength(15);
    expect(body.bookmarks.every((b) => b.read === false)).toBe(true);
    expect(body.hasMore).toBe(false);
  });

  it('pages the read-state-filtered set (read)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/categories/${evalsId}/bookmarks?filter=read`,
    });
    const body = res.json() as { bookmarks: { read: boolean }[]; total: number };
    expect(body.total).toBe(10);
    expect(body.bookmarks).toHaveLength(10);
    expect(body.bookmarks.every((b) => b.read === true)).toBe(true);
  });

  it('clamps a client-supplied limit to the configured page size', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/categories/${evalsId}/bookmarks?limit=1000`,
    });
    const body = res.json() as { bookmarks: unknown[]; limit: number };
    expect(body.limit).toBe(20);
    expect(body.bookmarks).toHaveLength(20);
  });
});

describe('bookmark list exposes the primary article link', () => {
  let db: Database;
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it('adds articleUrl when the post text contains a link, and null otherwise', async () => {
    db = new Database(':memory:');
    const when = new Date().toISOString();
    const evals = db.getOrCreateCategory('Evals', null, when);
    db.storeCategorizedBatch(
      [
        { ...bm('1'), text: 'Great read: https://example.com/articles/one' },
        { ...bm('2'), text: 'Just thoughts, no links here.' },
      ],
      () => [evals.id],
    );
    app = buildServer(db);
    await app.ready();

    const res = await app.inject({ method: 'GET', url: `/api/categories/${evals.id}/bookmarks` });
    const body = res.json() as { bookmarks: { postId: string; articleUrl: string | null }[] };
    const byId = new Map(body.bookmarks.map((b) => [b.postId, b.articleUrl]));
    expect(byId.get('1')).toBe('https://example.com/articles/one');
    expect(byId.get('2')).toBeNull();
  });
});

describe('GET /api/bookmarks/:id/article', () => {
  let db: Database;
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
    db.close();
  });

  function setup(fetcher: ArticleFetcher) {
    db = new Database(':memory:');
    const when = new Date().toISOString();
    const evals = db.getOrCreateCategory('Evals', null, when);
    db.storeCategorizedBatch(
      [
        { ...bm('1'), text: 'Read this: https://example.com/articles/one' },
        { ...bm('2'), text: 'No link in this one.' },
      ],
      () => [evals.id],
    );
    app = buildServer(db, { articleFetcher: fetcher });
    return app.ready();
  }

  it('returns 404 for an unknown bookmark and 400 for a bad id', async () => {
    await setup(new FakeArticleFetcher({ status: 'failed', reason: 'unused' }));
    expect((await app.inject({ method: 'GET', url: '/api/bookmarks/9999/article' })).statusCode).toBe(
      404,
    );
    expect((await app.inject({ method: 'GET', url: '/api/bookmarks/abc/article' })).statusCode).toBe(
      400,
    );
  });

  it('returns 404 for a bookmark whose post has no article link (fetcher never called)', async () => {
    const fetcher = new FakeArticleFetcher({ status: 'failed', reason: 'unused' });
    await setup(fetcher);
    const b2 = db.getBookmarkByPostId('2')!;
    const res = await app.inject({ method: 'GET', url: `/api/bookmarks/${b2.id}/article` });
    expect(res.statusCode).toBe(404);
    expect(fetcher.calls).toHaveLength(0);
  });

  it('fetches, caches, and returns a successful extraction', async () => {
    const fetcher = new FakeArticleFetcher({
      status: 'ok',
      title: 'A Great Article',
      contentHtml: '<p>Body</p>',
      excerpt: 'Body',
      siteName: 'Example',
    });
    await setup(fetcher);
    const b1 = db.getBookmarkByPostId('1')!;

    const res = await app.inject({ method: 'GET', url: `/api/bookmarks/${b1.id}/article` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { article: { status: string; title: string; url: string } };
    expect(body.article.status).toBe('ok');
    expect(body.article.title).toBe('A Great Article');
    expect(body.article.url).toBe('https://example.com/articles/one');
    expect(fetcher.calls).toEqual(['https://example.com/articles/one']);

    // Cached in the DB after the first fetch.
    expect(db.getArticleForBookmark(b1.id)?.status).toBe('ok');
  });

  it('serves the cached article on a second request without calling the fetcher again', async () => {
    const fetcher = new FakeArticleFetcher({
      status: 'ok',
      title: 'A Great Article',
      contentHtml: '<p>Body</p>',
      excerpt: null,
      siteName: null,
    });
    await setup(fetcher);
    const b1 = db.getBookmarkByPostId('1')!;

    await app.inject({ method: 'GET', url: `/api/bookmarks/${b1.id}/article` });
    const second = await app.inject({ method: 'GET', url: `/api/bookmarks/${b1.id}/article` });

    expect(second.statusCode).toBe(200);
    expect(fetcher.calls).toHaveLength(1); // still just the first call - cache hit path
    const body = second.json() as { article: { title: string } };
    expect(body.article.title).toBe('A Great Article');
  });

  it('returns a graceful failure result (200, status: failed) rather than an error for an unreachable/non-article page', async () => {
    const fetcher = new FakeArticleFetcher({
      status: 'failed',
      reason: 'Could not fetch this page. It may be blocked, offline, or require a login.',
    });
    await setup(fetcher);
    const b1 = db.getBookmarkByPostId('1')!;

    const res = await app.inject({ method: 'GET', url: `/api/bookmarks/${b1.id}/article` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { article: { status: string; reason: string; title: string | null } };
    expect(body.article.status).toBe('failed');
    expect(body.article.reason).toMatch(/blocked|offline|login/);
    expect(body.article.title).toBeNull();

    // The failure is cached too, so a dead link isn't re-fetched on every open.
    const again = await app.inject({ method: 'GET', url: `/api/bookmarks/${b1.id}/article` });
    expect(again.statusCode).toBe(200);
    expect(fetcher.calls).toHaveLength(1);
  });
});

describe('GET /api/summary-status', () => {
  let db: Database;
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it('reports unavailable when no summary generator is configured', async () => {
    db = new Database(':memory:');
    app = buildServer(db);
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/api/summary-status' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ available: false });
  });

  it('reports available when a summary generator is configured', async () => {
    db = new Database(':memory:');
    app = buildServer(db, { summaryGenerator: new FakeSummaryGenerator('x') });
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/api/summary-status' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ available: true });
  });
});

describe('GET /api/bookmarks/:id/summary', () => {
  let db: Database;
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
    db.close();
  });

  function setup(opts: { summaryGenerator?: SummaryGenerator; articleFetcher?: ArticleFetcher }) {
    db = new Database(':memory:');
    const when = new Date().toISOString();
    const evals = db.getOrCreateCategory('Evals', null, when);
    db.storeCategorizedBatch(
      [
        { ...bm('1'), text: 'Just some thoughts, no links here.' },
        { ...bm('2'), text: 'Read this: https://example.com/articles/one' },
      ],
      () => [evals.id],
    );
    app = buildServer(db, opts);
    return app.ready();
  }

  it('returns 404 for an unknown bookmark and 400 for a bad id', async () => {
    await setup({ summaryGenerator: new FakeSummaryGenerator('unused') });
    expect((await app.inject({ method: 'GET', url: '/api/bookmarks/9999/summary' })).statusCode).toBe(
      404,
    );
    expect((await app.inject({ method: 'GET', url: '/api/bookmarks/abc/summary' })).statusCode).toBe(
      400,
    );
  });

  it('degrades gracefully (503, clear message) when no CLAUDE_CODE_OAUTH_TOKEN/generator is configured', async () => {
    await setup({});
    const b1 = db.getBookmarkByPostId('1')!;
    const res = await app.inject({ method: 'GET', url: `/api/bookmarks/${b1.id}/summary` });
    expect(res.statusCode).toBe(503);
    const body = res.json() as { error: string };
    expect(body.error).toMatch(/av inject/i);
    // Never cached: a token becoming available later should still work.
    expect(db.getSummaryForBookmark(b1.id)).toBeUndefined();
  });

  it('generates, caches, and returns a summary for a post with no article link', async () => {
    const generator = new FakeSummaryGenerator('A concise summary of the post.');
    await setup({ summaryGenerator: generator });
    const b1 = db.getBookmarkByPostId('1')!;

    const res = await app.inject({ method: 'GET', url: `/api/bookmarks/${b1.id}/summary` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { summary: { summary: string; bookmarkId: number } };
    expect(body.summary.summary).toBe('A concise summary of the post.');
    expect(generator.calls).toHaveLength(1);
    expect(generator.calls[0].articleText).toBeNull();

    // Cached in the DB after the first generation.
    expect(db.getSummaryForBookmark(b1.id)?.summary).toBe('A concise summary of the post.');
  });

  it('serves the cached summary on a second request without calling the generator again', async () => {
    const generator = new FakeSummaryGenerator('Cached summary.');
    await setup({ summaryGenerator: generator });
    const b1 = db.getBookmarkByPostId('1')!;

    await app.inject({ method: 'GET', url: `/api/bookmarks/${b1.id}/summary` });
    const second = await app.inject({ method: 'GET', url: `/api/bookmarks/${b1.id}/summary` });

    expect(second.statusCode).toBe(200);
    expect(generator.calls).toHaveLength(1); // still just the first call - cache hit path
    const body = second.json() as { summary: { summary: string } };
    expect(body.summary.summary).toBe('Cached summary.');
  });

  it('fetches the linked article and passes its content to the generator (article-aware summary)', async () => {
    const generator = new FakeSummaryGenerator('An article-aware summary.');
    const fetcher = new FakeArticleFetcher({
      status: 'ok',
      title: 'A Great Article',
      contentHtml: '<p>Article body.</p>',
      excerpt: 'Article body.',
      siteName: 'Example',
    });
    await setup({ summaryGenerator: generator, articleFetcher: fetcher });
    const b2 = db.getBookmarkByPostId('2')!;

    const res = await app.inject({ method: 'GET', url: `/api/bookmarks/${b2.id}/summary` });
    expect(res.statusCode).toBe(200);
    expect(fetcher.calls).toEqual(['https://example.com/articles/one']);
    expect(generator.calls[0].articleTitle).toBe('A Great Article');
    expect(generator.calls[0].articleText).toContain('Article body.');
    // The article fetch is cached too, reusing the reader-view cache.
    expect(db.getArticleForBookmark(b2.id)?.status).toBe('ok');
  });

  it('returns 502 (not a crash) when the generator fails, and does not cache the failure', async () => {
    const generator = new FakeSummaryGenerator(new Error('claude CLI exited with code 1'));
    await setup({ summaryGenerator: generator });
    const b1 = db.getBookmarkByPostId('1')!;

    const res = await app.inject({ method: 'GET', url: `/api/bookmarks/${b1.id}/summary` });
    expect(res.statusCode).toBe(502);
    expect(db.getSummaryForBookmark(b1.id)).toBeUndefined();
  });
});
