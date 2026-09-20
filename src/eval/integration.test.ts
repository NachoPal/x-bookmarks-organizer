import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Categorizer } from '../categorize/llm';
import { LlmTaxonomyDesigner } from '../categorize/taxonomy';
import { TypeSafeLevelAsker } from '../categorize/typesafe/client';
import type { ArticleExtractionResult, ArticleFetcher } from '../articles/fetch-article';
import { Database } from '../db/database';
import type { RawBookmark } from '../types';
import { meteringFetch, newJevUsage } from './jev';
import { planCategorizerEval, runCategorizerEval, type EvalOptions } from './run';

/**
 * End to end through the REAL eval, the REAL Jev SDK, a REAL HTTP server
 * standing in for the TypeSafe API, and a fake `LlmRunner` for the Claude half
 * - the same "spin up a local server rather than mock fetch" discipline as
 * `src/categorize/typesafe/integration.test.ts` and `src/rank/integration.test.ts`.
 * No network leaves the machine, no API key is real, and nothing is billable.
 *
 * The load-bearing assertion is the one about the live database: the eval's
 * whole premise is that it can be run against the owner's real library without
 * changing a byte of it.
 */

const WHEN = '2024-01-01T00:00:00.000Z';

const TAXONOMY = JSON.stringify({
  tree: [
    {
      name: 'AI',
      description: 'Models, agents and tooling.',
      children: [
        { name: 'Harnesses', description: 'Agent harnesses and CLIs.', children: [] },
        { name: 'Research', description: 'Papers and preprints.', children: [] },
      ],
    },
    { name: 'Cooking', description: 'Food and recipes.', children: [] },
  ],
});

function bookmark(postId: string, text: string): RawBookmark {
  return {
    postId,
    authorUsername: 'alice',
    authorName: 'Alice',
    text,
    url: `https://x.com/alice/status/${postId}`,
    postCreatedAt: WHEN,
  };
}

/**
 * Never reaches the network, and records what it was asked for - so a test can
 * prove the eval really did walk the resolve-or-fetch path, and THEN prove
 * nothing was cached back into the live library as a result.
 */
function countingFetcher(): ArticleFetcher & { urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    fetch: async (url: string): Promise<ArticleExtractionResult> => {
      urls.push(url);
      return { status: 'failed', reason: 'not fetched in tests', resolvedUrl: null, preview: null };
    },
  };
}

/**
 * A stand-in TypeSafe API driven by `pick`: for every `Choice` question it puts
 * all the probability on the label `pick` names, so a test can steer Jev's
 * filing while still exercising the real SDK's request/response handling.
 */
