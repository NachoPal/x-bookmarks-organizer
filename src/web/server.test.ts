import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildServer } from './server';
import { Database } from '../db/database';
import type { FastifyInstance } from 'fastify';
import type { RawBookmark } from '../types';

const bm = (postId: string): RawBookmark => ({
  postId,
  authorUsername: 'a',
  authorName: 'A',
  text: `t-${postId}`,
  url: `https://x.com/a/status/${postId}`,
  postCreatedAt: '',
});

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
