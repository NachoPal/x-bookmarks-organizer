import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from './database';
import type { RawBookmark } from '../types';

const WHEN = '2026-09-24T00:00:00.000Z';

function bookmark(postId: string): RawBookmark {
  return {
    postId,
    authorUsername: 'alice',
    authorName: 'Alice',
    text: `text for ${postId}`,
    url: `https://x.com/alice/status/${postId}`,
    postCreatedAt: '',
  };
}

describe('category origin (owner vs generated)', () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(':memory:');
  });
  afterEach(() => {
    db.close();
  });

  it('marks a category the owner creates as theirs, and one a pass creates as generated', () => {
    const mine = db.createCategory('Rust', null, WHEN)!;
    const made = db.getOrCreateCategory('AI', null, WHEN);
    expect(mine.origin).toBe('user');
    expect(made.origin).toBe('generated');
    expect(db.getCategoryById(mine.id)!.origin).toBe('user');
    expect(db.getCategoryById(made.id)!.origin).toBe('generated');
    expect(db.getUserCategories().map((c) => c.name)).toEqual(['Rust']);
  });

  it('only counts generated categories as an existing taxonomy', () => {
    expect(db.hasGeneratedCategories()).toBe(false);
    db.createCategory('Rust', null, WHEN);
    expect(db.hasGeneratedCategories()).toBe(false);
    db.getOrCreateCategory('AI', null, WHEN);
    expect(db.hasGeneratedCategories()).toBe(true);
  });

  it('never fills in or changes the description of an owner category when a pass merges into it', () => {
    const mine = db.createCategory('Rust', null, WHEN)!;
    const merged = db.getOrCreateCategory('rust', null, WHEN, 'Systems programming in Rust.');
    expect(merged.id).toBe(mine.id);
    expect(db.getCategoryById(mine.id)!.description).toBeNull();
    expect(db.getCategoryById(mine.id)!.name).toBe('Rust');
    // A generated node still gains a missing description, as before.
    const ai = db.getOrCreateCategory('AI', null, WHEN);
    db.getOrCreateCategory('AI', null, WHEN, 'Machine learning.');
    expect(db.getCategoryById(ai.id)!.description).toBe('Machine learning.');
  });

  it('lets the owner mark and unmark a category as theirs', () => {
    const ai = db.getOrCreateCategory('AI', null, WHEN);
    expect(db.setCategoryOrigin(ai.id, 'user')).toBe(true);
    expect(db.getCategoryById(ai.id)!.origin).toBe('user');
    expect(db.setCategoryOrigin(ai.id, 'generated')).toBe(true);
    expect(db.getCategoryById(ai.id)!.origin).toBe('generated');
    expect(db.setCategoryOrigin(9999, 'user')).toBe(false);
  });

  it('protects every owner category together with the ancestors that hold it in place', () => {
    const ai = db.getOrCreateCategory('AI', null, WHEN);
    const llms = db.getOrCreateCategory('LLMs', ai.id, WHEN);
    const mine = db.createCategory('My evals', llms.id, WHEN)!;
    const inside = db.getOrCreateCategory('Benchmarks', mine.id, WHEN);
    const other = db.getOrCreateCategory('Game Dev', null, WHEN);
    const rust = db.createCategory('Rust', null, WHEN)!;
    expect([...db.getProtectedCategoryIds()].sort((a, b) => a - b)).toEqual(
      [ai.id, llms.id, mine.id, rust.id].sort((a, b) => a - b),
    );
    expect(db.getProtectedCategoryIds().has(inside.id)).toBe(false);
    expect(db.getProtectedCategoryIds().has(other.id)).toBe(false);
  });

  it('clearGeneratedCategories keeps owner categories in place, with their posts, and clears the rest', () => {
    const ai = db.getOrCreateCategory('AI', null, WHEN);
    const mine = db.createCategory('My evals', ai.id, WHEN)!;
    const generatedChild = db.getOrCreateCategory('Benchmarks', mine.id, WHEN);
    const other = db.getOrCreateCategory('Game Dev', null, WHEN);
    const rust = db.createCategory('Rust', null, WHEN)!;
    db.storeCategorizedBatch([bookmark('1')], () => [mine.id, other.id], WHEN);
    db.storeCategorizedBatch([bookmark('2')], () => [ai.id], WHEN);
    db.storeCategorizedBatch([bookmark('3')], () => [generatedChild.id, rust.id], WHEN);

    db.clearGeneratedCategories();

    const left = db.getAllCategories();
    expect(left.map((c) => [c.name, c.parentId, c.origin])).toEqual([
      ['AI', null, 'generated'],
      ['My evals', ai.id, 'user'],
      ['Rust', null, 'user'],
    ]);
    // Links into owner categories survive; every other link is gone.
    const links = db.getCategoryIdsForBookmarks(
      ['1', '2', '3'].map((p) => db.getBookmarkByPostId(p)!.id),
    );
    expect(links.get(db.getBookmarkByPostId('1')!.id)).toEqual([mine.id]);
    expect(links.has(db.getBookmarkByPostId('2')!.id)).toBe(false);
    expect(links.get(db.getBookmarkByPostId('3')!.id)).toEqual([rust.id]);
    // Bookmarks themselves are untouched.
    expect(db.getAllBookmarks()).toHaveLength(3);
  });

  it('clearGeneratedCategories clears everything when the owner made nothing', () => {
    const ai = db.getOrCreateCategory('AI', null, WHEN);
    db.storeCategorizedBatch([bookmark('1')], () => [ai.id], WHEN);
    db.clearGeneratedCategories();
    expect(db.getAllCategories()).toEqual([]);
    expect(db.getAllBookmarks()).toHaveLength(1);
  });

  it('lists the bookmarks outside a subtree, and adds/removes links without touching others', () => {
    const rust = db.createCategory('Rust', null, WHEN)!;
    const async = db.getOrCreateCategory('Async', rust.id, WHEN);
    const ai = db.getOrCreateCategory('AI', null, WHEN);
    db.storeCategorizedBatch([bookmark('1')], () => [async.id], WHEN);
    db.storeCategorizedBatch([bookmark('2')], () => [ai.id], WHEN);
    db.storeCategorizedBatch([bookmark('3')], () => [ai.id], WHEN);
    const id = (p: string) => db.getBookmarkByPostId(p)!.id;

    expect(db.getBookmarksOutsideCategory(rust.id).map((b) => b.postId).sort()).toEqual(['2', '3']);

    expect(db.addBookmarksToCategory(rust.id, [id('2'), id('2'), 4242])).toEqual([id('2')]);
    expect(db.getCategoryIdsForBookmarks([id('2')]).get(id('2'))!.sort()).toEqual([rust.id, ai.id].sort());

    // Undo only drops the link it added, and never strands a post.
    db.setBookmarkCategories(id('3'), [rust.id]);
    expect(db.removeBookmarksFromCategory(rust.id, [id('2'), id('3')])).toEqual([id('2')]);
    expect(db.getCategoryIdsForBookmarks([id('2')]).get(id('2'))).toEqual([ai.id]);
    expect(db.getCategoryIdsForBookmarks([id('3')]).get(id('3'))).toEqual([rust.id]);
  });
});

