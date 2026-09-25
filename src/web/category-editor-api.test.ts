import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from './server';
import type { SyncJob } from './sync';
import { Database } from '../db/database';
import type { RawBookmark } from '../types';

/**
 * The category editor's create/delete/preview surface (issue #101).
 *
 * This is the one DESTRUCTIVE feature that removes posts, so the tests below
 * pin the owner's rule end to end: a delete takes the subtree, takes the posts
 * that would be left filed nowhere, KEEPS a post that is also filed under a
 * surviving category, tombstones what it did remove so a sync cannot bring it
 * back, and the preview the confirmation dialog states matches exactly what
 * the delete then does.
 */

const bm = (postId: string): RawBookmark => ({
  postId,
  authorUsername: 'a',
  authorName: 'A',
  text: `t-${postId}`,
  url: `https://x.com/a/status/${postId}`,
  postCreatedAt: '',
});

describe('category editor API', () => {
  let db: Database;
  let app: FastifyInstance;
  let ai: number;
  let evals: number;
  let harnesses: number;
  let gamedev: number;

  beforeEach(async () => {
    db = new Database(':memory:');
    const when = new Date().toISOString();
    ai = db.getOrCreateCategory('AI', null, when).id;
    evals = db.getOrCreateCategory('Evals', ai, when).id;
    harnesses = db.getOrCreateCategory('Harnesses', evals, when).id;
    gamedev = db.getOrCreateCategory('Game Dev', null, when).id;
    app = buildServer(db);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  const idOf = (name: string): number => db.getAllCategories().find((c) => c.name === name)!.id;

  // --- create ------------------------------------------------------------

  it('creates a root category and returns the rebuilt tree', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/categories', payload: { name: 'Rust' } });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.category).toMatchObject({ name: 'Rust', parentId: null });
    expect(body.tree.map((r: { name: string }) => r.name)).toContain('Rust');
    expect(db.getCategoryById(body.category.id)).toBeDefined();
  });

  it('creates a child one level under the given parent', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/categories',
      payload: { name: 'Sandboxes', parentId: evals },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().category).toMatchObject({ name: 'Sandboxes', parentId: evals });
  });

  it('rejects a duplicate sibling name, case-insensitively', async () => {
    const dupRoot = await app.inject({ method: 'POST', url: '/api/categories', payload: { name: 'ai' } });
    expect(dupRoot.statusCode).toBe(409);
    expect(dupRoot.json().error).toMatch(/already exists/i);

    const dupChild = await app.inject({
      method: 'POST',
      url: '/api/categories',
      payload: { name: 'EVALS', parentId: ai },
    });
    expect(dupChild.statusCode).toBe(409);
    expect(db.getAllCategories().filter((c) => c.parentId === ai)).toHaveLength(1);
  });

  it('allows the same name under a different parent', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/categories',
      payload: { name: 'Evals', parentId: gamedev },
    });
    expect(res.statusCode).toBe(201);
  });

  it('refuses a child under a category already at the maximum depth, in the editor\'s words', async () => {
    const shallow = buildServer(db, { maxCategoryDepth: 3 });
    await shallow.ready();
    try {
      const full = await shallow.inject({
        method: 'POST',
        url: '/api/categories',
        payload: { name: 'Too deep', parentId: harnesses },
      });
      expect(full.statusCode).toBe(400);
      expect(full.json().error).toBe(
        'Categories go at most 3 levels deep, so “Harnesses” can’t take a sub-category.',
      );
      expect(db.getAllCategories().some((c) => c.name === 'Too deep')).toBe(false);

      const fits = await shallow.inject({
        method: 'POST',
        url: '/api/categories',
        payload: { name: 'Sandboxes', parentId: evals },
      });
      expect(fits.statusCode).toBe(201);
    } finally {
      await shallow.close();
    }
  });

  it('rejects an empty name and an unknown parent', async () => {
    const blank = await app.inject({ method: 'POST', url: '/api/categories', payload: { name: '   ' } });
    expect(blank.statusCode).toBe(400);

    const badParent = await app.inject({
      method: 'POST',
      url: '/api/categories',
      payload: { name: 'Nope', parentId: 9999 },
    });
    expect(badParent.statusCode).toBe(400);
    expect(badParent.json().error).toMatch(/Unknown category id/);

    const badShape = await app.inject({
      method: 'POST',
      url: '/api/categories',
      payload: { name: 'Nope', parentId: 'ai' },
    });
    expect(badShape.statusCode).toBe(400);
    expect(db.getAllCategories().some((c) => c.name === 'Nope')).toBe(false);
  });

  // --- delete preview ----------------------------------------------------

  it('previews only the ORPHANED posts, not every post in the subtree', async () => {
    // `solo` lives only under Harnesses; `shared` is also filed under Game Dev.
    db.storeCategorizedBatch([bm('solo')], () => [harnesses]);
    db.storeCategorizedBatch([bm('shared')], () => [harnesses, gamedev]);

    const res = await app.inject({ method: 'GET', url: `/api/categories/${ai}/deletion` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      category: { id: ai, name: 'AI', isRoot: true },
      removes: { categories: 3, subcategories: 2, posts: 1 },
    });
  });

  it('previews a leaf with no posts as a single category and nothing else', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/categories/${harnesses}/deletion` });
    expect(res.json().removes).toEqual({ categories: 1, subcategories: 0, posts: 0 });
    expect(res.json().category.isRoot).toBe(false);
  });

  it('mutates nothing when previewing', async () => {
    db.storeCategorizedBatch([bm('solo')], () => [harnesses]);
    const before = {
      categories: db.getAllCategories().length,
      bookmarks: db.getBookmarkCount(),
    };
    await app.inject({ method: 'GET', url: `/api/categories/${ai}/deletion` });
    expect(db.getAllCategories().length).toBe(before.categories);
    expect(db.getBookmarkCount()).toBe(before.bookmarks);
  });

  it('404s previewing an unknown category', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/categories/4242/deletion' });
    expect(res.statusCode).toBe(404);
  });

  // --- delete ------------------------------------------------------------

  it('cascades the subtree and deletes ONLY the orphaned posts', async () => {
    db.storeCategorizedBatch([bm('solo')], () => [harnesses]);
    db.storeCategorizedBatch([bm('shared')], () => [harnesses, gamedev]);
    const sharedId = db.getBookmarkByPostId('shared')!.id;

    const res = await app.inject({ method: 'DELETE', url: `/api/categories/${ai}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().removed).toEqual({ categories: 3, subcategories: 2, posts: 1 });

    // The whole subtree is gone; the untouched root survives.
    expect(db.getAllCategories().map((c) => c.name)).toEqual(['Game Dev']);
    // The single-category post is gone; the multi-category one is kept and
    // now filed solely under the surviving category.
    expect(db.getBookmarkByPostId('solo')).toBeUndefined();
    expect(db.getBookmarkByPostId('shared')).toBeDefined();
    expect(db.getCategoryIdsForBookmarks([sharedId]).get(sharedId)).toEqual([gamedev]);
  });

  it('tombstones the deleted posts so an incremental sync cannot re-add them', async () => {
    db.storeCategorizedBatch([bm('solo')], () => [harnesses]);
    await app.inject({ method: 'DELETE', url: `/api/categories/${harnesses}` });
    expect(db.getKnownPostIds().has('solo')).toBe(true);
    expect(db.getBookmarkByPostId('solo')).toBeUndefined();
  });

  it('matches its own preview exactly', async () => {
    db.storeCategorizedBatch([bm('a1'), bm('a2')], () => [evals]);
    db.storeCategorizedBatch([bm('b1')], () => [harnesses, gamedev]);
    db.storeCategorizedBatch([bm('c1')], () => [gamedev]);

    const preview = (await app.inject({ method: 'GET', url: `/api/categories/${ai}/deletion` })).json();
    const before = db.getBookmarkCount();
    const deleted = (await app.inject({ method: 'DELETE', url: `/api/categories/${ai}` })).json();

    expect(deleted.removed).toEqual(preview.removes);
    expect(before - db.getBookmarkCount()).toBe(preview.removes.posts);
  });

  it('deletes a leaf without touching its siblings or its parent', async () => {
    db.storeCategorizedBatch([bm('keep')], () => [evals]);
    db.storeCategorizedBatch([bm('drop')], () => [harnesses]);

    const res = await app.inject({ method: 'DELETE', url: `/api/categories/${harnesses}` });
    expect(res.json().removed).toEqual({ categories: 1, subcategories: 0, posts: 1 });
    expect(idOf('Evals')).toBe(evals);
    expect(db.getBookmarkByPostId('keep')).toBeDefined();
    expect(db.getBookmarkByPostId('drop')).toBeUndefined();
  });

  it('answers with the rebuilt tree and the new bookmark count', async () => {
    db.storeCategorizedBatch([bm('solo')], () => [harnesses]);
    const res = await app.inject({ method: 'DELETE', url: `/api/categories/${ai}` });
    expect(res.json().tree.map((r: { name: string }) => r.name)).toEqual(['Game Dev']);
    expect(res.json().bookmarkCount).toBe(db.getBookmarkCount());
  });

  it('404s deleting an unknown category and rejects a malformed id', async () => {
    expect((await app.inject({ method: 'DELETE', url: '/api/categories/4242' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: '/api/categories/abc' })).statusCode).toBe(400);
  });

  it('is transactional: a failure mid-delete leaves the library untouched', async () => {
    db.storeCategorizedBatch([bm('solo'), bm('solo2')], () => [harnesses]);
    const before = {
      categories: db.getAllCategories().map((c) => c.id).sort(),
      bookmarks: db.getBookmarkCount(),
      tombstones: db.getKnownPostIds().size,
    };
    // Make the second tombstone insert blow up part way through the run.
    const original = db.deleteBookmark.bind(db);
    let calls = 0;
    (db as unknown as { deleteBookmark: Database['deleteBookmark'] }).deleteBookmark = ((
      id: number,
      when?: string,
    ) => {
      calls += 1;
      if (calls === 2) throw new Error('boom');
      return original(id, when);
    }) as Database['deleteBookmark'];

    expect(() => db.deleteCategory(harnesses)).toThrow('boom');

    expect(db.getAllCategories().map((c) => c.id).sort()).toEqual(before.categories);
    expect(db.getBookmarkCount()).toBe(before.bookmarks);
    expect(db.getKnownPostIds().size).toBe(before.tombstones);
  });

  it('keeps a post filed under a SIBLING inside the deleted subtree only if that sibling survives', async () => {
    // Filed under two nodes that are BOTH inside the doomed subtree: nothing
    // survives to hold it, so it is an orphan and goes.
    db.storeCategorizedBatch([bm('inner')], () => [evals, harnesses]);
    const res = await app.inject({ method: 'DELETE', url: `/api/categories/${ai}` });
    expect(res.json().removed.posts).toBe(1);
    expect(db.getBookmarkByPostId('inner')).toBeUndefined();
  });
});

