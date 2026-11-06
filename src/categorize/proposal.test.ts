import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '../db/database';
import type { RawBookmark, TaxonomyNode } from '../types';
import { buildCategoryTree } from './tree';
import {
  applyDraft,
  diffDraft,
  editDraft,
  parseDraftTree,
  proposalFromAdditions,
  proposalFromDesign,
  readDraft,
  rebaseAdditions,
  viewDraft,
  writeDraft,
  type DraftNode,
  type RecategorizeDraft,
} from './proposal';
import { acceptProposal, generateProposal, readRefileState, refileRemaining } from './recategorize';
import type { BatchCategorizer } from './llm';
import type { TaxonomyDesigner } from './taxonomy';

const WHEN = '2026-11-01T00:00:00.000Z';
const bm = (postId: string, text = `t-${postId}`): RawBookmark => ({
  postId,
  authorUsername: 'a',
  authorName: 'A',
  text,
  url: `https://x.com/a/status/${postId}`,
  postCreatedAt: '',
});
const node = (name: string, children: TaxonomyNode[] = [], description?: string): TaxonomyNode => ({
  name,
  children,
  ...(description ? { description } : {}),
});
const noFetch = { fetch: async () => ({ status: 'failed' as const, reason: 'offline' }) };

/** Names of a draft/tree as nested arrays, for readable assertions. */
function shape(nodes: { name: string; children: unknown[] }[]): unknown[] {
  return nodes.map((n) =>
    n.children.length ? [n.name, shape(n.children as { name: string; children: unknown[] }[])] : n.name,
  );
}

function draftOf(db: Database, mode: 'redesign' | 'extend', tree: DraftNode[]): RecategorizeDraft {
  return { version: 1, mode, createdAt: WHEN, updatedAt: WHEN, bookmarkCount: db.getBookmarkCount(), tree };
}

/** A filer that files each post under the path in its text after "->", e.g. "x ->AI/Agents". */
const pathFiler: BatchCategorizer = {
  async categorizeBatch(batch) {
    return batch.map((b) => {
      const m = /->(\S+)/.exec(b.text);
      return { postId: b.postId, categories: m ? [m[1]!.split('/')] : [] };
    });
  },
};

