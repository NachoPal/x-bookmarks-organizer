import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from './db/database';
import { collectNewBookmarks, recategorizeAll, runIngest } from './ingest';
import type { XClient, BookmarkPage } from './x/client';
import type { AssignMode, BatchCategorizer } from './categorize/llm';
import type { TaxonomyDesigner } from './categorize/taxonomy';
import type { ArticleContext } from './articles/link-metadata';
import type { ArticleFetcher, ArticleExtractionResult } from './articles/fetch-article';
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
  seenArticleContexts: (Map<string, ArticleContext> | undefined)[] = [];
  constructor(private readonly tree: TaxonomyNode[]) {}
  async designTaxonomy(
    bookmarks: RawBookmark[],
    existingTreeText: string,
    articleContext?: Map<string, ArticleContext>,
  ): Promise<TaxonomyNode[]> {
    this.seenBookmarkCounts.push(bookmarks.length);
    this.seenExistingTrees.push(existingTreeText);
    this.seenArticleContexts.push(articleContext);
    return this.tree;
  }
}

/** Fake categorizer driven by a fixed postId -> paths map. */
class FakeCategorizer implements BatchCategorizer {
  seenTrees: string[] = [];
  seenModes: AssignMode[] = [];
  seenArticleContexts: (Map<string, ArticleContext> | undefined)[] = [];
  constructor(private readonly map: Record<string, string[][]>) {}
  async categorizeBatch(
    bookmarks: RawBookmark[],
    treeText: string,
    mode: AssignMode = 'strict',
    articleContext?: Map<string, ArticleContext>,
  ): Promise<Assignment[]> {
    this.seenTrees.push(treeText);
    this.seenModes.push(mode);
    this.seenArticleContexts.push(articleContext);
    return bookmarks
      .filter((b) => this.map[b.postId])
      .map((b) => ({ postId: b.postId, categories: this.map[b.postId]! }));
  }
}

