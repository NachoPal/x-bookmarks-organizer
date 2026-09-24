import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { Database } from '../../db/database';
import { materializeTaxonomy } from '../tree';
import type { AssignMode, BatchCategorizer } from '../llm';
import type { Assignment, RawBookmark, TaxonomyNode } from '../../types';
import { buildBookmarkState, TypeSafeCategorizer } from './categorizer';
import type { LevelAsker } from './client';
import type { AskLevel, LevelAnswer } from './walk';

/**
 * The categorizer is exercised against a REAL (in-memory) database and a fake
 * asker: no SDK, no network, no key, no spend. What is being verified is that
 * it returns the same `Assignment[]` shape the LLM categorizer returns, so
 * `src/ingest.ts` cannot tell which one ran.
 */

const WHEN = '2024-01-01T00:00:00.000Z';

const TAXONOMY: TaxonomyNode[] = [
  {
    name: 'AI',
    description: 'Machine learning and tooling.',
    children: [
      {
        name: 'Harnesses',
        description: 'Agent harnesses.',
        children: [
          { name: 'MCP', description: 'Model Context Protocol.', children: [] },
          { name: 'Agents', description: 'Autonomous agents.', children: [] },
        ],
      },
      { name: 'Research', description: 'Papers.', children: [] },
    ],
  },
  { name: 'Cooking', description: 'Food and recipes.', children: [{ name: 'Baking', children: [] }] },
];

function bookmark(postId: string, overrides: Partial<RawBookmark> = {}): RawBookmark {
  return {
    postId,
    authorUsername: 'alice',
    authorName: 'Alice',
    text: `text for ${postId}`,
    url: `https://x.com/alice/status/${postId}`,
    postCreatedAt: WHEN,
    ...overrides,
  };
}

/**
 * A fake asker driven by a per-level answer function, recording its calls. The
 * bookmark's own state is passed through so a test can answer differently per
 * bookmark (which is what makes a mixed placeable/unplaceable batch testable).
 */
function fakeAsker(
  answerFor: (level: AskLevel, state: Record<string, unknown>) => LevelAnswer,
): LevelAsker & { calls: AskLevel[] } {
  const calls: AskLevel[] = [];
  return {
    calls,
    async ask(state, levels) {
      calls.push(...levels);
      return levels.map((level) => answerFor(level, state as Record<string, unknown>));
    },
  };
}

/** Answers confidently for whichever of `names` appears at each level. */
function confidentlyPick(names: string[]): (level: AskLevel) => LevelAnswer {
  return (level) => {
    const probabilities = new Map<number, number>();
    for (const option of level.options) {
      probabilities.set(option.id, names.includes(option.name) ? 0.95 : 0.02);
    }
    return { probabilities, confidence: 0.95 };
  };
}

/** Records what it was asked to categorize and answers with a fixed assignment. */
function recordingFallback(assignments: Assignment[] = []): BatchCategorizer & {
  seen: { bookmarks: RawBookmark[]; mode: AssignMode | undefined }[];
} {
  const seen: { bookmarks: RawBookmark[]; mode: AssignMode | undefined }[] = [];
  return {
    seen,
    async categorizeBatch(bookmarks, _treeText, mode) {
      seen.push({ bookmarks, mode });
      return assignments;
    },
  };
}

describe('buildBookmarkState', () => {
  it('names each part of the state rather than flattening it into a blob', () => {
    const state = buildBookmarkState(bookmark('1', { text: 'a  post\nabout   agents' })) as Record<
      string,
      unknown
    >;

    expect(state.author).toBe('@alice');
    expect(state.post_text).toBe('a post about agents');
    expect(state.linked_article).toBeUndefined();
  });

  it('includes the linked article context when the bookmark has one', () => {
    const context = new Map([['1', { title: 'Deep Dive', description: 'On agents.' }]]);

    const state = buildBookmarkState(bookmark('1'), context) as Record<string, unknown>;

    expect(state.linked_article).toBe('Deep Dive - On agents.');
  });
});