describe('proposal tree building', () => {
  let db: Database;
  let ai: number;
  let agents: number;
  let rust: number;

  beforeEach(() => {
    db = new Database(':memory:');
    ai = db.getOrCreateCategory('AI', null, WHEN).id;
    agents = db.getOrCreateCategory('Agents', ai, WHEN, 'Autonomous agents').id;
    rust = db.createCategory('Rust', null, WHEN)!.id;
  });
  afterEach(() => db.close());

  it('matches a redesign to the current categories by name, where they were or where they moved', () => {
    const designed = [
      node('Programming', [node('rust'), node('Tooling')]),
      node('Artificial Intelligence', [node('Agents')]),
    ];
    const tree = proposalFromDesign(designed, buildCategoryTree(db), 4);
    expect(shape(tree)).toEqual([
      ['Programming', ['rust', 'Tooling']],
      ['Artificial Intelligence', ['Agents']],
    ]);
    const [prog, ai2] = tree;
    expect(prog!.sourceId).toBeUndefined();
    expect(prog!.children[0]!.sourceId).toBe(rust); // moved under a new parent
    expect(ai2!.sourceId).toBeUndefined(); // "AI" was renamed: not a name match
    expect(ai2!.children[0]!.sourceId).toBe(agents);
    expect(ai2!.children[0]!.description).toBe('Autonomous agents'); // kept when the model gave none
  });

  it('caps a redesign at the depth limit and drops duplicate siblings', () => {
    const designed = [node('A', [node('B', [node('C')])]), node('a')];
    expect(shape(proposalFromDesign(designed, [], 2))).toEqual([['A', ['B']]]);
  });

  it('merges additions into the locked current tree', () => {
    const additions = [node('AI', [node('Evals', [], 'Benchmarks')]), node('Cooking'), node('rust', [node('Async')])];
    const tree = proposalFromAdditions(additions, buildCategoryTree(db), 4);
    expect(shape(tree)).toEqual([['AI', ['Agents', 'Evals']], ['Rust', ['Async']], 'Cooking']);
    expect(tree[0]!.sourceId).toBe(ai);
    expect(tree[0]!.children[1]!.sourceId).toBeUndefined();
    expect(tree[0]!.children[1]!.description).toBe('Benchmarks');
  });

  it('diffs a draft against the live tree, listing removed subtrees once', () => {
    const live = buildCategoryTree(db);
    const draft = draftOf(db, 'redesign', [
      { id: 1, name: 'Rust lang', sourceId: rust, children: [{ id: 2, name: 'Agents', sourceId: agents, children: [] }] },
      { id: 3, name: 'New', children: [] },
    ]);
    expect(diffDraft(draft, live)).toEqual({ added: 1, removed: 1, renamed: 1, moved: 1, removedPaths: [['AI']] });
    const view = viewDraft(draft, live);
    expect(view[0]!.change).toEqual({ renamedFrom: 'Rust' });
    expect(view[0]!.children[0]!.change).toEqual({ movedFrom: ['AI', 'Agents'] });
    expect(view[1]!.change).toEqual({ added: true });
    expect(view[0]!.origin).toBe('user'); // kept from an owner category
    expect(view[0]!.children[0]!.origin).toBe('generated');
  });

  it('refuses an edited tree with an empty name, a sibling clash or too much depth', () => {
    const ids = new Set<number>();
    const parsed = parseDraftTree(
      [
        { id: 1, name: ' ', children: [] },
        { id: 2, name: 'X', children: [{ id: 3, name: 'Y', children: [] }, { id: 4, name: 'y', children: [] }] },
        { id: 5, name: 'Deep', children: [{ id: 6, name: 'D2', children: [{ id: 7, name: 'D3', children: [] }] }] },
      ],
      ids,
      2,
    );
    expect(parsed.errors).toEqual([
      'A top-level category has no name.',
      '“X” has two categories called “y”.',
      '“D3” is nested too deep; categories go at most 2 levels deep.',
    ]);
  });

  it('gives duplicate ids fresh ones and drops unknown or repeated sources', () => {
    const parsed = parseDraftTree(
      [
        { id: 1, name: 'A', sourceId: ai, children: [] },
        { id: 1, name: 'B', sourceId: ai, children: [] },
        { id: 2, name: 'C', sourceId: 999, children: [] },
      ],
      new Set([ai]),
      4,
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.tree.map((n) => [n.id, n.sourceId])).toEqual([
      [1, ai],
      [3, undefined],
      [2, undefined],
    ]);
  });

  it('re-bases an extend edit: existing categories cannot be renamed, moved or removed', () => {
    const live = buildCategoryTree(db);
    const client: DraftNode[] = [
      // Renamed AI, dropped Agents, moved Rust inside it, added Evals under it.
      { id: ai, name: 'Renamed', sourceId: ai, children: [{ id: rust, name: 'Rust', sourceId: rust, children: [] }, { id: 50, name: 'Evals', edited: true, children: [] }] },
      { id: 51, name: 'Cooking', children: [] },
    ];
    const tree = rebaseAdditions(client, live);
    expect(shape(tree)).toEqual([['AI', ['Agents', 'Evals']], 'Rust', 'Cooking']);
    expect(tree[0]!.children[1]).toMatchObject({ id: 50, edited: true });
  });
});