/** Fake article fetcher driven by a fixed url -> result map. */
class FakeArticleFetcher implements ArticleFetcher {
  calls: string[] = [];
  constructor(private readonly map: Record<string, ArticleExtractionResult>) {}
  async fetch(url: string): Promise<ArticleExtractionResult> {
    this.calls.push(url);
    return this.map[url] ?? { status: 'failed', reason: 'not found' };
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

  it('incremental run against an existing tree skips the taxonomy designer and files into it', async () => {
    const when = new Date().toISOString();
    const ai = db.getOrCreateCategory('AI', null, when);
    db.getOrCreateCategory('Evals', ai.id, when);
    const before = db.getAllCategories().length;

    const client = new FakeXClient([bm('1')]);
    // If the designer were called it would blow the tree up - it must NOT be.
    const taxonomer = new FakeTaxonomyDesigner(treeFromPaths([['SHOULD-NOT-BE-USED']]));
    const categorizer = new FakeCategorizer({ '1': [['AI', 'Evals']] });
    const summary = await runIngest({
      db,
      client,
      taxonomer,
      categorizer,
      batchSize: 10,
      maxDepth: 4,
    });

    // The expensive taxonomy-design pass was skipped entirely.
    expect(taxonomer.seenBookmarkCounts).toEqual([]);
    // The assignment pass ran in extend mode against the existing tree.
    expect(categorizer.seenModes).toEqual(['extend']);
    expect(categorizer.seenTrees[0]).toContain('- AI');
    // No nodes duplicated; the new bookmark filed into the existing leaf.
    expect(summary.nodesCreated).toBe(0);
    expect(db.getAllCategories().length).toBe(before);
    const evals = db.getAllCategories().find((c) => c.name === 'Evals')!;
    expect(db.getBookmarksForCategory(evals.id).map((b) => b.postId)).toEqual(['1']);
  });

  it('incremental extend reuses existing nodes and creates a node only when nothing fits', async () => {
    const when = new Date().toISOString();
    const ai = db.getOrCreateCategory('AI', null, when);
    db.getOrCreateCategory('Evals', ai.id, when);

    // Two new bookmarks: one reuses the existing leaf, one needs a brand-new node.
    const client = new FakeXClient([bm('3'), bm('2')]);
    const taxonomer = new FakeTaxonomyDesigner(treeFromPaths([['SHOULD-NOT-BE-USED']]));
    const categorizer = new FakeCategorizer({
      '2': [['AI', 'Evals']], // reuse
      '3': [['Robotics', 'Actuators']], // create
    });
    const summary = await runIngest({
      db,
      client,
      taxonomer,
      categorizer,
      batchSize: 10,
      maxDepth: 4,
    });

    expect(taxonomer.seenBookmarkCounts).toEqual([]);
    // Robotics + Actuators created; AI/Evals not duplicated.
    const names = db.getAllCategories().map((c) => c.name).sort();
    expect(names).toEqual(['AI', 'Actuators', 'Evals', 'Robotics']);
    expect(summary.nodesCreated).toBe(2);

    const evals = db.getAllCategories().find((c) => c.name === 'Evals')!;
    const actuators = db.getAllCategories().find((c) => c.name === 'Actuators')!;
    expect(db.getBookmarksForCategory(evals.id).map((b) => b.postId)).toEqual(['2']);
    expect(db.getBookmarksForCategory(actuators.id).map((b) => b.postId)).toEqual(['3']);
  });

  it('incremental extend files an unplaced bookmark under Uncategorized', async () => {
    const when = new Date().toISOString();
    db.getOrCreateCategory('AI', null, when);

    const client = new FakeXClient([bm('2')]);
    const taxonomer = new FakeTaxonomyDesigner(treeFromPaths([['SHOULD-NOT-BE-USED']]));
    const categorizer = new FakeCategorizer({}); // no assignment for '2'
    await runIngest({ db, client, taxonomer, categorizer, batchSize: 10, maxDepth: 4 });

    expect(taxonomer.seenBookmarkCounts).toEqual([]);
    const uncategorized = db.getAllCategories().find((c) => c.name === 'Uncategorized')!;
    expect(uncategorized).toBeDefined();
    expect(db.getBookmarksForCategory(uncategorized.id).map((b) => b.postId)).toEqual(['2']);
  });

  it('incremental extend caps created paths at maxDepth', async () => {
    const when = new Date().toISOString();
    db.getOrCreateCategory('A', null, when);

    const client = new FakeXClient([bm('2')]);
    const taxonomer = new FakeTaxonomyDesigner(treeFromPaths([['SHOULD-NOT-BE-USED']]));
    const categorizer = new FakeCategorizer({ '2': [['A', 'B', 'C', 'D', 'E']] });
    await runIngest({ db, client, taxonomer, categorizer, batchSize: 10, maxDepth: 3 });

    expect(taxonomer.seenBookmarkCounts).toEqual([]);
    const names = db.getAllCategories().map((c) => c.name).sort();
    expect(names).toEqual(['A', 'B', 'C']); // D, E dropped by the depth cap
  });

  it('re-renders the tree between extend batches so a later batch reuses an earlier-created node', async () => {
    const when = new Date().toISOString();
    db.getOrCreateCategory('AI', null, when); // existing tree -> extend mode

    // Two new robotics bookmarks; batchSize 1 forces two separate extend batches.
    const client = new FakeXClient([bm('3'), bm('2')]);

    // A reuse-or-create categorizer that mimics a real model: it reuses the
    // 'Robotics' node when the tree it is shown already contains it; otherwise it
    // mints a fresh label, diverging on repeat. If a later batch is shown a stale
    // tree missing the node the earlier batch created, it produces 'Robots'.
    const freshLabels = ['Robotics', 'Robots'];
    class ReuseOrCreateCategorizer implements BatchCategorizer {
      created = 0;
      async categorizeBatch(bookmarks: RawBookmark[], treeText: string): Promise<Assignment[]> {
        const label = treeText.includes('Robotics') ? 'Robotics' : freshLabels[this.created++]!;
        return bookmarks.map((b) => ({ postId: b.postId, categories: [[label, 'Actuators']] }));
      }
    }
    const taxonomer = new FakeTaxonomyDesigner(treeFromPaths([['SHOULD-NOT-BE-USED']]));
    await runIngest({
      db,
      client,
      taxonomer,
      categorizer: new ReuseOrCreateCategorizer(),
      batchSize: 1,
      maxDepth: 4,
    });

    expect(taxonomer.seenBookmarkCounts).toEqual([]);
    const names = db.getAllCategories().map((c) => c.name).sort();
    expect(names).toContain('Robotics');
    expect(names).not.toContain('Robots'); // no near-duplicate sibling minted
    // Both bookmarks landed in the single reused Robotics subtree.
    const actuators = db.getAllCategories().find((c) => c.name === 'Actuators')!;
    expect(db.getBookmarksForCategory(actuators.id).map((b) => b.postId).sort()).toEqual(['2', '3']);
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

  it('records the last-synced timestamp on a run that finds new bookmarks', async () => {
    expect(db.getLastSyncedAt()).toBeUndefined();
    const client = new FakeXClient([bm('1')]);
    const taxonomer = new FakeTaxonomyDesigner(treeFromPaths([['AI']]));
    const categorizer = new FakeCategorizer({ '1': [['AI']] });
    await runIngest({ db, client, taxonomer, categorizer, batchSize: 10, maxDepth: 4 });

    expect(db.getLastSyncedAt()).toBeDefined();
  });

  it('records the last-synced timestamp even when there is nothing new to fetch', async () => {
    const client = new FakeXClient([]);
    const taxonomer = new FakeTaxonomyDesigner(treeFromPaths([['AI']]));
    const categorizer = new FakeCategorizer({});
    const result = await runIngest({ db, client, taxonomer, categorizer, batchSize: 10, maxDepth: 4 });

    expect(result.newBookmarks).toBe(0);
    expect(db.getLastSyncedAt()).toBeDefined();
  });
});

describe('runIngest article context (issue #25)', () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(':memory:');
  });
  afterEach(() => {
    db.close();
  });

