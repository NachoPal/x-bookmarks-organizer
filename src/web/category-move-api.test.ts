import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildServer } from './server';
import { Database } from '../db/database';
import { ROOT_ORDER_KEY, readRootOrder } from '../categorize/tree';
import type { FastifyInstance } from 'fastify';
import type { CategoryTreeNode, RawBookmark } from '../types';

const bm = (postId: string): RawBookmark => ({
  postId,
  authorUsername: 'a',
  authorName: 'A',
  text: `t-${postId}`,
  url: `https://x.com/a/status/${postId}`,
  postCreatedAt: '',
});

describe('PUT /api/categories/:id/position (move and reorder at any level)', () => {
  let db: Database;
  let app: FastifyInstance;
  let ids: Record<string, number>;
  const now = new Date().toISOString();

  // AI > { Agents > { Harnesses > { Evals } }, Models }, Design, Music
  beforeEach(() => {
    db = new Database(':memory:');
    ids = {};
    for (const n of ['AI', 'Design', 'Music']) ids[n] = db.getOrCreateCategory(n, null, now).id;
    ids.Agents = db.getOrCreateCategory('Agents', ids.AI, now).id;
    ids.Models = db.getOrCreateCategory('Models', ids.AI, now).id;
    ids.Harnesses = db.getOrCreateCategory('Harnesses', ids.Agents, now).id;
    ids.Evals = db.getOrCreateCategory('Evals', ids.Harnesses, now).id;
    app = buildServer(db, { maxCategoryDepth: 4 });
  });
  afterEach(async () => {
    await app.close();
    db.close();
  });

  const move = (id: number, body: unknown) =>
    app.inject({ method: 'PUT', url: `/api/categories/${id}/position`, payload: body as object });
  const tree = async () => (await app.inject({ url: '/api/tree' })).json().tree as CategoryTreeNode[];
  const outline = async () => {
    const lines: string[] = [];
    const walk = (nodes: CategoryTreeNode[], depth: number) => {
      for (const n of nodes) {
        lines.push(`${'  '.repeat(depth)}${n.name}`);
        walk(n.children, depth + 1);
      }
    };
    walk(await tree(), 0);
    return lines;
  };

  it('serves the depth limit with the tree', async () => {
    expect((await app.inject({ url: '/api/tree' })).json().maxDepth).toBe(4);
  });

  it('reorders the roots and keeps the name-keyed root order in step', async () => {
    const res = await move(ids.Music, { parentId: null, index: 0 });
    expect(res.statusCode).toBe(200);
    expect(res.json().changed).toBe(true);
    expect((await tree()).map((r) => r.name)).toEqual(['Music', 'AI', 'Design']);
    expect(readRootOrder(db)).toEqual(['Music', 'AI', 'Design']);
    // A root a later sync creates follows the owner's arrangement.
    db.getOrCreateCategory('Aardvark', null, now);
    expect((await tree()).map((r) => r.name)).toEqual(['Music', 'AI', 'Design', 'Aardvark']);
  });

  it('reorders children at depth 2 and the order survives a new sibling and a reload', async () => {
    expect((await move(ids.Models, { parentId: ids.AI, index: 0 })).statusCode).toBe(200);
    db.getOrCreateCategory('Aaa', ids.AI, now); // a sync adds one: it goes after, not inside
    const ai = (await tree()).find((r) => r.name === 'AI')!;
    expect(ai.children.map((c) => c.name)).toEqual(['Models', 'Agents', 'Aaa']);
  });

  it('moves a depth-3 category to the root, subtree, links and origin included', async () => {
    db.storeCategorizedBatch([bm('p1')], () => [ids.Evals]);
    db.setCategoryOrigin(ids.Harnesses, 'user');
    const res = await move(ids.Harnesses, { parentId: null, index: 1 });
    expect(res.statusCode).toBe(200);
    expect(res.json().category).toMatchObject({ id: ids.Harnesses, parentId: null, origin: 'user' });
    expect(await outline()).toEqual([
      'AI',
      '  Agents',
      '  Models',
      'Harnesses',
      '  Evals',
      'Design',
      'Music',
    ]);
    expect(readRootOrder(db)).toEqual(['AI', 'Harnesses', 'Design', 'Music']);
    // The post moved with its category: the rolled-up counts follow it.
    const roots = await tree();
    expect(roots.find((r) => r.name === 'Harnesses')!.total).toBe(1);
    expect(roots.find((r) => r.name === 'AI')!.total).toBe(0);
  });

  it('moves a root into a deep node', async () => {
    const res = await move(ids.Music, { parentId: ids.Harnesses, index: 0 });
    expect(res.statusCode).toBe(200);
    const harnesses = (await tree())[0].children[0].children[0];
    expect(harnesses.children.map((c) => c.name)).toEqual(['Music', 'Evals']);
    expect(readRootOrder(db)).toEqual(['AI', 'Design']);
  });

  it('refuses a move into the category itself or its own descendants', async () => {
    for (const parentId of [ids.Agents, ids.Harnesses, ids.Evals]) {
      const res = await move(ids.Agents, { parentId, index: 0 });
      expect(res.statusCode).toBe(400);
      expect(res.json().problem).toBe('cycle');
      expect(res.json().error).toMatch(/can’t go inside itself/);
    }
    expect((await tree())[0].children[0].name).toBe('Agents');
  });

  it('refuses a move that would exceed the configured depth, but not one within it', async () => {
    // Agents has 3 levels (Agents > Harnesses > Evals); under Models it would be 5 deep.
    const res = await move(ids.Agents, { parentId: ids.Models, index: 0 });
    expect(res.statusCode).toBe(400);
    expect(res.json().problem).toBe('depth');
    expect(res.json().error).toBe('That would make the tree 5 levels deep; categories go at most 4 levels deep.');
    // Evals (a leaf) under Models is 3 deep: fine.
    expect((await move(ids.Evals, { parentId: ids.Models, index: 0 })).statusCode).toBe(200);
  });

  it('never refuses a reorder inside a tree the owner already built deeper than the limit', async () => {
    const deep = db.createCategory('Deep', ids.Evals)!; // depth 5, made by hand
    const twin = db.createCategory('Twin', ids.Evals)!;
    expect((await move(twin.id, { parentId: ids.Evals, index: 0 })).statusCode).toBe(200);
    expect((await move(deep.id, { parentId: ids.Harnesses, index: 0 })).statusCode).toBe(200);
  });

  it('refuses a name clash under the new parent, case-insensitively, with 409', async () => {
    const twin = db.createCategory('models', ids.Harnesses)!;
    const res = await move(twin.id, { parentId: ids.AI, index: 0 });
    expect(res.statusCode).toBe(409);
    expect(res.json().problem).toBe('clash');
    expect(res.json().error).toBe('“AI” already has a category called “Models”.');
    const root = await move(ids.Agents, { parentId: null, index: 0 });
    expect(root.statusCode).toBe(200);
    const clash = db.createCategory('agents', ids.Models)!;
    const res2 = await move(clash.id, { parentId: null, index: 0 });
    expect(res2.statusCode).toBe(409);
    expect(res2.json().error).toBe('There is already a top-level category called “Agents”.');
  });

  it('rejects an unknown category, an unknown parent and a malformed body', async () => {
    expect((await move(9999, { parentId: null, index: 0 })).statusCode).toBe(404);
    expect((await move(ids.AI, { parentId: 9999, index: 0 })).statusCode).toBe(400);
    expect((await move(ids.AI, { parentId: 'x', index: 0 })).statusCode).toBe(400);
    expect((await move(ids.AI, { parentId: null })).statusCode).toBe(400);
    expect((await move(ids.AI, { parentId: null, index: -1 })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/api/categories/abc/position', payload: {} })).statusCode).toBe(400);
  });

  it('clamps an index past the end to the end, and a no-op reports changed: false', async () => {
    const res = await move(ids.AI, { parentId: null, index: 99 });
    expect((await tree()).map((r) => r.name)).toEqual(['Design', 'Music', 'AI']);
    expect(res.json().changed).toBe(true);
    const again = await move(ids.AI, { parentId: null, index: 2 });
    expect(again.json().changed).toBe(false);
  });

  it('keeps the root order through a recategorize-style clear, by name', async () => {
    await move(ids.Music, { parentId: null, index: 0 });
    db.clearGeneratedCategories(); // every generated row goes; names are all that survive
    for (const n of ['AI', 'Design', 'Music']) db.getOrCreateCategory(n, null, now);
    expect((await tree()).map((r) => r.name)).toEqual(['Music', 'AI', 'Design']);
    expect(db.getState(ROOT_ORDER_KEY)).toBe(JSON.stringify(['Music', 'AI', 'Design']));
  });

  it('applies an existing root order saved before positions existed', async () => {
    db.setState(ROOT_ORDER_KEY, JSON.stringify(['Design', 'Music']));
    expect((await tree()).map((r) => r.name)).toEqual(['Design', 'Music', 'AI']);
    await move(ids.AI, { parentId: null, index: 1 });
    expect((await tree()).map((r) => r.name)).toEqual(['Design', 'AI', 'Music']);
  });
});
