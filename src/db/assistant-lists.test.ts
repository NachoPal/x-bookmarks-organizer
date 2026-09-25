import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from './database';
import type { RawBookmark } from '../types';

const WHEN = '2026-09-25T00:00:00.000Z';

const bm = (postId: string): RawBookmark => ({
  postId,
  authorUsername: 'alice',
  authorName: 'Alice',
  text: `text for ${postId}`,
  url: `https://x.com/alice/status/${postId}`,
  postCreatedAt: '',
});

describe('assistant result lists (storage)', () => {
  let db: Database;
  let ids: Record<string, number>;
  let ai: number;
  let cooking: number;

  beforeEach(() => {
    db = new Database(':memory:');
    ai = db.getOrCreateCategory('AI', null, WHEN).id;
    cooking = db.getOrCreateCategory('Cooking', null, WHEN).id;
    const home: Record<string, number[]> = { '1': [ai], '2': [ai], '3': [cooking], '4': [ai, cooking] };
    db.storeCategorizedBatch(['1', '2', '3', '4'].map(bm), (b) => home[b.postId]!, WHEN);
    ids = Object.fromEntries(['1', '2', '3', '4'].map((p) => [p, db.getBookmarkByPostId(p)!.id]));
  });
  afterEach(() => db.close());

  it('stores a list in the order given and lists newest first', () => {
    const first = db.createAssistantList({ title: 'Older', note: null, bookmarkIds: [ids['1']!] }, WHEN);
    const second = db.createAssistantList(
      { title: 'Eval harnesses', note: 'Why these', bookmarkIds: [ids['3']!, ids['1']!, ids['2']!] },
      '2026-09-25T01:00:00.000Z',
    );
    expect(second).toEqual({
      id: second.id,
      title: 'Eval harnesses',
      note: 'Why these',
      createdAt: '2026-09-25T01:00:00.000Z',
      count: 3,
      viewed: false,
    });
    expect(db.getAssistantListBookmarks(second.id).map((b) => b.postId)).toEqual(['3', '1', '2']);
    expect(db.getAssistantLists().map((l) => l.id)).toEqual([second.id, first.id]);
    expect(db.countAssistantLists()).toBe(2);
  });

  it('deleting a post takes it out of every list, and the list stays', () => {
    const list = db.createAssistantList({ title: 'A', note: null, bookmarkIds: [ids['1']!, ids['2']!] });
    const other = db.createAssistantList({ title: 'B', note: null, bookmarkIds: [ids['2']!] });
    db.deleteBookmark(ids['2']!);
    expect(db.getAssistantListBookmarks(list.id).map((b) => b.postId)).toEqual(['1']);
    expect(db.getAssistantList(list.id)!.count).toBe(1);
    expect(db.getAssistantList(other.id)).toMatchObject({ count: 0 });
  });

  it('a category delete that orphans a post takes it out of lists too', () => {
    const list = db.createAssistantList({ title: 'A', note: null, bookmarkIds: [ids['3']!, ids['4']!] });
    db.deleteCategory(cooking);
    // 3 lived only in Cooking and went; 4 is also in AI and survives.
    expect(db.getAssistantListBookmarks(list.id).map((b) => b.postId)).toEqual(['4']);
  });

  it('deleting a list, or all of them, never touches a post or its filing', () => {
    const list = db.createAssistantList({ title: 'A', note: null, bookmarkIds: [ids['1']!, ids['3']!] });
    db.createAssistantList({ title: 'B', note: null, bookmarkIds: [ids['4']!] });
    const snapshot = () =>
      JSON.stringify([db.getAllBookmarks(), [...db.getCategoryIdsForBookmarks(Object.values(ids))]]);
    const before = snapshot();
    expect(db.deleteAssistantList(list.id)).toBe(true);
    expect(db.deleteAssistantList(list.id)).toBe(false);
    expect(db.clearAssistantLists()).toBe(1);
    expect(db.getAssistantLists()).toEqual([]);
    expect(snapshot()).toBe(before);
  });

  it('a library reset clears the lists with the bookmarks', () => {
    db.createAssistantList({ title: 'A', note: null, bookmarkIds: [ids['1']!] });
    db.resetLibrary();
    expect(db.getAssistantLists()).toEqual([]);
  });

  it('survives a reopen of the database file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbo-lists-'));
    try {
      const file = path.join(dir, 'lists.db');
      const disk = new Database(file);
      const cat = disk.getOrCreateCategory('AI', null, WHEN).id;
      disk.storeCategorizedBatch([bm('9')], () => [cat], WHEN);
      const made = disk.createAssistantList({ title: 'Kept', note: 'n', bookmarkIds: [disk.getBookmarkByPostId('9')!.id] });
      disk.close();
      const again = new Database(file);
      expect(again.getAssistantLists()).toEqual([made]);
      again.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stamps a list viewed on its first open only', () => {
    const list = db.createAssistantList({ title: 'A', note: null, bookmarkIds: [ids['1']!] });
    const other = db.createAssistantList({ title: 'B', note: null, bookmarkIds: [ids['2']!] });
    expect(db.markAssistantListViewed(list.id, WHEN)).toBe(true);
    expect(db.markAssistantListViewed(list.id)).toBe(false); // already viewed: nothing changed
    expect(db.markAssistantListViewed(999)).toBeUndefined();
    expect(db.getAssistantList(list.id)!.viewed).toBe(true);
    expect(db.getAssistantList(other.id)!.viewed).toBe(false);
  });

  it('migrates a list table from before viewed_at, counting its lists as already viewed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbo-lists-migrate-'));
    try {
      const file = path.join(dir, 'old.db');
      const raw = new BetterSqlite3(file);
      raw.exec(`
        CREATE TABLE assistant_lists (
          id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, note TEXT, created_at TEXT NOT NULL
        );
        INSERT INTO assistant_lists (title, created_at) VALUES ('From before', '${WHEN}');
      `);
      raw.close();

      const migrated = new Database(file);
      expect(migrated.getAssistantLists()).toMatchObject([{ title: 'From before', viewed: true }]);
      const cat = migrated.getOrCreateCategory('AI', null, WHEN).id;
      migrated.storeCategorizedBatch([bm('9')], () => [cat], WHEN);
      const fresh = migrated.createAssistantList({ title: 'New', note: null, bookmarkIds: [migrated.getBookmarkByPostId('9')!.id] });
      migrated.close();

      // Re-opening is a no-op: the back-fill ran once, so a later list stays unviewed.
      const again = new Database(file);
      expect(again.getAssistantList(fresh.id)!.viewed).toBe(false);
      again.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