describe('accepting a proposal', () => {
  let db: Database;
  let ai: number;
  let agents: number;
  let rust: number;

  beforeEach(() => {
    db = new Database(':memory:');
    ai = db.getOrCreateCategory('AI', null, WHEN).id;
    agents = db.getOrCreateCategory('Agents', ai, WHEN).id;
    rust = db.createCategory('Rust', null, WHEN)!.id;
    db.storeCategorizedBatch([bm('1', 'agents ->AI/Agents')], () => [agents], WHEN);
    db.storeCategorizedBatch([bm('2', 'rust')], () => [rust], WHEN);
    db.storeCategorizedBatch([bm('3', 'misc')], () => [ai], WHEN);
    const one = db.getBookmarkByPostId('1')!;
    db.markRead(one.id, WHEN);
    db.setFavorite(one.id, true);
  });
  afterEach(() => db.close());

  it('replaces the whole tree for a redesign, keeping matched rows and applying the origin rules', () => {
    const draft = draftOf(db, 'redesign', [
      { id: 1, name: 'Programming', children: [{ id: 2, name: 'Rustlang', sourceId: rust, edited: true, children: [] }] },
      { id: 3, name: 'Machine Learning', edited: true, children: [{ id: 4, name: 'Agents', sourceId: agents, children: [] }] },
    ]);
    const result = applyDraft(db, draft, WHEN);
    expect(result).toEqual({ created: 2, deleted: 1 });
    const tree = buildCategoryTree(db);
    expect(shape(tree)).toEqual([['Programming', ['Rustlang']], ['Machine Learning', ['Agents']]]);
    expect(tree[0]!.origin).toBe('generated');
    expect(tree[0]!.children[0]).toMatchObject({ id: rust, origin: 'user' });
    expect(tree[1]!.origin).toBe('user'); // created in the review
    expect(tree[1]!.children[0]).toMatchObject({ id: agents, origin: 'generated' });
    // A kept row keeps its posts until the re-file; the deleted AI's link went with it.
    expect(db.getCategoryIdsForBookmarks([db.getBookmarkByPostId('1')!.id]).get(db.getBookmarkByPostId('1')!.id)).toEqual([agents]);
    expect(db.getCategoryById(ai)).toBeUndefined();
  });

  it('can rename an owner category to a name another kept row carried (no constraint trips)', () => {
    const draft = draftOf(db, 'redesign', [
      { id: 1, name: 'AI', sourceId: rust, children: [] },
      { id: 2, name: 'Rust', sourceId: ai, children: [{ id: 3, name: 'Agents', sourceId: agents, children: [] }] },
    ]);
    applyDraft(db, draft, WHEN);
    expect(shape(buildCategoryTree(db))).toEqual(['AI', ['Rust', ['Agents']]]);
    expect(db.getCategoryById(rust)!.name).toBe('AI');
  });

  it('only adds for an extend, never touching an existing row', () => {
    const before = db.getAllCategories();
    const draft = draftOf(db, 'extend', proposalFromAdditions([node('AI', [node('Evals')]), node('Cooking')], buildCategoryTree(db), 4));
    expect(applyDraft(db, draft, WHEN)).toEqual({ created: 2, deleted: 0 });
    const after = db.getAllCategories();
    for (const c of before) expect(after.find((a) => a.id === c.id)).toEqual(c);
    expect(shape(buildCategoryTree(db))).toEqual([['AI', ['Agents', 'Evals']], 'Cooking', 'Rust']);
  });

  it('accepts end to end: writes the tree, re-files every post from scratch, keeps bookmark state', async () => {
    const draft = draftOf(db, 'redesign', [
      { id: 1, name: 'AI', sourceId: ai, children: [{ id: 2, name: 'Agents', sourceId: agents, children: [] }, { id: 3, name: 'Evals', children: [] }] },
    ]);
    writeDraft(db, draft);
    const summary = await acceptProposal({ db, categorizer: pathFiler, batchSize: 2, maxDepth: 4, articleFetcher: noFetch });
    expect(summary).toMatchObject({ kind: 'apply', mode: 'redesign', refiled: 3, total: 3 });
    expect(readDraft(db, 4)).toBeUndefined();
    expect(readRefileState(db)).toBeUndefined();
    const ids = db.getCategoryIdsForBookmarks(db.getAllBookmarks().map((b) => b.id));
    const one = db.getBookmarkByPostId('1')!;
    expect(ids.get(one.id)).toEqual([agents]);
    const uncategorized = db.findCategory('Uncategorized', null)!;
    expect(ids.get(db.getBookmarkByPostId('2')!.id)).toEqual([uncategorized.id]);
    expect(one.read).toBe(true);
    expect(one.favorite).toBe(true);
  });

  it('leaves the old tree and links intact when the accept fails before the tree is written', async () => {
    const draft = draftOf(db, 'redesign', [{ id: 1, name: 'AI', sourceId: ai, children: [{ id: 2, name: 'agents', children: [] }, { id: 3, name: 'Agents', children: [] }] }]);
    writeDraft(db, draft);
    const before = JSON.stringify([db.getAllCategories(), [...db.getDirectMembership()]]);
    await expect(acceptProposal({ db, categorizer: pathFiler, batchSize: 2, maxDepth: 4, articleFetcher: noFetch })).rejects.toThrow(
      /two categories called/,
    );
    expect(JSON.stringify([db.getAllCategories(), [...db.getDirectMembership()]])).toBe(before);
    expect(readDraft(db, 4)).toBeDefined();
  });

  it('reports partial progress when a re-file batch fails, and a retry finishes the rest', async () => {
    writeDraft(db, draftOf(db, 'extend', proposalFromAdditions([], buildCategoryTree(db), 4)));
    let calls = 0;
    const flaky: BatchCategorizer = {
      async categorizeBatch(batch, tree, ctx) {
        calls += 1;
        if (calls === 2) throw new Error('model overloaded.');
        return pathFiler.categorizeBatch(batch, tree, ctx);
      },
    };
    await expect(acceptProposal({ db, categorizer: flaky, batchSize: 2, maxDepth: 4, articleFetcher: noFetch })).rejects.toThrow(
      'Re-filed 2 of 3 posts, then the filing pass failed: model overloaded. The new tree is in place; press Try again to re-file the remaining 1.',
    );
    expect(readRefileState(db)!.remaining).toHaveLength(1);
    const summary = await refileRemaining({ db, categorizer: pathFiler, batchSize: 2, maxDepth: 4, articleFetcher: noFetch });
    expect(summary).toMatchObject({ refiled: 1, total: 3 });
    expect(readRefileState(db)).toBeUndefined();
  });
});

