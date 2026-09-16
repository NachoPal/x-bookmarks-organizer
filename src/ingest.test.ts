import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from './db/database';
import { collectNewBookmarks, recategorizeAll, runIngest } from './ingest';
import type { XClient, BookmarkPage } from './x/client';
import type { BatchCategorizer } from './categorize/llm';
import type { TaxonomyDesigner } from './categorize/taxonomy';
import type { Assignment, RawBookmark, TaxonomyNode } from './types';

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

/** Build a taxonomy tree from a list of root->leaf paths (for fakes). */
function treeFromPaths(paths: string[][]): TaxonomyNode[] {
  const roots: TaxonomyNode[] = [];
  for (const path of paths) {
    let level = roots;
    for (const name of path) {
      let node = level.find((n) => n.name === name);
      if (!node) {
        node = { name, children: [] };
        level.push(node);
      }
      level = node.children;
    }
  }
  return roots;
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

/** Fake taxonomy designer returning a fixed tree; records what it was shown. */
class FakeTaxonomyDesigner implements TaxonomyDesigner {
  seenBookmarkCounts: number[] = [];
  seenExistingTrees: string[] = [];
  constructor(private readonly tree: TaxonomyNode[]) {}
  async designTaxonomy(
    bookmarks: RawBookmark[],
    existingTreeText: string,
  ): Promise<TaxonomyNode[]> {
    this.seenBookmarkCounts.push(bookmarks.length);
    this.seenExistingTrees.push(existingTreeText);
    return this.tree;
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

describe('runIngest (two-pass)', () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(':memory:');
  });
  afterEach(() => {
    db.close();
  });

  it('designs a taxonomy holistically then files bookmarks into it', async () => {
    const client = new FakeXClient([bm('2'), bm('1')]);
    const taxonomer = new FakeTaxonomyDesigner(
      treeFromPaths([['AI', 'Evals'], ['Game Dev', 'Tools']]),
    );
    const categorizer = new FakeCategorizer({
      '1': [['AI', 'Evals']],
      '2': [['Game Dev', 'Tools']],
    });
    const summary = await runIngest({
      db,
      client,
      taxonomer,
      categorizer,
      batchSize: 10,
      maxDepth: 4,
    });

    expect(summary.newBookmarks).toBe(2);
    // Pass 1 saw ALL new bookmarks at once (the holistic view).
    expect(taxonomer.seenBookmarkCounts).toEqual([2]);

    const cats = db.getAllCategories().map((c) => c.name).sort();
    expect(cats).toEqual(['AI', 'Evals', 'Game Dev', 'Tools']);

    const evals = db.getAllCategories().find((c) => c.name === 'Evals')!;
    expect(db.getBookmarksForCategory(evals.id).map((b) => b.postId)).toEqual(['1']);
  });

  it('extends an existing tree instead of duplicating nodes', async () => {
    const when = new Date().toISOString();
    const ai = db.getOrCreateCategory('AI', null, when);
    db.getOrCreateCategory('Evals', ai.id, when);
    const before = db.getAllCategories().length;

    const client = new FakeXClient([bm('1')]);
    // Taxonomy pass adds nothing new (the existing tree already covers it).
    const taxonomer = new FakeTaxonomyDesigner(treeFromPaths([['AI', 'Evals']]));
    const categorizer = new FakeCategorizer({ '1': [['AI', 'Evals']] });
    const summary = await runIngest({
      db,
      client,
      taxonomer,
      categorizer,
      batchSize: 10,
      maxDepth: 4,
    });

    // Pass 1 was seeded with the existing tree.
    expect(taxonomer.seenExistingTrees[0]).toContain('- AI');
    expect(summary.nodesCreated).toBe(0);
    expect(db.getAllCategories().length).toBe(before);
  });

  it('supports multi-category placement (a bookmark in several branches)', async () => {
    const client = new FakeXClient([bm('1')]);
    const taxonomer = new FakeTaxonomyDesigner(
      treeFromPaths([['AI'], ['Research', 'Papers']]),
    );
    const categorizer = new FakeCategorizer({ '1': [['AI'], ['Research', 'Papers']] });
    await runIngest({ db, client, taxonomer, categorizer, batchSize: 10, maxDepth: 4 });

    const aiId = db.getAllCategories().find((c) => c.name === 'AI')!.id;
    const papersId = db.getAllCategories().find((c) => c.name === 'Papers')!.id;
    expect(db.getBookmarksForCategory(aiId).map((b) => b.postId)).toEqual(['1']);
    expect(db.getBookmarksForCategory(papersId).map((b) => b.postId)).toEqual(['1']);
  });

  it('files bookmarks the assignment pass did not place under Uncategorized', async () => {
    const client = new FakeXClient([bm('1')]);
    const taxonomer = new FakeTaxonomyDesigner(treeFromPaths([['AI']]));
    const categorizer = new FakeCategorizer({}); // returns no assignments
    await runIngest({ db, client, taxonomer, categorizer, batchSize: 10, maxDepth: 4 });

    const uncategorized = db.getAllCategories().find((c) => c.name === 'Uncategorized')!;
    expect(uncategorized).toBeDefined();
    expect(db.getBookmarksForCategory(uncategorized.id).map((b) => b.postId)).toEqual(['1']);
  });

  it('files off-tree assignment paths under Uncategorized rather than inventing nodes', async () => {
    const client = new FakeXClient([bm('1')]);
    const taxonomer = new FakeTaxonomyDesigner(treeFromPaths([['AI', 'Evals']]));
    // The assignment pass returns a path that is NOT part of the designed tree.
    const categorizer = new FakeCategorizer({ '1': [['Made', 'Up', 'Path']] });
    await runIngest({ db, client, taxonomer, categorizer, batchSize: 10, maxDepth: 4 });

    // No "Made"/"Up"/"Path" nodes were minted; only the designed tree + fallback.
    const names = db.getAllCategories().map((c) => c.name).sort();
    expect(names).toEqual(['AI', 'Evals', 'Uncategorized']);
    const uncategorized = db.getAllCategories().find((c) => c.name === 'Uncategorized')!;
    expect(db.getBookmarksForCategory(uncategorized.id).map((b) => b.postId)).toEqual(['1']);
  });

  it('is incremental: a second immediate run processes zero and runs neither pass', async () => {
    const all = [bm('2'), bm('1')];
    const taxonomer = new FakeTaxonomyDesigner(treeFromPaths([['AI']]));
    const categorizer = new FakeCategorizer({ '1': [['AI']], '2': [['AI']] });

    const first = await runIngest({
      db,
      client: new FakeXClient(all),
      taxonomer,
      categorizer,
      batchSize: 10,
      maxDepth: 4,
    });
    expect(first.newBookmarks).toBe(2);

    const passesAfterFirst = {
      taxonomy: taxonomer.seenBookmarkCounts.length,
      assign: categorizer.seenTrees.length,
    };
    const second = await runIngest({
      db,
      client: new FakeXClient(all),
      taxonomer,
      categorizer,
      batchSize: 10,
      maxDepth: 4,
    });
    expect(second.newBookmarks).toBe(0);
    // Neither pass was invoked again.
    expect(taxonomer.seenBookmarkCounts.length).toBe(passesAfterFirst.taxonomy);
    expect(categorizer.seenTrees.length).toBe(passesAfterFirst.assign);
  });

  it('caps category depth at maxDepth', async () => {
    const client = new FakeXClient([bm('1')]);
    const taxonomer = new FakeTaxonomyDesigner(treeFromPaths([['A', 'B', 'C', 'D', 'E']]));
    const categorizer = new FakeCategorizer({ '1': [['A', 'B', 'C', 'D', 'E']] });
    await runIngest({ db, client, taxonomer, categorizer, batchSize: 10, maxDepth: 3 });

    const names = db.getAllCategories().map((c) => c.name).sort();
    expect(names).toEqual(['A', 'B', 'C']); // D, E dropped
  });
});