  it('fetches the linked article title and feeds it to both categorization passes', async () => {
    const client = new FakeXClient([bm('1', 'check this out https://example.com/piece')]);
    const taxonomer = new FakeTaxonomyDesigner(treeFromPaths([['AI']]));
    const categorizer = new FakeCategorizer({ '1': [['AI']] });
    const articleFetcher = new FakeArticleFetcher({
      'https://example.com/piece': {
        status: 'ok',
        title: 'A Deep Dive on Transformers',
        contentHtml: '<p>...</p>',
        excerpt: 'Sparse attention explained',
        siteName: 'Example',
      },
    });

    await runIngest({
      db,
      client,
      taxonomer,
      categorizer,
      articleFetcher,
      batchSize: 10,
      maxDepth: 4,
    });

    expect(articleFetcher.calls).toEqual(['https://example.com/piece']);
    const taxonomyContext = taxonomer.seenArticleContexts[0];
    expect(taxonomyContext?.get('1')).toEqual({
      title: 'A Deep Dive on Transformers',
      description: 'Sparse attention explained',
    });
    const assignContext = categorizer.seenArticleContexts[0];
    expect(assignContext?.get('1')).toEqual({
      title: 'A Deep Dive on Transformers',
      description: 'Sparse attention explained',
    });

    // The fetch is cached by URL so a later run never re-fetches it.
    expect(db.getArticleLinkMetadata('https://example.com/piece')?.status).toBe('ok');
  });

  it('feeds an X Article\'s title/preview to both passes and stores it with the bookmark, fetching nothing', async () => {
    const xArticle = {
      restId: '777',
      title: 'How to Build Agent Memory',
      previewText: 'Search and retrieval.',
      plainText: 'Body',
      coverUrl: null,
      coverWidth: null,
      coverHeight: null,
    };
    const client = new FakeXClient([{ ...bm('1', 'https://t.co/onlyALink'), xArticle }]);
    const taxonomer = new FakeTaxonomyDesigner(treeFromPaths([['AI']]));
    const categorizer = new FakeCategorizer({ '1': [['AI']] });
    const articleFetcher = new FakeArticleFetcher({});

    await runIngest({ db, client, taxonomer, categorizer, articleFetcher, batchSize: 10, maxDepth: 4 });

    const expected = { title: 'How to Build Agent Memory', description: 'Search and retrieval.' };
    expect(taxonomer.seenArticleContexts[0]?.get('1')).toEqual(expected);
    expect(categorizer.seenArticleContexts[0]?.get('1')).toEqual(expected);
    expect(articleFetcher.calls).toEqual([]);
    expect(db.getXArticle('1')).toEqual(xArticle);
  });