describe('generating a proposal', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    const ai = db.getOrCreateCategory('AI', null, WHEN).id;
    db.createCategory('Rust', null, WHEN);
    db.storeCategorizedBatch([bm('1', 'gpt evals'), bm('2', 'rust async')], () => [ai], WHEN);
  });
  afterEach(() => db.close());

  function snapshot(): string {
    return JSON.stringify([db.getAllCategories(), [...db.getDirectMembership()], db.getAllBookmarks()]);
  }

  it('designs a redesign over every bookmark with the current tree as context, changing no data', async () => {
    const seen: { mode?: string; tree: string; count: number }[] = [];
    const taxonomer: TaxonomyDesigner = {
      async designTaxonomy(bookmarks, tree, _ctx, mode) {
        seen.push({ mode, tree, count: bookmarks.length });
        return [node('Tech', [node('AI'), node('Rust')])];
      },
    };
    const before = snapshot();
    const summary = await generateProposal({ db, taxonomer, maxDepth: 4, articleFetcher: noFetch }, 'redesign');
    expect(seen).toEqual([{ mode: 'redesign', tree: expect.stringContaining('Rust [owner]'), count: 2 }]);
    expect(summary).toMatchObject({ kind: 'proposal', mode: 'redesign', bookmarks: 2, added: 1, moved: 2, removed: 0 });
    expect(snapshot()).toBe(before);
    expect(shape(readDraft(db, 4)!.tree)).toEqual([['Tech', ['AI', 'Rust']]]);
  });

  it('runs the incremental pass over every bookmark for an extend', async () => {
    const taxonomer: TaxonomyDesigner = {
      async designTaxonomy(bookmarks, _tree, _ctx, mode) {
        expect(mode).toBe('incremental');
        expect(bookmarks).toHaveLength(2);
        return [node('AI', [node('Evals')])];
      },
    };
    const before = snapshot();
    const summary = await generateProposal({ db, taxonomer, maxDepth: 4, articleFetcher: noFetch }, 'extend');
    expect(summary).toMatchObject({ added: 1, removed: 0, renamed: 0, moved: 0 });
    expect(snapshot()).toBe(before);
  });

  it('refuses an empty library and an empty redesign without writing a draft', async () => {
    const empty: TaxonomyDesigner = { designTaxonomy: async () => [] };
    await expect(generateProposal({ db, taxonomer: empty, maxDepth: 4, articleFetcher: noFetch }, 'redesign')).rejects.toThrow(/empty tree/);
    expect(readDraft(db, 4)).toBeUndefined();
    const fresh = new Database(':memory:');
    await expect(generateProposal({ db: fresh, taxonomer: empty, maxDepth: 4, articleFetcher: noFetch }, 'extend')).rejects.toThrow(/Sync first/);
    fresh.close();
  });

  it('edits a stored draft and refuses an edit that breaks the rules', () => {
    writeDraft(db, draftOf(db, 'redesign', [{ id: 1, name: 'A', children: [] }]));
    const draft = readDraft(db, 4)!;
    expect(editDraft(db, draft, [], 4).errors[0]).toMatch(/at least one category/);
    const ok = editDraft(db, draft, [{ id: 1, name: 'B', edited: true, children: [{ id: 2, name: 'C', children: [] }] }], 4);
    expect(ok.errors).toEqual([]);
    expect(shape(ok.draft!.tree)).toEqual([['B', ['C']]]);
  });
});
