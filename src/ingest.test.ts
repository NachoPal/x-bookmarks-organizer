import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from './db/database';
import { collectNewBookmarks, runIngest } from './ingest';
import type { XClient, BookmarkPage } from './x/client';
import type { BatchCategorizer } from './categorize/llm';
import type { Assignment, RawBookmark } from './types';

function bm(postId: string, text = `t-${postId}`): RawBookmark {
  return {
    postId,
    authorUsername: 'a',
    authorName: 'A',
    text,
    url: `https://x.com/a/status/${postId}`,
    postCreatedAt: '',
  };
}

/**
 * Fake X client that serves a fixed newest-first list of bookmarks, paginated.
 * Records how many pages were requested so we can assert the loop stops early.
 */
class FakeXClient implements XClient {
  pagesFetched = 0;
  constructor(
    private readonly all: RawBookmark[],
    private readonly pageSize = 2,
  ) {}

  async fetchBookmarksPage(paginationToken?: string): Promise<BookmarkPage> {
    this.pagesFetched++;
    const start = paginationToken ? Number.parseInt(paginationToken, 10) : 0;
    const slice = this.all.slice(start, start + this.pageSize);
    const nextStart = start + this.pageSize;
    return {
      bookmarks: slice,
      nextToken: nextStart < this.all.length ? String(nextStart) : undefined,
    };
  }
}

/** Fake categorizer driven by a fixed postId -> paths map. */
class FakeCategorizer implements BatchCategorizer {
  seenTrees: string[] = [];
  constructor(private readonly map: Record<string, string[][]>) {}
  async categorizeBatch(bookmarks: RawBookmark[], treeText: string): Promise<Assignment[]> {
    this.seenTrees.push(treeText);
    return bookmarks
      .filter((b) => this.map[b.postId])
      .map((b) => ({ postId: b.postId, categories: this.map[b.postId]! }));
  }
}

describe('collectNewBookmarks', () => {
  it('collects everything on a first run (empty DB)', async () => {
    const client = new FakeXClient([bm('5'), bm('4'), bm('3'), bm('2'), bm('1')]);
    const { newBookmarks, newestPostId } = await collectNewBookmarks(client, new Set());
    expect(newBookmarks.map((b) => b.postId)).toEqual(['5', '4', '3', '2', '1']);
    expect(newestPostId).toBe('5');
  });

  it('stops as soon as an already-seen bookmark appears', async () => {
    const client = new FakeXClient([bm('5'), bm('4'), bm('3'), bm('2'), bm('1')]);
    const known = new Set(['3', '2', '1']);
    const { newBookmarks } = await collectNewBookmarks(client, known);
    expect(newBookmarks.map((b) => b.postId)).toEqual(['5', '4']);
    // Should stop on page 2 (contains '3'); must not fetch all pages.
    expect(client.pagesFetched).toBe(2);
  });

  it('re-running immediately after ingest yields zero new bookmarks', async () => {
    const client = new FakeXClient([bm('5'), bm('4'), bm('3')]);
    const known = new Set(['5', '4', '3']);
    const { newBookmarks } = await collectNewBookmarks(client, known);
    expect(newBookmarks).toHaveLength(0);
  });
});

describe('runIngest', () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(':memory:');
  });
  afterEach(() => {
    db.close();
  });

  it('files new bookmarks into the tree, creating nested nodes', async () => {
    const client = new FakeXClient([bm('2'), bm('1')]);
    const categorizer = new FakeCategorizer({
      '1': [['AI', 'Evals']],
      '2': [['Game Dev', 'Tools']],
    });
    const summary = await runIngest({ db, client, categorizer, batchSize: 10, maxDepth: 4 });

    expect(summary.newBookmarks).toBe(2);
    const cats = db.getAllCategories().map((c) => c.name).sort();
    expect(cats).toEqual(['AI', 'Evals', 'Game Dev', 'Tools']);

    const evals = db.getAllCategories().find((c) => c.name === 'Evals')!;
    expect(db.getBookmarksForCategory(evals.id).map((b) => b.postId)).toEqual(['1']);
  });

  it('reuses existing nodes instead of creating duplicates', async () => {
    const when = new Date().toISOString();
    const ai = db.getOrCreateCategory('AI', null, when);
    db.getOrCreateCategory('Evals', ai.id, when);
    const before = db.getAllCategories().length;

    const client = new FakeXClient([bm('1')]);
    const categorizer = new FakeCategorizer({ '1': [['AI', 'Evals']] });
    const summary = await runIngest({ db, client, categorizer, batchSize: 10, maxDepth: 4 });

    expect(summary.nodesCreated).toBe(0);
    expect(db.getAllCategories().length).toBe(before);
  });

  it('supports multi-category placement (a bookmark in several branches)', async () => {
    const client = new FakeXClient([bm('1')]);
    const categorizer = new FakeCategorizer({ '1': [['AI'], ['Research', 'Papers']] });
    await runIngest({ db, client, categorizer, batchSize: 10, maxDepth: 4 });

    const aiId = db.getAllCategories().find((c) => c.name === 'AI')!.id;
    const papersId = db.getAllCategories().find((c) => c.name === 'Papers')!.id;
    expect(db.getBookmarksForCategory(aiId).map((b) => b.postId)).toEqual(['1']);
    expect(db.getBookmarksForCategory(papersId).map((b) => b.postId)).toEqual(['1']);
  });

  it('files bookmarks the LLM did not categorize under Uncategorized', async () => {
    const client = new FakeXClient([bm('1')]);
    const categorizer = new FakeCategorizer({}); // returns no assignments
    await runIngest({ db, client, categorizer, batchSize: 10, maxDepth: 4 });

    const uncategorized = db.getAllCategories().find((c) => c.name === 'Uncategorized')!;
    expect(uncategorized).toBeDefined();
    expect(db.getBookmarksForCategory(uncategorized.id).map((b) => b.postId)).toEqual(['1']);
  });

  it('is incremental: a second immediate run processes zero and re-categorizes nothing', async () => {
    const all = [bm('2'), bm('1')];
    const categorizer = new FakeCategorizer({ '1': [['AI']], '2': [['AI']] });

    const first = await runIngest({
      db,
      client: new FakeXClient(all),
      categorizer,
      batchSize: 10,
      maxDepth: 4,
    });
    expect(first.newBookmarks).toBe(2);

    const treesSeenAfterFirst = categorizer.seenTrees.length;
    const second = await runIngest({
      db,
      client: new FakeXClient(all),
      categorizer,
      batchSize: 10,
      maxDepth: 4,
    });
    expect(second.newBookmarks).toBe(0);
    // The categorizer was not invoked again (no extra prompt built).
    expect(categorizer.seenTrees.length).toBe(treesSeenAfterFirst);
  });

  it('caps category depth at maxDepth', async () => {
    const client = new FakeXClient([bm('1')]);
    const categorizer = new FakeCategorizer({ '1': [['A', 'B', 'C', 'D', 'E']] });
    await runIngest({ db, client, categorizer, batchSize: 10, maxDepth: 3 });

    const names = db.getAllCategories().map((c) => c.name).sort();
    expect(names).toEqual(['A', 'B', 'C']); // D, E dropped
  });
});