  it('falls back to today\'s behavior (no article context) on a fetch failure, without blocking ingest', async () => {
    const client = new FakeXClient([bm('1', 'dead link https://example.com/dead')]);
    const taxonomer = new FakeTaxonomyDesigner(treeFromPaths([['AI']]));
    const categorizer = new FakeCategorizer({ '1': [['AI']] });
    const articleFetcher = new FakeArticleFetcher({
      'https://example.com/dead': { status: 'failed', reason: 'HTTP 404' },
    });

    const summary = await runIngest({
      db,
      client,
      taxonomer,
      categorizer,
      articleFetcher,
      batchSize: 10,
      maxDepth: 4,
    });

    expect(summary.newBookmarks).toBe(1);
    expect(taxonomer.seenArticleContexts[0]?.has('1')).toBe(false);
    expect(db.getArticleLinkMetadata('https://example.com/dead')?.status).toBe('failed');
  });

  it('never fetches or passes article context for bookmarks with no link', async () => {
    const client = new FakeXClient([bm('1', 'just some plain text, no link')]);
    const taxonomer = new FakeTaxonomyDesigner(treeFromPaths([['AI']]));
    const categorizer = new FakeCategorizer({ '1': [['AI']] });
    const articleFetcher = new FakeArticleFetcher({});

    await runIngest({ db, client, taxonomer, categorizer, articleFetcher, batchSize: 10, maxDepth: 4 });

    expect(articleFetcher.calls).toEqual([]);
    expect(taxonomer.seenArticleContexts[0]?.size ?? 0).toBe(0);
  });
});

describe('deleted bookmarks are never resurrected', () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(':memory:');
  });
  afterEach(() => {
    db.close();
  });

  it('an incremental run never re-fetches/re-stores a deleted post', async () => {
    // First run stores '1' and '2'.
    const firstClient = new FakeXClient([bm('2'), bm('1')]);
    const taxonomer = new FakeTaxonomyDesigner(treeFromPaths([['Everything']]));
    const categorizer = new FakeCategorizer({ '1': [['Everything']], '2': [['Everything']] });
    await runIngest({ db, client: firstClient, taxonomer, categorizer, batchSize: 10, maxDepth: 4 });

    const deleted = db.getBookmarkByPostId('1')!;
    expect(db.deleteBookmark(deleted.id)).toBe(true);

    // A later sync sees the same timeline again (X still has the bookmark -
    // the tool is read-only against X and never un-bookmarks it there), plus
    // one genuinely new post.
    const secondClient = new FakeXClient([bm('3'), bm('2'), bm('1')]);
    const summary = await runIngest({
      db,
      client: secondClient,
      taxonomer,
      categorizer: new FakeCategorizer({ '1': [['Everything']], '3': [['Everything']] }),
      batchSize: 10,
      maxDepth: 4,
    });

    // Only '3' is new; '1' must not come back despite still being on X.
    expect(summary.newBookmarks).toBe(1);
    expect(db.getBookmarkByPostId('1')).toBeUndefined();
    expect(db.getBookmarkByPostId('3')).toBeDefined();
  });

  it('recategorize never reassigns or resurrects a deleted post', async () => {
    const client = new FakeXClient([bm('2'), bm('1')]);
    const taxonomer = new FakeTaxonomyDesigner(treeFromPaths([['Everything']]));
    const categorizer = new FakeCategorizer({ '1': [['Everything']], '2': [['Everything']] });
    await runIngest({ db, client, taxonomer, categorizer, batchSize: 10, maxDepth: 4 });

    const deleted = db.getBookmarkByPostId('1')!;
    db.deleteBookmark(deleted.id);

    const recatTaxonomer = new FakeTaxonomyDesigner(treeFromPaths([['AI']]));
    const recatCategorizer = new FakeCategorizer({ '1': [['AI']], '2': [['AI']] });
    const summary = await recategorizeAll({
      db,
      taxonomer: recatTaxonomer,
      categorizer: recatCategorizer,
      batchSize: 10,
      maxDepth: 4,
    });

    // Recategorize never re-fetches from X; it only reassigns what is still
    // stored, so the deleted post is neither seen nor brought back.
    expect(summary.bookmarks).toBe(1);
    expect(db.getBookmarkByPostId('1')).toBeUndefined();
    expect(db.getBookmarkByPostId('2')).toBeDefined();
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

  it('picks up the linked article title on re-run, so a previously Uncategorized link post can be re-sorted (issue #25)', async () => {
    // Simulate a bookmark stored by pre-#25 code: filed under Uncategorized,
    // with no article_link_metadata row for its link (the feature did not
    // exist yet, so it was never fetched).
    const when = new Date().toISOString();
    const uncategorized = db.getOrCreateCategory('Uncategorized', null, when);
    db.storeCategorizedBatch([bm('1', 'https://example.com/piece')], () => [uncategorized.id], when);
    expect(db.getArticleLinkMetadata('https://example.com/piece')).toBeUndefined();

    // recategorize with an article fetcher now wired up.
    const taxonomer = new FakeTaxonomyDesigner(treeFromPaths([['AI', 'Transformers']]));
    const categorizer = new FakeCategorizer({ '1': [['AI', 'Transformers']] });
    const articleFetcher = new FakeArticleFetcher({
      'https://example.com/piece': {
        status: 'ok',
        title: 'A Deep Dive on Transformers',
        contentHtml: '<p>...</p>',
        excerpt: null,
        siteName: null,
      },
    });
    await recategorizeAll({ db, taxonomer, categorizer, articleFetcher, batchSize: 10, maxDepth: 4 });

    expect(taxonomer.seenArticleContexts[0]?.get('1')?.title).toBe('A Deep Dive on Transformers');
    const transformers = db.getAllCategories().find((c) => c.name === 'Transformers')!;
    expect(db.getBookmarksForCategory(transformers.id).map((b) => b.postId)).toEqual(['1']);
  });
});

