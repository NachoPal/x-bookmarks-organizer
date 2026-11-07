import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from './server';
import { Database } from '../db/database';
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

describe('GET /api/search', () => {
  let db: Database;
  let app: FastifyInstance;
  const when = '2024-06-01T00:00:00.000Z';
  let ai: number;
  let agents: number;

  beforeEach(async () => {
    db = new Database(':memory:');
    ai = db.getOrCreateCategory('AI', null, when).id;
    agents = db.getOrCreateCategory('Agents', ai, when).id;
    db.storeCategorizedBatch(
      [
        bm('1', 'agent harness evaluation', { authorUsername: 'karpathy' }),
        bm('2', 'sourdough bread notes'),
      ],
      (b) => (b.postId === '1' ? [agents] : []),
      when,
    );
    app = buildServer(db, { pageSize: 20 });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it('lists matches with a total and the post text matched', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/search?q=evaluation' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { total: number; bookmarks: { postId: string }[]; mode: string; query: string };
    expect(body.total).toBe(1);
    expect(body.bookmarks[0]!.postId).toBe('1');
    expect(body.mode).toBe('all');
    expect(body.query).toBe('evaluation');
  });

  it('supports from:, category: and exclusion through the q parameter', async () => {
    const fromRes = await app.inject({ method: 'GET', url: `/api/search?${new URLSearchParams({ q: 'from:@karpathy' })}` });
    expect((fromRes.json() as { bookmarks: { postId: string }[] }).bookmarks.map((b) => b.postId)).toEqual(['1']);

    const catRes = await app.inject({ method: 'GET', url: `/api/search?${new URLSearchParams({ q: 'category:Agents' })}` });
    expect((catRes.json() as { bookmarks: { postId: string }[] }).bookmarks.map((b) => b.postId)).toEqual(['1']);

    const exclRes = await app.inject({ method: 'GET', url: `/api/search?${new URLSearchParams({ q: '-sourdough' })}` });
    expect((exclRes.json() as { bookmarks: { postId: string }[] }).bookmarks.map((b) => b.postId).sort()).toEqual(['1']);
  });

  it('returns 400 with a clear message for an unknown category: name', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/search?${new URLSearchParams({ q: 'category:Nope' })}` });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toMatch(/No category matches "Nope"/);
  });

  it('lists by filters alone with an empty q', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/search?q=' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { total: number; mode: string };
    expect(body.total).toBe(2);
    expect(body.mode).toBe('none');
  });

  it('orders by sort=recent / sort=score and paginates like a category view', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/search?q=&sort=recent&limit=1&offset=1' });
    const body = res.json() as { bookmarks: unknown[]; limit: number; offset: number; sort: string };
    expect(body.limit).toBe(1);
    expect(body.offset).toBe(1);
    expect(body.sort).toBe('recent');
    expect(body.bookmarks).toHaveLength(1);
  });

  it('defaults sort to relevance', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/search?q=evaluation' });
    expect((res.json() as { sort: string }).sort).toBe('relevance');
  });
});

describe('GET /api/search/authors', () => {
  let db: Database;
  let app: FastifyInstance;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.storeCategorizedBatch(
      [bm('1', 'a', { authorUsername: 'bob' }), bm('2', 'b', { authorUsername: 'Alice' }), bm('3', 'c', { authorUsername: 'bob' })],
      () => [],
      '2024-06-01T00:00:00.000Z',
    );
    app = buildServer(db);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it('lists distinct authors, alphabetically', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/search/authors' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { authors: string[] }).authors).toEqual(['Alice', 'bob']);
  });
});
