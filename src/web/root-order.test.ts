import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildServer } from './server';
import { Database } from '../db/database';
import type { FastifyInstance } from 'fastify';

describe('PUT /api/categories/root-order (issue #82)', () => {
  let db: Database;
  let app: FastifyInstance;
  let ids: Record<string, number>;
  const now = new Date().toISOString();

  beforeEach(() => {
    db = new Database(':memory:');
    ids = {};
    for (const n of ['AI', 'Design', 'Music']) ids[n] = db.getOrCreateCategory(n, null, now).id;
    ids.Child = db.getOrCreateCategory('Child', ids.AI, now).id;
    app = buildServer(db);
  });
  afterEach(async () => {
    await app.close();
    db.close();
  });

  const put = (body: unknown) =>
    app.inject({ method: 'PUT', url: '/api/categories/root-order', payload: body as object });
  const names = async () =>
    ((await app.inject({ url: '/api/tree' })).json().tree as { name: string }[]).map((r) => r.name);

  it('persists the order and applies it to /api/tree, surviving a new root', async () => {
    const res = await put({ ids: [ids.Music, ids.AI, ids.Design] });
    expect(res.statusCode).toBe(200);
    expect(await names()).toEqual(['Music', 'AI', 'Design']);
    db.getOrCreateCategory('Aardvark', null, now);
    expect(await names()).toEqual(['Music', 'AI', 'Design', 'Aardvark']);
  });

  it('rejects a child id, an unknown id, a duplicate and a malformed body', async () => {
    expect((await put({ ids: [ids.Child, ids.AI, ids.Design, ids.Music] })).statusCode).toBe(400);
    expect((await put({ ids: [9999, ids.AI, ids.Design] })).statusCode).toBe(400);
    expect((await put({ ids: [ids.AI, ids.AI, ids.Design] })).statusCode).toBe(400);
    expect((await put({ ids: 'x' })).statusCode).toBe(400);
    expect(await names()).toEqual(['AI', 'Design', 'Music']);
  });

  it('refuses an incomplete list with 409 and changes nothing', async () => {
    expect((await put({ ids: [ids.Music, ids.AI] })).statusCode).toBe(409);
    expect(await names()).toEqual(['AI', 'Design', 'Music']);
  });
});