describe('owner categories (made by hand in the category editor)', () => {
  let db: Database;
  const when = '2026-09-24T00:00:00.000Z';
  beforeEach(() => {
    db = new Database(':memory:');
  });
  afterEach(() => {
    db.close();
  });

  /** Snapshot of the owner's categories as they must stay: id, name, place, description. */
  function ownerSnapshot() {
    return db
      .getUserCategories()
      .map((c) => ({ id: c.id, name: c.name, parentId: c.parentId, description: c.description ?? null }));
  }

  it('a first sync with only owner categories still designs a taxonomy, anchored on them', async () => {
    const rust = db.createCategory('Rust', null, when)!;
    const reading = db.createCategory('Reading', null, when)!;
    db.createCategory('Papers', reading.id, when);
    const before = ownerSnapshot();

    const client = new FakeXClient([bm('3'), bm('2'), bm('1')]);
    const designed: TaxonomyNode[] = [
      // Kept verbatim, but the designer tries to describe it and adds a child.
      { name: 'Rust', description: 'Rewritten by the model.', children: [{ name: 'Async', children: [] }] },
      // Re-rooted: the owner's root minted again one level down.
      { name: 'Programming', children: [{ name: 'reading', children: [{ name: 'Novels', children: [] }] }] },
      { name: 'AI', children: [{ name: 'Evals', children: [] }] },
    ];
    const taxonomer = new FakeTaxonomyDesigner(designed);
    const categorizer = new FakeCategorizer({
      '1': [['Rust', 'Async']],
      '2': [['Reading [owner]', 'Papers']],
      '3': [['AI', 'Evals']],
    });
    await runIngest({ db, client, taxonomer, categorizer, batchSize: 10, maxDepth: 4 });

    // Pass 1 ran (the owner's categories are anchors, not a finished tree)...
    expect(taxonomer.seenBookmarkCounts).toEqual([3]);
    expect(taxonomer.seenExistingTrees[0]).toContain('- Rust [owner]');
    expect(taxonomer.seenExistingTrees[0]).toContain('  - Papers [owner]');
    // ...and filing was strict against the merged tree.
    expect(categorizer.seenModes).toEqual(['strict']);

    // The owner's categories are exactly as they were.
    expect(ownerSnapshot()).toEqual(before);
    // Generated nodes sit around and inside them, never duplicating them.
    const byName = (n: string) => db.getAllCategories().filter((c) => c.name.toLowerCase() === n.toLowerCase());
    expect(byName('Rust')).toHaveLength(1);
    expect(byName('Reading')).toHaveLength(1);
    const asyncNode = byName('Async')[0]!;
    expect(asyncNode.parentId).toBe(rust.id);
    expect(asyncNode.origin).toBe('generated');
    expect(byName('Novels')[0]!.parentId).toBe(reading.id);
    expect(byName('AI')[0]!.origin).toBe('generated');

    const papers = byName('Papers')[0]!;
    expect(db.getBookmarksForCategory(papers.id).map((b) => b.postId)).toEqual(['2']);
    expect(db.getBookmarksForCategory(asyncNode.id).map((b) => b.postId)).toEqual(['1']);
  });

  it('files a strict path that names an owner category under a wrong prefix into the owner category', async () => {
    const rust = db.createCategory('Rust', null, when)!;
    const client = new FakeXClient([bm('2'), bm('1')]);
    const taxonomer = new FakeTaxonomyDesigner(treeFromPaths([['Rust'], ['AI']]));
    const categorizer = new FakeCategorizer({
      '1': [['Programming', 'Rust']],
      '2': [['Rust', 'Macros']], // a child that does not exist
    });
    await runIngest({ db, client, taxonomer, categorizer, batchSize: 10, maxDepth: 4 });
    expect(db.getBookmarksForCategory(rust.id).map((b) => b.postId).sort()).toEqual(['1', '2']);
    expect(db.getAllCategories().some((c) => c.name === 'Uncategorized')).toBe(false);
    expect(db.getAllCategories().some((c) => c.name === 'Programming' || c.name === 'Macros')).toBe(false);
  });

  it('a later sync extends instead of redesigning, and can file new posts into a category added between syncs', async () => {
    await runIngest({
      db,
      client: new FakeXClient([bm('1')]),
      taxonomer: new FakeTaxonomyDesigner(treeFromPaths([['AI']])),
      categorizer: new FakeCategorizer({ '1': [['AI']] }),
      batchSize: 10,
      maxDepth: 4,
    });
    const cooking = db.createCategory('Cooking', null, when)!;
    const llms = db.createCategory('LLMs', db.findCategory('AI', null)!.id, when)!;
    const before = ownerSnapshot();

    const taxonomer = new FakeTaxonomyDesigner(treeFromPaths([['Never']]));
    const categorizer = new FakeCategorizer({
      '2': [['Cooking [owner]']],
      '3': [['AI', 'LLM']], // near-duplicate of the owner's "LLMs"
      '4': [['Food', 'Cooking']], // the owner's root minted again deeper
      '5': [['Cooking', 'Bread']], // a new generated node INSIDE the owner's
    });
    await runIngest({
      db,
      client: new FakeXClient([bm('5'), bm('4'), bm('3'), bm('2'), bm('1')]),
      taxonomer,
      categorizer,
      batchSize: 10,
      maxDepth: 4,
    });

    expect(taxonomer.seenBookmarkCounts).toEqual([]);
    expect(categorizer.seenModes).toEqual(['extend']);
    expect(categorizer.seenTrees[0]).toContain('- Cooking [owner]');
    expect(ownerSnapshot()).toEqual(before);
    expect(db.getBookmarksForCategory(cooking.id).map((b) => b.postId).sort()).toEqual(['2', '4', '5']);
    expect(db.getBookmarksForCategory(llms.id).map((b) => b.postId)).toEqual(['3']);
    const names = db.getAllCategories().map((c) => c.name);
    expect(names.filter((n) => n.toLowerCase().startsWith('llm'))).toEqual(['LLMs']);
    expect(names.filter((n) => n === 'Cooking')).toHaveLength(1);
    const bread = db.getAllCategories().find((c) => c.name === 'Bread')!;
    expect(bread.parentId).toBe(cooking.id);
    expect(bread.origin).toBe('generated');
  });

  it('never creates past maxDepth when a path is re-anchored on a deep owner category', async () => {
    await runIngest({
      db,
      client: new FakeXClient([bm('1')]),
      taxonomer: new FakeTaxonomyDesigner(treeFromPaths([['A', 'B']])),
      categorizer: new FakeCategorizer({ '1': [['A', 'B']] }),
      batchSize: 10,
      maxDepth: 3,
    });
    const deep = db.createCategory('Deep', db.findCategory('B', db.findCategory('A', null)!.id)!.id, when)!;
    await runIngest({
      db,
      client: new FakeXClient([bm('2'), bm('1')]),
      taxonomer: new FakeTaxonomyDesigner([]),
      categorizer: new FakeCategorizer({ '2': [['Deep', 'Deeper', 'Deepest']] }),
      batchSize: 10,
      maxDepth: 3,
    });
    expect(db.getAllCategories().some((c) => c.name === 'Deeper')).toBe(false);
    expect(db.getBookmarksForCategory(deep.id).map((b) => b.postId)).toEqual(['2']);
  });

  it('recategorize keeps owner categories, their ancestors and their posts, and rebuilds the rest around them', async () => {
    await runIngest({
      db,
      client: new FakeXClient([bm('3'), bm('2'), bm('1')]),
      taxonomer: new FakeTaxonomyDesigner(treeFromPaths([['AI', 'Evals'], ['Everything']])),
      categorizer: new FakeCategorizer({ '1': [['AI', 'Evals']], '2': [['Everything']], '3': [['Everything']] }),
      batchSize: 10,
      maxDepth: 4,
    });
    const ai = db.findCategory('AI', null)!;
    const mine = db.createCategory('My evals', ai.id, when)!;
    const rust = db.createCategory('Rust', null, when)!;
    // A migrated category the owner has since claimed as theirs.
    const everything = db.findCategory('Everything', null)!;
    db.setCategoryOrigin(everything.id, 'user');
    db.addBookmarksToCategory(rust.id, [db.getBookmarkByPostId('3')!.id]);
    const before = ownerSnapshot();

    const taxonomer = new FakeTaxonomyDesigner(treeFromPaths([['AI', 'LLMs'], ['Rust', 'Async'], ['Game Dev']]));
    const categorizer = new FakeCategorizer({
      '1': [['AI', 'LLMs']],
      '2': [['Rust', 'Async']],
      // '3' is placed nowhere: it keeps its owner link and gets no Uncategorized.
    });
    await recategorizeAll({ db, taxonomer, categorizer, batchSize: 10, maxDepth: 4 });

    expect(ownerSnapshot()).toEqual(before);
    const tree = taxonomer.seenExistingTrees[0]!;
    expect(tree).toContain('- AI');
    expect(tree).toContain('  - My evals [owner]');
    expect(tree).toContain('- Rust [owner]');
    expect(tree).toContain('- Everything [owner]');
    expect(tree).not.toContain('Evals -'); // generated leaves are not anchors
    expect(tree).not.toMatch(/^\s*- Evals$/m);

    const names = db.getAllCategories().map((c) => c.name).sort();
    expect(names).toEqual(['AI', 'Async', 'Everything', 'Game Dev', 'LLMs', 'My evals', 'Rust']);
    // The ancestor that holds an owner category in place kept its id.
    expect(db.findCategory('AI', null)!.id).toBe(ai.id);
    expect(db.findCategory('Async', rust.id)).toBeDefined();
    expect(db.getBookmarksForCategory(rust.id).map((b) => b.postId).sort()).toEqual(['2', '3']);
    // "Everything" (now the owner's) keeps the posts it held.
    expect(db.getBookmarksForCategory(everything.id).map((b) => b.postId).sort()).toEqual(['2', '3']);
    expect(db.getAllCategories().some((c) => c.name === 'Uncategorized')).toBe(false);
    void mine;
  });

  it('recategorize never clears anything when the anchored design fails', async () => {
    const rust = db.createCategory('Rust', null, when)!;
    await runIngest({
      db,
      client: new FakeXClient([bm('1')]),
      taxonomer: new FakeTaxonomyDesigner(treeFromPaths([['AI']])),
      categorizer: new FakeCategorizer({ '1': [['AI']] }),
      batchSize: 10,
      maxDepth: 4,
    });
    const before = db.getAllCategories();
    const failing: TaxonomyDesigner = {
      designTaxonomy: async () => {
        throw new Error('model down');
      },
    };
    await expect(
      recategorizeAll({ db, taxonomer: failing, categorizer: new FakeCategorizer({}), batchSize: 10, maxDepth: 4 }),
    ).rejects.toThrow('model down');
    expect(db.getAllCategories()).toEqual(before);
    expect(db.getCategoryById(rust.id)!.origin).toBe('user');
  });
});
