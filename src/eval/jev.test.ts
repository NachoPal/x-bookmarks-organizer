import { describe, expect, it } from 'vitest';
import type { Fetch } from '@typesafe-ai/sdk';
import type { LevelAsker } from '../categorize/typesafe/client';
import type { AskLevel, LevelAnswer } from '../categorize/typesafe/walk';
import type { CategoryTreeNode, RawBookmark } from '../types';
import { fileWithJev, meteringFetch, newJevUsage, type FileWithJevOptions } from './jev';

/**
 * Offline throughout: the walk is driven by a plain fake `LevelAsker`, and the
 * metering transport is driven by a fake `Fetch`. No network, no API key, no
 * spend - the same discipline as `walk.test.ts` and `client.test.ts`.
 */

const WHEN = '2024-01-01T00:00:00.000Z';

function node(id: number, name: string, children: CategoryTreeNode[] = []): CategoryTreeNode {
  return {
    id,
    parentId: null,
    name,
    description: null,
    path: [name],
    total: 0,
    unread: 0,
    directTotal: 0,
    children,
  };
}

/** AI > {Harnesses, Research}, Cooking. Parent/path wiring done by hand. */
function tree(): CategoryTreeNode[] {
  const harnesses = { ...node(10, 'Harnesses'), parentId: 1, path: ['AI', 'Harnesses'] };
  const research = { ...node(11, 'Research'), parentId: 1, path: ['AI', 'Research'] };
  return [node(1, 'AI', [harnesses, research]), node(2, 'Cooking')];
}

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

const OPTIONS: FileWithJevOptions = {
  beamWidth: 2,
  maxDepth: 3,
  confidenceThreshold: 0.55,
  multiLabelThreshold: 0.6,
  maxLabels: 2,
  concurrency: 2,
};

/** An asker that picks `winner` at every level with the given confidence. */
function asker(pick: (level: AskLevel) => { id: number; p: number; confidence: number }): LevelAsker {
  return {
    ask: async (_state, levels): Promise<LevelAnswer[]> =>
      levels.map((level) => {
        const { id, p, confidence } = pick(level);
        return { probabilities: new Map([[id, p]]), confidence };
      }),
  };
}

describe('fileWithJev', () => {
  it('returns each bookmark’s path as real tree node ids and the tree’s own names', async () => {
    const filings = await fileWithJev(
      [bookmark('1', 'agent harnesses')],
      tree(),
      asker((level) => ({ id: level.path.length === 0 ? 1 : 10, p: 0.95, confidence: 0.95 })),
      OPTIONS,
    );

    expect(filings[0]!.paths[0]!.nodeIds).toEqual([1, 10]);
    expect(filings[0]!.paths[0]!.names).toEqual(['AI', 'Harnesses']);
    expect(filings[0]!.earlyStopped).toBe(false);
    expect(filings[0]!.unresolved).toBe(false);
  });

  it('keeps the confidence the walk reported - the thing `Assignment[]` throws away', async () => {
    // A low-confidence level stops the descent at the confident ancestor, and
    // the eval has to be able to SEE that, which is the whole reason this does
    // not go through `TypeSafeCategorizer`.
    const filings = await fileWithJev(
      [bookmark('1', 'something vaguely about AI')],
      tree(),
      asker((level) =>
        level.path.length === 0
          ? { id: 1, p: 0.9, confidence: 0.9 }
          : { id: 10, p: 0.4, confidence: 0.3 },
      ),
      OPTIONS,
    );

    expect(filings[0]!.paths[0]!.names).toEqual(['AI']);
    expect(filings[0]!.paths[0]!.confident).toBe(false);
    expect(filings[0]!.earlyStopped).toBe(true);
    expect(filings[0]!.paths[0]!.score).toBeGreaterThan(0);
  });

  it('reports a bookmark it could not place at all as unresolved, with no paths', async () => {
    const filings = await fileWithJev(
      [bookmark('1', 'gm')],
      tree(),
      asker(() => ({ id: 1, p: 0.1, confidence: 0.1 })),
      OPTIONS,
    );

    expect(filings[0]!.paths).toEqual([]);
    expect(filings[0]!.unresolved).toBe(true);
  });

  it('keeps going when one bookmark’s walk throws, and says which one failed', async () => {
    const failing: LevelAsker = {
      ask: async (state, levels) => {
        if (JSON.stringify(state).includes('boom')) throw new Error('TypeSafe request failed: nope');
        return levels.map(() => ({ probabilities: new Map([[1, 0.9]]), confidence: 0.9 }));
      },
    };

    const filings = await fileWithJev(
      [bookmark('1', 'boom'), bookmark('2', 'fine')],
      tree(),
      failing,
      OPTIONS,
    );

    expect(filings[0]!.error).toContain('TypeSafe request failed');
    expect(filings[0]!.unresolved).toBe(true);
    expect(filings[1]!.paths.length).toBeGreaterThan(0);
  });

  it('returns one unresolved filing per bookmark when the tree is empty, without asking anything', async () => {
    let asked = 0;
    const counting: LevelAsker = {
      ask: async (_s, levels) => {
        asked++;
        return levels.map(() => ({ probabilities: new Map(), confidence: 0 }));
      },
    };

    const filings = await fileWithJev([bookmark('1', 'x')], [], counting, OPTIONS);

    expect(asked).toBe(0);
    expect(filings).toHaveLength(1);
    expect(filings[0]!.unresolved).toBe(true);
  });

  it('preserves input order even though bookmarks are walked concurrently', async () => {
    const bookmarks = Array.from({ length: 6 }, (_, i) => bookmark(String(i), `post ${i}`));

    const filings = await fileWithJev(
      bookmarks,
      tree(),
      asker(() => ({ id: 2, p: 0.9, confidence: 0.9 })),
      OPTIONS,
    );

    expect(filings.map((f) => f.postId)).toEqual(['0', '1', '2', '3', '4', '5']);
  });
});

describe('meteringFetch', () => {
  function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  it('sums the input tokens the API reports and counts every request', async () => {
    const usage = newJevUsage();
    const inner: Fetch = async () =>
      jsonResponse({ model: 'jev-1', answers: {}, usage: { input_tokens: 12, output_tokens: 0 } });
    const metered = meteringFetch(inner, usage);

    await metered('https://api.example/one', {});
    await metered('https://api.example/one', {});

    expect(usage).toEqual({ requests: 2, inputTokens: 24 });
  });

  it('leaves the response body intact for the SDK to read', async () => {
    const usage = newJevUsage();
    const metered = meteringFetch(async () => jsonResponse({ usage: { input_tokens: 5 }, ok: true }), usage);

    const response = await metered('https://api.example/one', {});

    expect(await response.json()).toEqual({ usage: { input_tokens: 5 }, ok: true });
    expect(usage.inputTokens).toBe(5);
  });

  it('counts a request whose body reports nothing usable, and bills it nothing', async () => {
    const usage = newJevUsage();
    const metered = meteringFetch(
      async () => new Response('not json at all', { status: 500 }),
      usage,
    );

    await metered('https://api.example/one', {});

    expect(usage).toEqual({ requests: 1, inputTokens: 0 });
  });
});