describe('TypeSafeCategorizer', () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(':memory:');
    materializeTaxonomy(db, TAXONOMY, 4, WHEN);
  });
  afterEach(() => {
    db.close();
  });

  it('returns an on-tree path built from real DB nodes', async () => {
    const asker = fakeAsker(confidentlyPick(['AI', 'Harnesses', 'MCP']));
    const categorizer = new TypeSafeCategorizer({ db, asker }, { maxDepth: 4 });

    const result = await categorizer.categorizeBatch([bookmark('1')], 'ignored tree text', 'strict');

    expect(result).toEqual([{ postId: '1', categories: [['AI', 'Harnesses', 'MCP']] }]);
  });

  it('produces paths that resolve against the real tree (never off-tree)', async () => {
    const asker = fakeAsker(confidentlyPick(['AI', 'Research']));
    const categorizer = new TypeSafeCategorizer({ db, asker }, { maxDepth: 4 });

    const [assignment] = await categorizer.categorizeBatch([bookmark('1')], '', 'strict');

    // Walk the returned names back down the DB exactly as ingest's resolver does.
    let parentId: number | null = null;
    for (const name of assignment!.categories[0]!) {
      const node = db.findCategory(name, parentId);
      expect(node).toBeDefined();
      parentId = node!.id;
    }
  });

  it('feeds each node description through as the Choice criteria', async () => {
    const asker = fakeAsker(confidentlyPick(['AI', 'Harnesses', 'MCP']));
    const categorizer = new TypeSafeCategorizer({ db, asker }, { maxDepth: 4 });

    await categorizer.categorizeBatch([bookmark('1')], '', 'strict');

    const rootLevel = asker.calls.find((l) => l.path.length === 0)!;
    const ai = rootLevel.options.find((o) => o.name === 'AI')!;
    expect(ai.description).toBe('Machine learning and tooling.');
  });

  it('files a bookmark under several branches when both are strong', async () => {
    const asker = fakeAsker(confidentlyPick(['AI', 'Harnesses', 'MCP', 'Cooking', 'Baking']));
    const categorizer = new TypeSafeCategorizer(
      { db, asker },
      { maxDepth: 4, beamWidth: 3, multiLabelThreshold: 0.6 },
    );

    const [assignment] = await categorizer.categorizeBatch([bookmark('1')], '', 'strict');

    const joined = assignment!.categories.map((p) => p.join(' > '));
    expect(joined).toContain('AI > Harnesses > MCP');
    expect(joined).toContain('Cooking > Baking');
  });

  it('files at the confident parent when the leaf choice is a coin flip', async () => {
    const asker = fakeAsker((level) => {
      const names = level.options.map((o) => o.name);
      if (names.includes('MCP')) {
        // Deepest level is a genuine toss-up.
        return {
          probabilities: new Map(level.options.map((o) => [o.id, 0.5] as const)),
          confidence: 0.2,
        };
      }
      return confidentlyPick(['AI', 'Harnesses'])(level);
    });
    const categorizer = new TypeSafeCategorizer({ db, asker }, { maxDepth: 4 });

    const [assignment] = await categorizer.categorizeBatch([bookmark('1')], '', 'strict');

    expect(assignment!.categories).toEqual([['AI', 'Harnesses']]);
  });

  it('omits a bookmark it cannot place in strict mode, so ingest files it Uncategorized', async () => {
    const asker = fakeAsker((level) => ({
      probabilities: new Map(level.options.map((o) => [o.id, 0.1] as const)),
      confidence: 0.05,
    }));
    const fallback = recordingFallback();
    const categorizer = new TypeSafeCategorizer({ db, asker, extendFallback: fallback }, { maxDepth: 4 });

    const result = await categorizer.categorizeBatch([bookmark('1')], '', 'strict');

    expect(result).toEqual([]);
    // The tree is fixed in strict mode, so the LLM is never asked to invent.
    expect(fallback.seen).toHaveLength(0);
  });

  it('routes ONLY the unplaceable bookmarks to the LLM in extend mode', async () => {
    // Bookmark 1 fits the tree; bookmark 2 fits nothing. Only 2 may reach the
    // LLM - that is the whole point of Jev being the high-precision filter.
    const asker = fakeAsker((level, state) => {
      if (String(state.post_text).includes('novel')) {
        return { probabilities: new Map(level.options.map((o) => [o.id, 0.1] as const)), confidence: 0.05 };
      }
      return confidentlyPick(['AI', 'Harnesses', 'MCP'])(level);
    });
    const fallback = recordingFallback([{ postId: '2', categories: [['Gardening']] }]);
    const categorizer = new TypeSafeCategorizer(
      { db, asker, extendFallback: fallback },
      { maxDepth: 4 },
    );

    const result = await categorizer.categorizeBatch(
      [bookmark('1'), bookmark('2', { text: 'a novel topic' })],
      '',
      'extend',
    );

    expect(fallback.seen).toHaveLength(1);
    expect(fallback.seen[0]!.bookmarks.map((b) => b.postId)).toEqual(['2']);
    expect(result).toContainEqual({ postId: '1', categories: [['AI', 'Harnesses', 'MCP']] });
    expect(result).toContainEqual({ postId: '2', categories: [['Gardening']] });
  });

  it('does not call the LLM at all when every bookmark fits the tree', async () => {
    const asker = fakeAsker(confidentlyPick(['AI', 'Research']));
    const fallback = recordingFallback();
    const categorizer = new TypeSafeCategorizer(
      { db, asker, extendFallback: fallback },
      { maxDepth: 4 },
    );

    const result = await categorizer.categorizeBatch([bookmark('1'), bookmark('2')], '', 'extend');

    expect(fallback.seen).toHaveLength(0);
    expect(result.map((a) => a.postId).sort()).toEqual(['1', '2']);
  });

  it('asks the LLM to invent a node for a bookmark that fits nothing (hybrid extend)', async () => {
    const asker = fakeAsker((level) => ({
      probabilities: new Map(level.options.map((o) => [o.id, 0.1] as const)),
      confidence: 0.05,
    }));
    const fallback = recordingFallback([{ postId: '1', categories: [['Gardening', 'Tomatoes']] }]);
    const categorizer = new TypeSafeCategorizer(
      { db, asker, extendFallback: fallback },
      { maxDepth: 4 },
    );

    const result = await categorizer.categorizeBatch([bookmark('1')], 'tree text', 'extend');

    expect(fallback.seen).toHaveLength(1);
    expect(fallback.seen[0]!.bookmarks.map((b) => b.postId)).toEqual(['1']);
    expect(fallback.seen[0]!.mode).toBe('extend');
    expect(result).toEqual([{ postId: '1', categories: [['Gardening', 'Tomatoes']] }]);
  });

  it('hands the whole batch to the LLM when the tree is empty and extending', async () => {
    const empty = new Database(':memory:');
    try {
      const asker = fakeAsker(confidentlyPick([]));
      const fallback = recordingFallback([{ postId: '1', categories: [['New']] }]);
      const categorizer = new TypeSafeCategorizer(
        { db: empty, asker, extendFallback: fallback },
        { maxDepth: 4 },
      );

      const result = await categorizer.categorizeBatch([bookmark('1')], '', 'extend');

      expect(fallback.seen[0]!.bookmarks).toHaveLength(1);
      expect(result).toEqual([{ postId: '1', categories: [['New']] }]);
      expect(asker.calls).toHaveLength(0);
    } finally {
      empty.close();
    }
  });

  it('never descends past maxDepth even when every level is confident', async () => {
    const asker = fakeAsker((level) => ({
      probabilities: new Map(level.options.map((o) => [o.id, 0.99] as const)),
      confidence: 0.99,
    }));
    const categorizer = new TypeSafeCategorizer({ db, asker }, { maxDepth: 2, beamWidth: 1 });

    const [assignment] = await categorizer.categorizeBatch([bookmark('1')], '', 'strict');

    for (const path of assignment!.categories) expect(path.length).toBeLessThanOrEqual(2);
  });

  it('returns an empty result for an empty batch without asking anything', async () => {
    const asker = fakeAsker(confidentlyPick(['AI']));
    const categorizer = new TypeSafeCategorizer({ db, asker }, { maxDepth: 4 });

    expect(await categorizer.categorizeBatch([], '', 'strict')).toEqual([]);
    expect(asker.calls).toHaveLength(0);
  });

  it('classifies every bookmark in a batch independently', async () => {
    const asker = fakeAsker(confidentlyPick(['AI', 'Research']));
    const categorizer = new TypeSafeCategorizer({ db, asker }, { maxDepth: 4, concurrency: 3 });

    const bookmarks = ['1', '2', '3', '4', '5'].map((id) => bookmark(id));
    const result = await categorizer.categorizeBatch(bookmarks, '', 'strict');

    expect(result.map((a) => a.postId).sort()).toEqual(['1', '2', '3', '4', '5']);
    for (const assignment of result) expect(assignment.categories).toEqual([['AI', 'Research']]);
  });
});

describe('owner categories on the Jev path', () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(':memory:');
    materializeTaxonomy(db, TAXONOMY, 4, WHEN);
  });
  afterEach(() => {
    db.close();
  });

  it('offers an owner category at its level like any other node, and files into it', async () => {
    const rust = db.createCategory('Rust', null, WHEN)!;
    const asker = fakeAsker(confidentlyPick(['Rust']));
    const categorizer = new TypeSafeCategorizer({ db, asker });
    const out = await categorizer.categorizeBatch([bookmark('1')], '(ignored)', 'strict');
    expect(asker.calls[0]!.options.map((o) => o.name)).toContain('Rust');
    expect(out).toEqual([{ postId: '1', categories: [['Rust']] }]);
    expect(db.getCategoryById(rust.id)!.origin).toBe('user');
  });
});