async function startStubTypeSafe(
  pick: (labels: string[], state: { post_text: string }) => { label: string; confidence: number },
): Promise<{ baseUrl: string; requests: number; close: () => Promise<void> }> {
  const state = { requests: 0 };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      state.requests++;
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const answers: Record<string, unknown> = {};
      for (const [key, question] of Object.entries(
        body.questions as Record<string, { criteria: Record<string, unknown> }>,
      )) {
        const labels = Object.keys(question.criteria);
        const { label, confidence } = pick(labels, body.state);
        const probabilities: Record<string, number> = {};
        for (const l of labels) probabilities[l] = l === label ? 0.95 : 0.05;
        answers[key] = { type: 'choice', choice: label, confidence, probabilities, legend: {} };
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 7, output_tokens: 0 } }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    get requests() {
      return state.requests;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Every table the eval must leave untouched, as a comparable snapshot. */
function snapshot(db: Database): string {
  return JSON.stringify({
    bookmarks: db.getAllBookmarks(),
    categories: db.getAllCategories(),
    membership: [...db.getDirectMembership()],
    summarized: [...db.getSummarizedBookmarkIds(db.getAllBookmarks().map((b) => b.id))],
    scored: db.countScoredBookmarks(),
    scores: [...db.getBookmarkScores(db.getAllBookmarks().map((b) => b.id))],
    linkMetadata: db.getArticleLinkMetadata('https://example.com/post'),
    lastSynced: db.getLastSyncedAt(),
  });
}

function options(overrides: Partial<EvalOptions> = {}): EvalOptions {
  return {
    batchSize: 10,
    maxDepth: 4,
    walk: {
      beamWidth: 2,
      maxDepth: 4,
      confidenceThreshold: 0.55,
      multiLabelThreshold: 0.6,
      maxLabels: 2,
      concurrency: 4,
    },
    models: {
      taxonomyProvider: 'claude-cli',
      taxonomyModel: 'claude-opus-5',
      taxonomyEffort: 'high',
      claudeProvider: 'claude-cli',
      claudeModel: 'claude-haiku-4-5',
      jevModel: 'jev-latest',
    },
    ...overrides,
  };
}

describe('eval-categorizers end to end, over HTTP', () => {
  let db: Database;
  let stub: Awaited<ReturnType<typeof startStubTypeSafe>>;

  beforeEach(async () => {
    db = new Database(':memory:');
    // A pre-existing library with its own taxonomy and its own state, so the
    // eval has something real to leave alone.
    const live = db.getOrCreateCategory('Existing', null, WHEN).id;
    db.storeCategorizedBatch(
      [
        bookmark('1', 'the best agent harness CLI I have used'),
        bookmark('2', 'a new paper on scaling laws'),
        bookmark('3', 'my sourdough starter finally took https://example.com/post'),
      ],
      () => [live],
      WHEN,
    );
    db.markRead(db.getBookmarkByPostId('1')!.id);
    db.setFavorite(db.getBookmarkByPostId('2')!.id, true);
    db.saveSummary({
      bookmarkId: db.getBookmarkByPostId('1')!.id,
      summary: 'a summary that must survive',
      generatedAt: WHEN,
      model: 'test',
    });

    stub = await startStubTypeSafe((labels, state) => {
      // Jev files the cooking post under Cooking; everything else goes down the
      // AI branch, and at the second level it always picks Research - so it
      // agrees with Claude on the paper and disagrees on the harness post.
      if (labels.includes('Cooking') && state.post_text.includes('sourdough')) {
        return { label: 'Cooking', confidence: 0.95 };
      }
      if (labels.includes('Research')) return { label: 'Research', confidence: 0.9 };
      return { label: labels.includes('AI') ? 'AI' : labels[0]!, confidence: 0.9 };
    });
  });

  afterEach(async () => {
    db.close();
    await stub.close();
  });

  /** The Claude half: taxonomy first, then one assignment response per batch. */
  function claudeRunner(assignments: Record<string, string[][]>) {
    return async (prompt: string): Promise<string> => {
      if (prompt.includes('taxonomy') || prompt.includes('Design')) return TAXONOMY;
      return JSON.stringify({
        assignments: Object.entries(assignments).map(([post_id, categories]) => ({ post_id, categories })),
      });
    };
  }

  async function run(assignments: Record<string, string[][]>, overrides: Partial<EvalOptions> = {}) {
    const usage = newJevUsage();
    const runner = claudeRunner(assignments);
    const fetcher = countingFetcher();
    return {
      usage,
      fetcher,
      result: await runCategorizerEval(
        {
          db,
          taxonomer: new LlmTaxonomyDesigner(runner, { minDepth: 2, maxDepth: 4 }),
          claude: new Categorizer(runner, { model: 'test-model', maxDepth: 4 }),
          asker: new TypeSafeLevelAsker({
            apiKey: 'test-key-not-real',
            baseURL: stub.baseUrl,
            fetch: meteringFetch(globalThis.fetch.bind(globalThis), usage),
          }),
          usage,
          articleFetcher: fetcher,
          now: () => new Date('2024-05-01T12:00:00.000Z'),
        },
        options(overrides),
      ),
    };
  }

  it('leaves the live library byte-identical - no category, bookmark, summary or score row', async () => {
    const before = snapshot(db);

    await run({
      '1': [['AI', 'Harnesses']],
      '2': [['AI', 'Research']],
      '3': [['Cooking']],
    });

    expect(snapshot(db)).toBe(before);
    // The live taxonomy in particular was neither cleared nor extended with the
    // eval's fresh tree - which is what `recategorize` would have done.
    expect(db.getAllCategories().map((c) => c.name)).toEqual(['Existing']);
  });

  it('resolves a post\u2019s link for context but caches nothing back into the live library', async () => {
    const { fetcher } = await run({ '1': [['AI', 'Harnesses']] });

    // It really did go down the fetch-or-cache path...
    expect(fetcher.urls).toEqual(['https://example.com/post']);
    // ...and the row a normal `run` would have written is not there. Byte-identical
    // means byte-identical, even for a pure cache.
    expect(db.getArticleLinkMetadata('https://example.com/post')).toBeUndefined();
  });

  it('scores agreement on the one fixed tree both methods were handed', async () => {
    const { result } = await run({
      // Claude agrees with the stub on 2 and 3, disagrees on 1 (Harnesses vs Research).
      '1': [['AI', 'Harnesses']],
      '2': [['AI', 'Research']],
      '3': [['Cooking']],
    });

    const { agreement } = result.comparison;
    expect(agreement.bookmarks).toBe(3);
    expect(agreement.bothPlaced).toBe(3);
    expect(agreement.samePrimaryLeaf).toBe(2);
    expect(agreement.samePrimaryRoot).toBe(3);
    expect(result.comparison.disagreements.total).toBe(1);
    expect(result.comparison.disagreements.rows[0]).toMatchObject({
      claudePath: 'AI > Harnesses',
      jevPath: 'AI > Research',
    });
  });

  it('treats a path Claude invented off the fixed tree as Uncategorized, exactly as a strict run does', async () => {
    const { result } = await run({
      '1': [['Quantum Computing', 'Error Correction']],
      '2': [['AI', 'Research']],
      '3': [['Cooking']],
    });

    expect(result.comparison.distribution.claudeUnplaced).toBe(1);
    expect(result.comparison.disagreements.rows.some((r) => r.claudePath === '(Uncategorized)')).toBe(true);
  });

  it('reports the tree it designed and the token spend the API reported', async () => {
    const { result, usage } = await run({ '1': [['AI', 'Harnesses']], '2': [['AI', 'Research']], '3': [['Cooking']] });

    expect(result.report.meta.treeNodes).toBe(4); // AI, Harnesses, Research, Cooking
    expect(result.report.meta.treeRoots).toBe(2);
    expect(usage.requests).toBeGreaterThan(0);
    expect(result.report.cost.jevInputTokens).toBe(usage.requests * 7);
    expect(result.markdown).toContain('# Categorizer comparison');
  });

  it('honors --limit as a cost ceiling, and says so in the report', async () => {
    const { result } = await run({ '3': [['Cooking']] }, { limit: 1 });

    expect(result.report.meta.bookmarks).toBe(1);
    expect(result.report.meta.libraryBookmarks).toBe(3);
    expect(result.markdown).toContain('1 of 3 in the library');
  });

  it('leaves no throwaway database behind', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const before = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('xbo-eval-')).length;

    await run({ '1': [['AI', 'Harnesses']] });

    expect(fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('xbo-eval-')).length).toBe(before);
  });
});

