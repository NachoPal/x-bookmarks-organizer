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
