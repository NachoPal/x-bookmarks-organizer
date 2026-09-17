import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from './database';
import type { RawBookmark } from '../types';

function bookmark(postId: string, overrides: Partial<RawBookmark> = {}): RawBookmark {
  return {
    postId,
    authorUsername: 'alice',
    authorName: 'Alice',
    text: `text for ${postId}`,
    url: `https://x.com/alice/status/${postId}`,
    postCreatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('Database', () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(':memory:');
  });
  afterEach(() => {
    db.close();
  });

  it('creates a schema and starts empty', () => {
    expect(db.getKnownPostIds().size).toBe(0);
    expect(db.getAllCategories()).toHaveLength(0);
  });

  describe('getOrCreateCategory', () => {
    it('reuses an existing node instead of duplicating it', () => {
      const when = new Date().toISOString();
      const a1 = db.getOrCreateCategory('AI', null, when);
      const a2 = db.getOrCreateCategory('AI', null, when);
      expect(a2.id).toBe(a1.id);
      expect(db.getAllCategories()).toHaveLength(1);
    });

    it('matches names case-insensitively and trims whitespace', () => {
      const when = new Date().toISOString();
      const a1 = db.getOrCreateCategory('AI', null, when);
      const a2 = db.getOrCreateCategory('  ai ', null, when);
      expect(a2.id).toBe(a1.id);
    });

    it('nests children under the right parent and allows same name under different parents', () => {
      const when = new Date().toISOString();
      const ai = db.getOrCreateCategory('AI', null, when);
      const gamedev = db.getOrCreateCategory('Game Dev', null, when);
      const aiTools = db.getOrCreateCategory('Tools', ai.id, when);
      const gdTools = db.getOrCreateCategory('Tools', gamedev.id, when);
      expect(aiTools.id).not.toBe(gdTools.id);
      expect(aiTools.parentId).toBe(ai.id);
      expect(gdTools.parentId).toBe(gamedev.id);
    });
  });

  describe('markRead', () => {
    it('marks read and records the timestamp only once (idempotent date)', () => {
      db.storeCategorizedBatch([bookmark('1')], () => []);
      const stored = db.getBookmarkByPostId('1')!;
      expect(stored.read).toBe(false);
      expect(stored.readAt).toBeNull();

      const first = db.markRead(stored.id, '2024-05-01T00:00:00.000Z')!;
      expect(first.read).toBe(true);
      expect(first.readAt).toBe('2024-05-01T00:00:00.000Z');

      const second = db.markRead(stored.id, '2024-06-01T00:00:00.000Z')!;
      expect(second.readAt).toBe('2024-05-01T00:00:00.000Z'); // unchanged
    });

    it('returns undefined for an unknown id', () => {
      expect(db.markRead(999)).toBeUndefined();
    });
  });

  describe('storeCategorizedBatch', () => {
    it('stores bookmarks and links them to categories atomically', () => {
      const when = new Date().toISOString();
      const ai = db.getOrCreateCategory('AI', null, when);
      const evals = db.getOrCreateCategory('Evals', ai.id, when);

      db.storeCategorizedBatch([bookmark('1'), bookmark('2')], (bm) =>
        bm.postId === '1' ? [ai.id, evals.id] : [evals.id],
      );

      expect(db.getKnownPostIds()).toEqual(new Set(['1', '2']));
      expect(db.getBookmarksForCategory(evals.id).map((b) => b.postId).sort()).toEqual(['1', '2']);
      // The parent surfaces its own direct bookmark plus its descendants',
      // deduplicated: bm '1' is linked to both AI and Evals but appears once.
      expect(db.getBookmarksForCategory(ai.id).map((b) => b.postId).sort()).toEqual(['1', '2']);
    });

    it('does not duplicate a bookmark that is already stored', () => {
      const when = new Date().toISOString();
      const cat = db.getOrCreateCategory('X', null, when);
      db.storeCategorizedBatch([bookmark('1')], () => [cat.id]);
      db.storeCategorizedBatch([bookmark('1')], () => [cat.id]);
      expect(db.getKnownPostIds().size).toBe(1);
    });
  });

  describe('run state', () => {
    it('persists and reads the newest-seen marker and refresh token', () => {
      db.setNewestSeenPostId('abc');
      expect(db.getNewestSeenPostId()).toBe('abc');
      db.setRefreshToken('rt-1');
      expect(db.getRefreshToken()).toBe('rt-1');
      db.setRefreshToken('rt-2');
      expect(db.getRefreshToken()).toBe('rt-2');
    });

    it('reports no last-sync timestamp until one is set', () => {
      expect(db.getLastSyncedAt()).toBeUndefined();
      db.setLastSyncedAt('2026-09-16T10:00:00.000Z');
      expect(db.getLastSyncedAt()).toBe('2026-09-16T10:00:00.000Z');
      db.setLastSyncedAt('2026-09-17T08:00:00.000Z');
      expect(db.getLastSyncedAt()).toBe('2026-09-17T08:00:00.000Z');
    });
  });

  describe('getDirectMembership', () => {
    it('lists the direct bookmarks of a node with their read flags', () => {
      const when = new Date().toISOString();
      const cat = db.getOrCreateCategory('X', null, when);
      db.storeCategorizedBatch([bookmark('1'), bookmark('2')], () => [cat.id]);
      const b1 = db.getBookmarkByPostId('1')!;
      db.markRead(b1.id);

      const members = db.getDirectMembership().get(cat.id)!;
      expect(members).toHaveLength(2);
      expect(members.find((m) => m.id === b1.id)!.read).toBe(true);
      const b2 = db.getBookmarkByPostId('2')!;
      expect(members.find((m) => m.id === b2.id)!.read).toBe(false);
    });
  });

  describe('getBookmarksForCategory across a subtree', () => {
    it('returns a node and its descendants, deduplicated by bookmark id', () => {
      const when = new Date().toISOString();
      const ai = db.getOrCreateCategory('AI', null, when);
      const evals = db.getOrCreateCategory('Evals', ai.id, when);
      const harnesses = db.getOrCreateCategory('Harnesses', ai.id, when);
      // bm '1' lives in two sibling branches under AI; it must appear once.
      db.storeCategorizedBatch([bookmark('1'), bookmark('2')], (bm) =>
        bm.postId === '1' ? [evals.id, harnesses.id] : [harnesses.id],
      );

      expect(db.getBookmarksForCategory(ai.id).map((b) => b.postId).sort()).toEqual(['1', '2']);
      expect(db.getBookmarksForCategory(evals.id).map((b) => b.postId)).toEqual(['1']);
    });
  });

  describe('paging and counts for the viewer', () => {
    function seedEvals(count: number, readCount = 0) {
      const when = new Date().toISOString();
      const ai = db.getOrCreateCategory('AI', null, when);
      const evals = db.getOrCreateCategory('Evals', ai.id, when);
      const batch = Array.from({ length: count }, (_, i) => bookmark(String(i + 1)));
      db.storeCategorizedBatch(batch, () => [evals.id]);
      for (let i = 1; i <= readCount; i++) db.markRead(db.getBookmarkByPostId(String(i))!.id);
      return evals.id;
    }

    it('limits and offsets a subtree page without shipping everything', () => {
      const id = seedEvals(25);
      const first = db.getBookmarksForCategory(id, { limit: 20, offset: 0 });
      const second = db.getBookmarksForCategory(id, { limit: 20, offset: 20 });
      expect(first).toHaveLength(20);
      expect(second).toHaveLength(5);
      // Pages are disjoint and together cover the whole set.
      const ids = new Set([...first, ...second].map((b) => b.id));
      expect(ids.size).toBe(25);
    });

    it('filters a page by read state', () => {
      const id = seedEvals(25, 10);
      const unread = db.getBookmarksForCategory(id, { filter: 'unread', limit: 100 });
      const read = db.getBookmarksForCategory(id, { filter: 'read', limit: 100 });
      expect(unread).toHaveLength(15);
      expect(unread.every((b) => b.read === false)).toBe(true);
      expect(read).toHaveLength(10);
      expect(read.every((b) => b.read === true)).toBe(true);
    });

    it('reports rolled-up total and unread counts for a subtree', () => {
      const id = seedEvals(25, 10);
      expect(db.getCategoryBookmarkCounts(id)).toEqual({ total: 25, unread: 15 });
    });

    it('with no options still returns the whole subtree (back-compat)', () => {
      const id = seedEvals(3);
      expect(db.getBookmarksForCategory(id)).toHaveLength(3);
    });
  });
});