describe('planCategorizerEval (--dry-run)', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    const category = db.getOrCreateCategory('Existing', null, WHEN).id;
    db.storeCategorizedBatch(
      [bookmark('1', 'a post about agent harnesses'), bookmark('2', 'a post about bread')],
      () => [category],
      WHEN,
    );
  });

  afterEach(() => db.close());

  it('sizes the run and bounds the Jev request count, making NO call of any kind', () => {
    // The function takes no asker and no taxonomy designer at all, so there is
    // structurally nothing here that could spend money or subscription quota.
    const plan = planCategorizerEval(db, { maxDepth: 4 });

    expect(plan.bookmarks).toBe(2);
    expect(plan.libraryBookmarks).toBe(2);
    expect(plan.liveTreeNodes).toBe(1);
    expect(plan.jevRequestsUpperBound).toBe(8); // 2 bookmarks x depth 4
    expect(plan.estimatedJevInputTokens).toBeGreaterThan(0);
  });

  it('honors --limit and reports the whole library alongside it', () => {
    const plan = planCategorizerEval(db, { maxDepth: 4, limit: 1 });

    expect(plan.bookmarks).toBe(1);
    expect(plan.libraryBookmarks).toBe(2);
    expect(plan.jevRequestsUpperBound).toBe(4);
  });

  it('writes nothing to the library', () => {
    const before = snapshot(db);

    planCategorizerEval(db, { maxDepth: 4 });

    expect(snapshot(db)).toBe(before);
  });
});
