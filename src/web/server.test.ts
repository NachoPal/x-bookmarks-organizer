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

  it('POST /api/bookmarks/:id/favorite stars, unstars and persists the flag', async () => {
    const b1 = db.getBookmarkByPostId('1')!;
    const res = await app.inject({ method: 'POST', url: `/api/bookmarks/${b1.id}/favorite` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { bookmark: { favorite: boolean } }).bookmark.favorite).toBe(true);
    expect(db.getBookmarkById(b1.id)!.favorite).toBe(true);

    const off = await app.inject({
      method: 'POST',
      url: `/api/bookmarks/${b1.id}/favorite`,
      payload: { favorite: false },
    });
    expect((off.json() as { bookmark: { favorite: boolean } }).bookmark.favorite).toBe(false);
    expect(db.getBookmarkById(b1.id)!.favorite).toBe(false);
  });

  it('POST /api/bookmarks/:id/favorite 404s an unknown bookmark and 400s a bad id', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/bookmarks/9999/favorite' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/bookmarks/abc/favorite' })).statusCode).toBe(400);
  });

  it('the bookmark list carries each favorite flag, and the filter returns only starred posts', async () => {
    const evals = db.getAllCategories().find((c) => c.name === 'Evals')!;
    const b1 = db.getBookmarkByPostId('1')!;
    await app.inject({ method: 'POST', url: `/api/bookmarks/${b1.id}/favorite` });

    type Payload = {
      bookmarks: { postId: string; favorite: boolean }[];
      counts: { total: number; unread: number; favorite: number };
      total: number;
    };
    const all = (
      await app.inject({ method: 'GET', url: `/api/categories/${evals.id}/bookmarks` })
    ).json() as Payload;
    expect(all.bookmarks.find((b) => b.postId === '1')!.favorite).toBe(true);
    expect(all.bookmarks.find((b) => b.postId === '2')!.favorite).toBe(false);
    expect(all.counts.favorite).toBe(1);

    const favorites = (
      await app.inject({
        method: 'GET',
        url: `/api/categories/${evals.id}/bookmarks?filter=favorite`,
      })
    ).json() as Payload;
    expect(favorites.bookmarks.map((b) => b.postId)).toEqual(['1']);
    expect(favorites.total).toBe(1); // the filtered total, so paging stops at the right place
    expect(favorites.bookmarks.every((b) => b.favorite)).toBe(true);
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
      counts: { total: number; unread: number; favorite: number };
      total: number;
      hasMore: boolean;
      offset: number;
      limit: number;
    };
    expect(body.bookmarks).toHaveLength(20);
    expect(body.counts).toEqual({ total: 25, unread: 15, favorite: 0 });
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

describe('bookmark list exposes hasSummary', () => {
  let db: Database;
  let app: FastifyInstance;
  let evalsId: number;

  beforeEach(async () => {
    db = new Database(':memory:');
    const when = new Date().toISOString();
    const evals = db.getOrCreateCategory('Evals', null, when);
    evalsId = evals.id;
    db.storeCategorizedBatch([bm('1'), bm('2')], () => [evals.id]);
    const b1 = db.getBookmarkByPostId('1')!;
    db.saveSummary({ bookmarkId: b1.id, summary: 'A summary.', generatedAt: when });
    app = buildServer(db);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it('sets hasSummary true for a bookmark with a saved summary, false otherwise', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/categories/${evalsId}/bookmarks` });
    const body = res.json() as { bookmarks: { postId: string; hasSummary: boolean }[] };
    const byId = new Map(body.bookmarks.map((b) => [b.postId, b.hasSummary]));
    expect(byId.get('1')).toBe(true);
    expect(byId.get('2')).toBe(false);
  });

  it('never includes the summary text itself in the list payload', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/categories/${evalsId}/bookmarks` });
    const body = res.json() as { bookmarks: Record<string, unknown>[] };
    for (const b of body.bookmarks) expect(b.summary).toBeUndefined();
  });
});