describe('recategorizeAll', () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(':memory:');
  });
  afterEach(() => {
    db.close();
  });

  /** Seed the DB with two stored, categorized bookmarks (as a shallow first run would). */
  async function seedShallow(): Promise<void> {
    const client = new FakeXClient([bm('2'), bm('1')]);
    const taxonomer = new FakeTaxonomyDesigner(treeFromPaths([['Everything']]));
    const categorizer = new FakeCategorizer({ '1': [['Everything']], '2': [['Everything']] });
    await runIngest({ db, client, taxonomer, categorizer, batchSize: 10, maxDepth: 4 });
  }

  it('rebuilds the taxonomy and reassigns all stored bookmarks', async () => {
    await seedShallow();
    expect(db.getAllCategories().map((c) => c.name)).toEqual(['Everything']);

    // A better, deeper taxonomy on the re-run.
    const taxonomer = new FakeTaxonomyDesigner(
      treeFromPaths([['AI', 'LLMs', 'Evals'], ['Game Dev', 'Engines']]),
    );
    const categorizer = new FakeCategorizer({
      '1': [['AI', 'LLMs', 'Evals']],
      '2': [['Game Dev', 'Engines']],
    });
    const summary = await recategorizeAll({
      db,
      taxonomer,
      categorizer,
      batchSize: 10,
      maxDepth: 4,
    });

    expect(summary.bookmarks).toBe(2);
    // Old "Everything" bucket is gone; the new deep tree replaced it.
    const names = db.getAllCategories().map((c) => c.name).sort();
    expect(names).toEqual(['AI', 'Engines', 'Evals', 'Game Dev', 'LLMs']);
    // Pass 1 saw all stored bookmarks from an empty starting tree.
    expect(taxonomer.seenBookmarkCounts).toEqual([2]);
    expect(taxonomer.seenExistingTrees[0]).toContain('no categories yet');

    const evals = db.getAllCategories().find((c) => c.name === 'Evals')!;
    expect(db.getBookmarksForCategory(evals.id).map((b) => b.postId)).toEqual(['1']);
  });

  it('preserves read state and read dates across a re-categorize', async () => {
    await seedShallow();
    const target = db.getBookmarkByPostId('1')!;
    db.markRead(target.id, '2024-01-01T00:00:00.000Z');

    const taxonomer = new FakeTaxonomyDesigner(treeFromPaths([['AI']]));
    const categorizer = new FakeCategorizer({ '1': [['AI']], '2': [['AI']] });
    await recategorizeAll({ db, taxonomer, categorizer, batchSize: 10, maxDepth: 4 });

    const after = db.getBookmarkByPostId('1')!;
    expect(after.read).toBe(true);
    expect(after.readAt).toBe('2024-01-01T00:00:00.000Z');
  });

  it('is a no-op with an empty database', async () => {
    const taxonomer = new FakeTaxonomyDesigner(treeFromPaths([['AI']]));
    const categorizer = new FakeCategorizer({});
    const summary = await recategorizeAll({
      db,
      taxonomer,
      categorizer,
      batchSize: 10,
      maxDepth: 4,
    });
    expect(summary).toEqual({ bookmarks: 0, batches: 0, nodesCreated: 0 });
    expect(taxonomer.seenBookmarkCounts).toEqual([]);
  });
});
