import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '../db/database';
import type { RawBookmark } from '../types';
import { buildFindPrompt, describeFindTarget, findBookmarksForCategory, parseFindMatches } from './find';

const WHEN = '2026-09-24T00:00:00.000Z';

const bm = (postId: string, text = `t-${postId}`): RawBookmark => ({
  postId,
  authorUsername: 'a',
  authorName: 'A',
  text,
  url: `https://x.com/a/status/${postId}`,
  postCreatedAt: '',
});

describe('buildFindPrompt / parseFindMatches', () => {
  it('describes the one category and every bookmark, and asks for post ids back', () => {
    const prompt = buildFindPrompt(
      [bm('1', 'tokio runtime internals'), bm('2', 'sourdough starter')],
      { path: ['Programming', 'Rust'], description: 'The Rust language.', children: ['Async'] },
      new Map([['1', { title: 'Tokio deep dive', description: 'How it schedules' }]]),
    );
    expect(prompt).toContain('Programming > Rust');
    expect(prompt).toContain('What belongs in it: The Rust language.');
    expect(prompt).toContain('It already contains: Async');
    expect(prompt).toContain('post_id: 1');
    expect(prompt).toContain('linked article: Tokio deep dive - How it schedules');
    expect(prompt).toContain('{"matches":["<post_id>","<post_id>"]}');
  });

  it('keeps only ids from the batch, tolerating fences, numbers and duplicates', () => {
    const valid = new Set(['1', '2']);
    expect(parseFindMatches('```json\n{"matches":["1", 2, "1", "99"]}\n```', valid)).toEqual(['1', '2']);
    expect(parseFindMatches('{"matches":[]}', valid)).toEqual([]);
  });

  it('fails loudly on an answer that is not the JSON asked for', () => {
    expect(() => parseFindMatches('no idea', new Set())).toThrow(/no JSON/);
    expect(() => parseFindMatches('{"nope":1}', new Set())).toThrow(/matches/);
  });
});

describe('findBookmarksForCategory', () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(':memory:');
  });
  afterEach(() => {
    db.close();
  });

  it('checks only bookmarks outside the subtree, adds the matches, and removes nothing', async () => {
    const ai = db.getOrCreateCategory('AI', null, WHEN);
    const rust = db.createCategory('Rust', null, WHEN)!;
    const asyncNode = db.getOrCreateCategory('Async', rust.id, WHEN);
    db.storeCategorizedBatch([bm('1', 'rust async')], () => [asyncNode.id], WHEN);
    db.storeCategorizedBatch([bm('2', 'rust borrow checker'), bm('3', 'gpt evals'), bm('4', 'rust macros')], () => [ai.id], WHEN);

    const prompts: string[] = [];
    const logs: string[] = [];
    const summary = await findBookmarksForCategory({
      db,
      categoryId: rust.id,
      batchSize: 2,
      runner: async (prompt) => {
        prompts.push(prompt);
        const ids = [...prompt.matchAll(/post_id: (\d+)\n\s+author: @a\n\s+text: rust/g)].map((m) => m[1]);
        return JSON.stringify({ matches: ids });
      },
      logger: (m) => logs.push(m),
    });

    expect(prompts).toHaveLength(2); // three candidates in batches of two
    expect(prompts.join('\n')).not.toContain('post_id: 1'); // already in the subtree
    expect(summary).toMatchObject({ categoryName: 'Rust', checked: 3, added: 2 });
    const id = (p: string) => db.getBookmarkByPostId(p)!.id;
    expect(summary.addedBookmarkIds.sort()).toEqual([id('2'), id('4')].sort());
    // Added, never moved: each match keeps the category it already had.
    expect(db.getCategoryIdsForBookmarks([id('2')]).get(id('2'))!.sort()).toEqual([ai.id, rust.id].sort());
    expect(db.getCategoryIdsForBookmarks([id('3')]).get(id('3'))).toEqual([ai.id]);
    expect(logs.at(-1)).toBe('Added 2 bookmark(s) to “Rust”.');
  });

  it('asks nothing when every bookmark is already in the category', async () => {
    const rust = db.createCategory('Rust', null, WHEN)!;
    db.storeCategorizedBatch([bm('1')], () => [rust.id], WHEN);
    let calls = 0;
    const summary = await findBookmarksForCategory({
      db,
      categoryId: rust.id,
      batchSize: 10,
      runner: async () => {
        calls++;
        return '{"matches":[]}';
      },
    });
    expect(calls).toBe(0);
    expect(summary.added).toBe(0);
  });

  it('refuses an unknown category, and describes a known one by its full path', async () => {
    const rust = db.createCategory('Rust', null, WHEN)!;
    const inner = db.createCategory('Web', rust.id, WHEN)!;
    db.getOrCreateCategory('Axum', inner.id, WHEN);
    expect(describeFindTarget(db, inner.id)).toEqual({ path: ['Rust', 'Web'], description: null, children: ['Axum'] });
    await expect(
      findBookmarksForCategory({ db, categoryId: 999, batchSize: 10, runner: async () => '{"matches":[]}' }),
    ).rejects.toThrow(/no longer exists/);
  });
});