describe('GET /api/summary-status', () => {
  let db: Database;
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it('reports unavailable, with a reason, when no summary generator is configured', async () => {
    db = new Database(':memory:');
    app = buildServer(db);
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/api/summary-status' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { available: boolean; reason: string };
    expect(body.available).toBe(false);
    expect(body.reason).toMatch(/provider/i);
  });

  it("surfaces the provider adapter's own reason so the tooltip says what to fix", async () => {
    db = new Database(':memory:');
    app = buildServer(db, { summaryUnavailableReason: 'The `claude` CLI was not found.' });
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/api/summary-status' });
    expect(res.json()).toEqual({
      available: false,
      reason: 'The `claude` CLI was not found.',
    });
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
        // A bare-link post: the whole text is a t.co URL and nothing else.
        { ...bm('3'), text: 'https://t.co/aBcD1234Xy' },
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

  it('degrades gracefully (503, clear message) when no LLM provider is available', async () => {
    await setup({});
    const b1 = db.getBookmarkByPostId('1')!;
    const res = await app.inject({ method: 'GET', url: `/api/bookmarks/${b1.id}/summary` });
    expect(res.statusCode).toBe(503);
    const body = res.json() as { error: string };
    expect(body.error).toMatch(/provider/i);
    // Never cached: a provider becoming available later should still work.
    expect(db.getSummaryForBookmark(b1.id)).toBeUndefined();
  });

  it("forwards the adapter's actionable message (502) when a configured provider's call fails", async () => {
    const failing: SummaryGenerator = {
      async summarize() {
        throw new Error(
          "Couldn't reach Claude: the CLI exited with code 1. Make sure the `claude` CLI is installed and logged in.",
        );
      },
    };
    await setup({ summaryGenerator: failing });
    const b1 = db.getBookmarkByPostId('1')!;
    const res = await app.inject({ method: 'GET', url: `/api/bookmarks/${b1.id}/summary` });
    expect(res.statusCode).toBe(502);
    expect((res.json() as { error: string }).error).toMatch(/Couldn't reach Claude/);
    // A failed call is never cached, so a retry can still succeed.
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

  // Regression for the "I can't access external URLs, so I'm unable to read the
  // content of that X post" refusal the owner saw in the summary modal. The
  // `claude-cli` adapter runs hardened with `--tools ""` (no web fetch, by
  // design), so a prompt whose only content is a link is unanswerable: the
  // model asked for the text to be pasted in, and that refusal was then stored
  // as the bookmark's summary. The endpoint must settle this itself instead.
  it('returns a clean "nothing to summarize" message, without calling the model, for a bare-link post whose link is not a readable article', async () => {
    const generator = new FakeSummaryGenerator('should never be generated');
    const fetcher = new FakeArticleFetcher({
      status: 'failed',
      reason: 'This link points to a post on X, not an article.',
    });
    await setup({ summaryGenerator: generator, articleFetcher: fetcher });
    const b3 = db.getBookmarkByPostId('3')!;

    const res = await app.inject({ method: 'GET', url: `/api/bookmarks/${b3.id}/summary` });

    expect(res.statusCode).toBe(422);
    const body = res.json() as { error: string };
    expect(body.error).toMatch(/nothing to summarize/i);
    expect(body.error).not.toMatch(/paste|unable to read|can't access/i);
    // The model is never asked to summarize a URL it cannot open...
    expect(generator.calls).toHaveLength(0);
    // ...and nothing is cached, so a later backfill of the link's metadata can
    // still produce a real summary.
    expect(db.getSummaryForBookmark(b3.id)).toBeUndefined();
  });

  it('summarizes a bare-link post from the cached link metadata when the article body could not be read', async () => {
    const generator = new FakeSummaryGenerator('A metadata-based summary.');
    const fetcher = new FakeArticleFetcher({ status: 'failed', reason: 'Fetch timed out.' });
    await setup({ summaryGenerator: generator, articleFetcher: fetcher });
    db.saveArticleLinkMetadata({
      url: 'https://t.co/aBcD1234Xy',
      status: 'ok',
      title: 'Why Evals Beat Vibes',
      description: 'A case for treating prompt edits like code edits.',
      image: null,
      siteName: 'Example',
      resolvedUrl: 'https://example.com/evals',
      fetchedAt: new Date().toISOString(),
    });
    const b3 = db.getBookmarkByPostId('3')!;

    const res = await app.inject({ method: 'GET', url: `/api/bookmarks/${b3.id}/summary` });

    expect(res.statusCode).toBe(200);
    expect(generator.calls).toHaveLength(1);
    expect(generator.calls[0].articleTitle).toBe('Why Evals Beat Vibes');
    expect(generator.calls[0].articleDescription).toBe(
      'A case for treating prompt edits like code edits.',
    );
    expect(generator.calls[0].articleSiteName).toBe('Example');
  });

  it('summarizes a bare-link post from a card-only cache row (no readable article at all - issue #45)', async () => {
    const generator = new FakeSummaryGenerator('A card-based summary.');
    const fetcher = new FakeArticleFetcher({
      status: 'failed',
      reason: 'This page does not look like a readable article.',
    });
    await setup({ summaryGenerator: generator, articleFetcher: fetcher });
    db.saveArticleLinkMetadata({
      url: 'https://t.co/aBcD1234Xy',
      status: 'card',
      title: 'A Tool, Not An Article',
      description: 'One place every agent plugs into every tool you already use.',
      image: null,
      siteName: null,
      resolvedUrl: 'https://tool.example.com/',
      fetchedAt: new Date().toISOString(),
    });
    const b3 = db.getBookmarkByPostId('3')!;

    const res = await app.inject({ method: 'GET', url: `/api/bookmarks/${b3.id}/summary` });

    expect(res.statusCode).toBe(200);
    expect(generator.calls).toHaveLength(1);
    expect(generator.calls[0].articleTitle).toBe('A Tool, Not An Article');
    expect(generator.calls[0].articleText).toBeNull();
    // With no og:site_name, the resolved destination's domain stands in.
    expect(generator.calls[0].articleSiteName).toBe('tool.example.com');
    expect((res.json() as { summary: { summary: string } }).summary.summary).toBe('A card-based summary.');
  });

  it('still summarizes a post that has prose alongside its link', async () => {
    const generator = new FakeSummaryGenerator('A summary from the prose.');
    const fetcher = new FakeArticleFetcher({ status: 'failed', reason: 'Fetch timed out.' });
    await setup({ summaryGenerator: generator, articleFetcher: fetcher });
    const b2 = db.getBookmarkByPostId('2')!;

    const res = await app.inject({ method: 'GET', url: `/api/bookmarks/${b2.id}/summary` });

    expect(res.statusCode).toBe(200);
    expect(generator.calls).toHaveLength(1);
    expect((res.json() as { summary: { summary: string } }).summary.summary).toBe(
      'A summary from the prose.',
    );
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

describe('X-native Articles in the viewer API', () => {
  let db: Database;
  let app: FastifyInstance;

  const xArticle = {
    restId: '777',
    title: 'An X Article',
    previewText: 'Its preview text.',
    plainText: 'The full plain-text body of the X Article.',
    coverUrl: 'https://pbs.twimg.com/media/c.jpg',
    coverWidth: 1500,
    coverHeight: 600,
  };

  async function setup(opts: { summaryGenerator?: SummaryGenerator; articleFetcher?: ArticleFetcher } = {}) {
    db = new Database(':memory:');
    const cat = db.getOrCreateCategory('Articles', null, new Date().toISOString());
    db.storeCategorizedBatch(
      [
        // An Article host post whose text is only its t.co link.
        { ...bm('1'), text: 'https://t.co/aBcD1234Xy', xArticle },
        { ...bm('2'), text: 'Worth a read https://t.co/q', quotedPostId: '9', quotedXArticle: { ...xArticle, restId: null, title: 'Quoted one', coverUrl: null } },
        bm('3'),
      ],
      () => [cat.id],
    );
    app = buildServer(db, opts);
    await app.ready();
    return cat.id;
  }

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it('exposes xArticle (own and quoted) on each bookmark, without the body, and null otherwise', async () => {
    const catId = await setup();
    const res = await app.inject({ method: 'GET', url: `/api/categories/${catId}/bookmarks` });
    const byPostId = new Map(
      (res.json() as { bookmarks: { postId: string; xArticle: Record<string, unknown> | null }[] }).bookmarks.map(
        (b) => [b.postId, b.xArticle],
      ),
    );
    expect(byPostId.get('1')).toEqual({
      title: 'An X Article',
      previewText: 'Its preview text.',
      coverUrl: 'https://pbs.twimg.com/media/c.jpg',
      coverWidth: 1500,
      coverHeight: 600,
      url: 'https://x.com/i/article/777',
      quoted: false,
    });
    expect(byPostId.get('2')).toMatchObject({ title: 'Quoted one', quoted: true, url: 'https://x.com/i/web/status/9' });
    expect(byPostId.get('3')).toBeNull();
  });

  it('summarizes an article-only post from its X Article body instead of answering 422', async () => {
    const generator = new FakeSummaryGenerator('A summary of the X Article.');
    const fetcher = new FakeArticleFetcher({ status: 'failed', reason: 'unused' });
    await setup({ summaryGenerator: generator, articleFetcher: fetcher });
    const b1 = db.getBookmarkByPostId('1')!;

    const res = await app.inject({ method: 'GET', url: `/api/bookmarks/${b1.id}/summary` });
    expect(res.statusCode).toBe(200);
    expect(generator.calls[0]).toMatchObject({
      articleTitle: 'An X Article',
      articleText: 'The full plain-text body of the X Article.',
      articleSiteName: 'X Article',
    });
    // Its t.co link only leads back to x.com: never fetched.
    expect(fetcher.calls).toEqual([]);
  });
});

describe('bookmark content API', () => {
  let db: Database;
  let app: FastifyInstance;

  const xArticle = {
    restId: '777',
    title: 'An X Article',
    previewText: 'Its preview text.',
    plainText: 'The full plain-text body of the X Article.',
    coverUrl: null,
    coverWidth: null,
    coverHeight: null,
  };

  beforeEach(async () => {
    db = new Database(':memory:');
    const cat = db.getOrCreateCategory('AI', null, new Date().toISOString());
    db.storeCategorizedBatch(
      [
        bm('1'),
        {
          ...bm('2'),
          text: 'Worth a read',
          quotedPostId: '9',
          quotedPost: { postId: '9', authorUsername: 'bob', authorName: 'Bob', text: 'The original', createdAt: '2024-01-01' },
        },
        { ...bm('3'), text: 'See https://t.co/aBcD1234Xy' },
        { ...bm('4'), text: 'https://t.co/xArt', quotedPostId: '10', quotedXArticle: xArticle },
      ],
      () => [cat.id],
    );
    db.saveArticleLinkMetadata({
      url: 'https://t.co/aBcD1234Xy',
      status: 'ok',
      title: 'Why Evals Beat Vibes',
      description: 'A case for treating prompt edits like code edits.',
      image: null,
      siteName: 'Example',
      resolvedUrl: 'https://example.com/evals',
      fetchedAt: new Date().toISOString(),
    });
    db.saveArticle({
      bookmarkId: db.getBookmarkByPostId('3')!.id,
      url: 'https://t.co/aBcD1234Xy',
      status: 'ok',
      title: 'Why Evals Beat Vibes',
      contentHtml: '<p>The full extracted body.</p>',
      excerpt: null,
      siteName: 'Example',
      reason: null,
      fetchedAt: new Date().toISOString(),
    });
    app = buildServer(db);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it('GET /api/bookmarks/:id/content assembles labeled parts, with null parts null', async () => {
    const b1 = db.getBookmarkByPostId('1')!;
    const res = await app.inject({ method: 'GET', url: `/api/bookmarks/${b1.id}/content` });
    expect(res.statusCode).toBe(200);
    const { content } = res.json() as { content: Record<string, unknown> };
    expect(content).toMatchObject({
      bookmarkId: b1.id,
      postId: '1',
      post: { kind: 'post', authorUsername: 'a', authorName: 'A', text: 't-1' },
      quotedPost: null,
      linkedArticle: null,
      xArticle: null,
    });
  });

  it('includes a labeled quotedPost for a quoted ordinary post', async () => {
    const b2 = db.getBookmarkByPostId('2')!;
    const res = await app.inject({ method: 'GET', url: `/api/bookmarks/${b2.id}/content` });
    const { content } = res.json() as { content: { quotedPost: unknown } };
    expect(content.quotedPost).toEqual({ kind: 'quoted-post', authorUsername: 'bob', authorName: 'Bob', text: 'The original' });
  });

  it('includes the cached external-article body only when the reader-view cache has one', async () => {
    const b3 = db.getBookmarkByPostId('3')!;
    const res = await app.inject({ method: 'GET', url: `/api/bookmarks/${b3.id}/content` });
    const { content } = res.json() as { content: { linkedArticle: unknown } };
    expect(content.linkedArticle).toMatchObject({
      kind: 'external-article',
      url: 'https://example.com/evals',
      title: 'Why Evals Beat Vibes',
      description: 'A case for treating prompt edits like code edits.',
    });
    expect((content.linkedArticle as { body: string }).body).toContain('The full extracted body.');
  });

  it('resolves a quoted X Article as the xArticle part, not quotedPost', async () => {
    const b4 = db.getBookmarkByPostId('4')!;
    const res = await app.inject({ method: 'GET', url: `/api/bookmarks/${b4.id}/content` });
    const { content } = res.json() as { content: { xArticle: unknown; quotedPost: unknown } };
    expect(content.xArticle).toEqual({
      kind: 'x-article',
      title: 'An X Article',
      previewText: 'Its preview text.',
      body: 'The full plain-text body of the X Article.',
      quoted: true,
    });
    expect(content.quotedPost).toBeNull();
  });

  it('404s for an unknown bookmark id', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/bookmarks/999999/content' });
    expect(res.statusCode).toBe(404);
  });

  it('GET /api/content pages the structured content of every bookmark', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/content?limit=2&offset=0' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { content: { postId: string }[]; total: number; hasMore: boolean };
    expect(body.content).toHaveLength(2);
    expect(body.total).toBe(4);
    expect(body.hasMore).toBe(true);
  });
});

describe('ranking score on the bookmark API (issue #62)', () => {
  let db: Database;
  let app: FastifyInstance;
  let categoryId: number;

  beforeEach(async () => {
    db = new Database(':memory:');
    categoryId = db.getOrCreateCategory('AI', null, '2024-01-01T00:00:00.000Z').id;
    db.storeCategorizedBatch([bm('low')], () => [categoryId], '2024-01-01T00:00:00.000Z');
    db.storeCategorizedBatch([bm('high')], () => [categoryId], '2024-01-02T00:00:00.000Z');
    app = buildServer(db);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  function score(postId: string, value: number): void {
    db.saveBookmarkScore({
      bookmarkId: db.getBookmarkByPostId(postId)!.id,
      score: value,
      confidence: 0.8,
      dimensions: { learning_value: value },
      model: 'jev-1.13.0',
      rubricVersion: 'v1',
      scoredAt: '2026-01-01T00:00:00.000Z',
    });
  }

  it('ships score: null for a library that was never ranked, and keeps the default ordering', async () => {
    const res = await app.inject({ url: `/api/categories/${categoryId}/bookmarks` });
    const body = res.json() as { sort: string; bookmarks: { postId: string; score: unknown }[] };
    expect(body.sort).toBe('recent');
    expect(body.bookmarks.map((b) => b.postId)).toEqual(['high', 'low']);
    expect(body.bookmarks.every((b) => b.score === null)).toBe(true);
  });

  it('exposes the stored score, its confidence and its per-dimension breakdown', async () => {
    score('high', 0.9);
    const res = await app.inject({ url: `/api/categories/${categoryId}/bookmarks` });
    const body = res.json() as { bookmarks: { postId: string; score: unknown }[] };
    expect(body.bookmarks.find((b) => b.postId === 'high')!.score).toEqual({
      value: 0.9,
      confidence: 0.8,
      dimensions: { learning_value: 0.9 },
    });
    expect(body.bookmarks.find((b) => b.postId === 'low')!.score).toBeNull();
  });

  it('orders by score with ?sort=score, unscored last', async () => {
    score('low', 0.1);
    score('high', 0.9);
    db.storeCategorizedBatch([bm('unranked')], () => [categoryId], '2024-01-03T00:00:00.000Z');

    const res = await app.inject({ url: `/api/categories/${categoryId}/bookmarks?sort=score` });
    const body = res.json() as { sort: string; bookmarks: { postId: string }[] };
    expect(body.sort).toBe('score');
    expect(body.bookmarks.map((b) => b.postId)).toEqual(['high', 'low', 'unranked']);
  });

  it('falls back to recency for an unrecognized sort, never silently reordering the library', async () => {
    score('low', 0.1);
    const res = await app.inject({ url: `/api/categories/${categoryId}/bookmarks?sort=whatever` });
    const body = res.json() as { sort: string; bookmarks: { postId: string }[] };
    expect(body.sort).toBe('recent');
    expect(body.bookmarks.map((b) => b.postId)).toEqual(['high', 'low']);
  });

  it('keeps the filter and the counts intact when sorting by score', async () => {
    score('high', 0.9);
    db.markRead(db.getBookmarkByPostId('high')!.id);
    const res = await app.inject({
      url: `/api/categories/${categoryId}/bookmarks?sort=score&filter=unread`,
    });
    const body = res.json() as {
      counts: { total: number; unread: number };
      total: number;
      bookmarks: { postId: string }[];
    };
    expect(body.bookmarks.map((b) => b.postId)).toEqual(['low']);
    expect(body.counts).toMatchObject({ total: 2, unread: 1 });
    expect(body.total).toBe(1);
  });

  it('reports how much of the library is ranked, so the viewer can say whether sorting will order anything', async () => {
    score('high', 0.9);
    const res = await app.inject({ url: '/api/setup' });
    // Since issue #80 the same block also carries what the in-app "Rank now"
    // control needs; this server is built without the ranking wiring, so it
    // reports the pass as unavailable rather than offering a paid button.
    expect((res.json() as { ranking: unknown }).ranking).toMatchObject({
      scored: 1,
      total: 2,
      available: false,
      pending: 0,
      blocker: null,
      status: null,
    });
  });
});

describe('PUT /api/bookmarks/:id/category (issue #92)', () => {
  let db: Database;
  let app: FastifyInstance;
  let ai: number;
  let evals: number;
  let design: number;
  let id: number;

  beforeEach(async () => {
    db = new Database(':memory:');
    const when = new Date().toISOString();
    ai = db.getOrCreateCategory('AI', null, when).id;
    evals = db.getOrCreateCategory('Evals', ai, when).id;
    design = db.getOrCreateCategory('Design', null, when).id;
    db.storeCategorizedBatch([bm('1')], () => [evals, design]);
    id = db.getBookmarkByPostId('1')!.id;
    // No sync/rank wiring: the move must work on a plain buildServer(db).
    app = buildServer(db);
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    db.close();
  });

  const move = (bookmarkId: number | string, body: unknown) =>
    app.inject({
      method: 'PUT',
      url: `/api/bookmarks/${bookmarkId}/category`,
      payload: body as object,
    });

  it('re-files the post under exactly the chosen category', async () => {
    const res = await move(id, { categoryId: ai });
    expect(res.statusCode).toBe(200);
    expect(res.json().categoryIds).toEqual([ai]);
    expect(db.getCategoryIdsForBookmarks([id]).get(id)).toEqual([ai]);
    expect(db.getCategoryBookmarkCounts(design).total).toBe(0);
    expect(db.getCategoryBookmarkCounts(ai).total).toBe(1);
  });

  it('is what the bookmark list then reports as the post categories', async () => {
    await move(id, { categoryId: ai });
    const list = await app.inject({ url: `/api/categories/${ai}/bookmarks` });
    expect(list.json().bookmarks[0].categoryIds).toEqual([ai]);
    const gone = await app.inject({ url: `/api/categories/${design}/bookmarks` });
    expect(gone.json().bookmarks).toHaveLength(0);
  });

  it('rejects an unknown category id and changes nothing', async () => {
    const res = await move(id, { categoryId: 9999 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('9999');
    expect(db.getCategoryIdsForBookmarks([id]).get(id)!.sort()).toEqual([evals, design].sort());
  });

  it('rejects a missing or malformed target', async () => {
    expect((await move(id, {})).statusCode).toBe(400);
    expect((await move(id, { categoryId: 'AI' })).statusCode).toBe(400);
    expect((await move(id, { categoryId: 1.5 })).statusCode).toBe(400);
    expect((await move(id, { categoryId: null })).statusCode).toBe(400);
    expect(db.getCategoryIdsForBookmarks([id]).get(id)).toHaveLength(2);
  });

  it('404s for an unknown bookmark and 400s for a malformed id', async () => {
    expect((await move(4242, { categoryId: ai })).statusCode).toBe(404);
    expect((await move('abc', { categoryId: ai })).statusCode).toBe(400);
  });

  it('keeps read state and the favorite star across the move', async () => {
    await app.inject({ method: 'POST', url: `/api/bookmarks/${id}/read`, payload: { read: true } });
    await app.inject({
      method: 'POST',
      url: `/api/bookmarks/${id}/favorite`,
      payload: { favorite: true },
    });
    const res = await move(id, { categoryId: ai });
    expect(res.json().bookmark.read).toBe(true);
    expect(res.json().bookmark.favorite).toBe(true);
  });
});