describe('category edits vs a running sync', () => {
  let db: Database;
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it('refuses a create and a delete while a sync is running (409)', async () => {
    db = new Database(':memory:');
    const root = db.getOrCreateCategory('AI', null, new Date().toISOString());
    let release: () => void = () => {};
    // A sync that never finishes on its own: an ingest is minting and filing
    // the very categories an edit would move under it.
    const job: SyncJob = () =>
      new Promise((resolve) => {
        release = () => resolve({ fetched: 0, stored: 0, categories: 0 });
      });
    app = buildServer(db, { syncJob: job });
    await app.ready();
    await app.inject({ method: 'POST', url: '/api/sync' });

    const created = await app.inject({ method: 'POST', url: '/api/categories', payload: { name: 'Rust' } });
    expect(created.statusCode).toBe(409);
    expect(created.json().error).toMatch(/sync is running/i);

    const deleted = await app.inject({ method: 'DELETE', url: `/api/categories/${root.id}` });
    expect(deleted.statusCode).toBe(409);

    // The read-only preview is never blocked - it mutates nothing.
    expect((await app.inject({ method: 'GET', url: `/api/categories/${root.id}/deletion` })).statusCode).toBe(200);

    expect(db.getAllCategories()).toHaveLength(1);
    release();
  });
});