describe('category origin migration', () => {
  it('adds origin to a pre-existing categories table as generated, idempotently', () => {
    const dbPath = path.join(os.tmpdir(), `xbookmarks-origin-migration-${Date.now()}-${Math.random()}.db`);
    try {
      const raw = new BetterSqlite3(dbPath);
      raw.exec(`
        CREATE TABLE categories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          parent_id INTEGER REFERENCES categories(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          description TEXT,
          created_at TEXT NOT NULL,
          UNIQUE(parent_id, name)
        );
      `);
      raw.prepare(`INSERT INTO categories (parent_id, name, created_at) VALUES (NULL, 'Old', '2026-01-01')`).run();
      raw.close();

      const first = new Database(dbPath);
      const old = first.getAllCategories()[0]!;
      expect(old.origin).toBe('generated'); // no history of who made it
      first.setCategoryOrigin(old.id, 'user');
      first.close();

      const second = new Database(dbPath);
      try {
        expect(second.getAllCategories()[0]!.origin).toBe('user');
        const raw2 = new BetterSqlite3(dbPath);
        try {
          const columns = raw2.prepare('PRAGMA table_info(categories)').all() as { name: string }[];
          expect(columns.filter((c) => c.name === 'origin')).toHaveLength(1);
          expect(() =>
            raw2.prepare(`INSERT INTO categories (name, created_at, origin) VALUES ('X', 'now', 'bogus')`).run(),
          ).toThrow();
        } finally {
          raw2.close();
        }
      } finally {
        second.close();
      }
    } finally {
      for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        try {
          fs.rmSync(f);
        } catch {
          /* not present */
        }
      }
    }
  });
});
