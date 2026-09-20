import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WALK_OPTIONS,
  walkTree,
  type AskLevel,
  type AskLevels,
  type LevelAnswer,
  type WalkOptions,
  type WalkTreeNode,
} from './walk';

/**
 * These tests exercise the entire classification algorithm with a fake
 * `askLevels` - no SDK, no network, no API key, no cost. That is the whole
 * reason the walk is a pure function over injected answers.
 */

function node(id: number, name: string, children: WalkTreeNode[] = []): WalkTreeNode {
  return { id, name, description: null, children };
}

/**
 * A small two-root tree:
 *   1 AI            2 Cooking
 *     10 Harnesses    20 Baking
 *       100 MCP
 *       101 Agents
 *     11 Research
 */
function sampleTree(): WalkTreeNode[] {
  return [
    node(1, 'AI', [
      node(10, 'Harnesses', [node(100, 'MCP'), node(101, 'Agents')]),
      node(11, 'Research'),
    ]),
    node(2, 'Cooking', [node(20, 'Baking')]),
  ];
}

const opts = (overrides: Partial<WalkOptions> = {}): WalkOptions => ({
  ...DEFAULT_WALK_OPTIONS,
  ...overrides,
});

/**
 * Build a fake asker from a map of "option ids at this level" -> answer.
 * Records every level it was asked, so tests can assert on the questions too.
 */
function fakeAsker(
  answerFor: (level: AskLevel) => LevelAnswer,
): { ask: AskLevels; calls: AskLevel[][] } {
  const calls: AskLevel[][] = [];
  const ask: AskLevels = async (levels) => {
    calls.push(levels.map((l) => ({ path: [...l.path], options: [...l.options] })));
    return levels.map(answerFor);
  };
  return { ask, calls };
}

/** An answer putting `p` on `id` and spreading the rest evenly. */
function pick(id: number, p: number, others: number[], confidence = 0.95): LevelAnswer {
  const probabilities = new Map<number, number>([[id, p]]);
  const rest = others.length > 0 ? (1 - p) / others.length : 0;
  for (const other of others) probabilities.set(other, rest);
  return { probabilities, confidence };
}

describe('walkTree', () => {
  it('descends to a leaf, building the path from real node ids', async () => {
    const { ask } = fakeAsker((level) => {
      const ids = level.options.map((o) => o.id);
      if (ids.includes(1)) return pick(1, 0.9, [2]);
      if (ids.includes(10)) return pick(10, 0.8, [11]);
      return pick(100, 0.85, [101]);
    });

    const result = await walkTree(sampleTree(), ask, opts());

    expect(result.unresolved).toBe(false);
    expect(result.paths).toHaveLength(1);
    expect(result.paths[0]!.nodes.map((n) => n.name)).toEqual(['AI', 'Harnesses', 'MCP']);
    expect(result.paths[0]!.nodes.map((n) => n.id)).toEqual([1, 10, 100]);
    expect(result.paths[0]!.confident).toBe(true);
  });

  it('asks one question per level, with the walked path as context', async () => {
    const { ask, calls } = fakeAsker((level) => {
      const ids = level.options.map((o) => o.id);
      if (ids.includes(1)) return pick(1, 0.9, [2]);
      if (ids.includes(10)) return pick(10, 0.9, [11]);
      return pick(100, 0.9, [101]);
    });

    await walkTree(sampleTree(), ask, opts({ beamWidth: 1 }));

    expect(calls).toHaveLength(3);
    expect(calls[0]![0]!.path).toEqual([]);
    expect(calls[0]![0]!.options.map((o) => o.name)).toEqual(['AI', 'Cooking']);
    expect(calls[1]![0]!.path.map((n) => n.name)).toEqual(['AI']);
    expect(calls[2]![0]!.path.map((n) => n.name)).toEqual(['AI', 'Harnesses']);
  });

  it('batches the whole beam frontier into ONE call per level', async () => {
    const { ask, calls } = fakeAsker((level) => {
      const ids = level.options.map((o) => o.id);
      // Both roots stay plausible, so the beam carries two candidates down.
      if (ids.includes(1)) return { probabilities: new Map([[1, 0.6], [2, 0.6]]), confidence: 0.9 };
      if (ids.includes(10)) return pick(10, 0.9, [11]);
      if (ids.includes(20)) return pick(20, 0.9, []);
      return pick(100, 0.9, [101]);
    });

    await walkTree(sampleTree(), ask, opts({ beamWidth: 2 }));

    // Level 2 has two live candidates (AI and Cooking) but only one round trip.
    expect(calls[1]).toHaveLength(2);
    expect(calls[1]!.map((l) => l.path[0]!.name).sort()).toEqual(['AI', 'Cooking']);
  });

  it('beam search recovers from an ambiguous first decision that greedy loses', async () => {
    // The root is near a coin flip in favour of Cooking, but the AI branch has
    // far stronger evidence below it. Greedy commits to Cooking; a beam of 2
    // keeps AI alive and ends up preferring it on the normalized score.
    const answer = (level: AskLevel): LevelAnswer => {
      const ids = level.options.map((o) => o.id);
      if (ids.includes(1)) return { probabilities: new Map([[1, 0.58], [2, 0.62]]), confidence: 0.9 };
      if (ids.includes(10)) return pick(10, 0.99, [11]);
      if (ids.includes(20)) return { probabilities: new Map([[20, 0.6]]), confidence: 0.9 };
      return pick(100, 0.99, [101]);
    };

    const greedy = await walkTree(sampleTree(), fakeAsker(answer).ask, opts({ beamWidth: 1 }));
    expect(greedy.paths[0]!.nodes.map((n) => n.name)).toEqual(['Cooking', 'Baking']);

    const beam = await walkTree(sampleTree(), fakeAsker(answer).ask, opts({ beamWidth: 3 }));
    expect(beam.paths[0]!.nodes.map((n) => n.name)).toEqual(['AI', 'Harnesses', 'MCP']);
  });

  it('keeps a second branch as an extra label when it clears the threshold', async () => {
    const { ask } = fakeAsker((level) => {
      const ids = level.options.map((o) => o.id);
      // Genuinely belongs to both roots.
      if (ids.includes(1)) return { probabilities: new Map([[1, 0.9], [2, 0.88]]), confidence: 0.95 };
      if (ids.includes(10)) return pick(10, 0.9, [11]);
      if (ids.includes(20)) return { probabilities: new Map([[20, 0.9]]), confidence: 0.95 };
      return pick(100, 0.9, [101]);
    });

    const result = await walkTree(sampleTree(), ask, opts({ beamWidth: 3, multiLabelThreshold: 0.6 }));

    const names = result.paths.map((p) => p.nodes.map((n) => n.name).join(' > '));
    expect(names).toContain('AI > Harnesses > MCP');
    expect(names).toContain('Cooking > Baking');
  });

  it('does NOT add a second label when it falls below the multi-label threshold', async () => {
    const { ask } = fakeAsker((level) => {
      const ids = level.options.map((o) => o.id);
      if (ids.includes(1)) return { probabilities: new Map([[1, 0.95], [2, 0.6]]), confidence: 0.95 };
      if (ids.includes(10)) return pick(10, 0.95, [11]);
      if (ids.includes(20)) return { probabilities: new Map([[20, 0.6]]), confidence: 0.95 };
      return pick(100, 0.95, [101]);
    });

    const result = await walkTree(sampleTree(), ask, opts({ beamWidth: 3, multiLabelThreshold: 0.9 }));

    expect(result.paths).toHaveLength(1);
    expect(result.paths[0]!.nodes.map((n) => n.name)).toEqual(['AI', 'Harnesses', 'MCP']);
  });

  it('caps the number of labels at maxLabels', async () => {
    const { ask } = fakeAsker((level) => {
      const probabilities = new Map(level.options.map((o) => [o.id, 0.95] as const));
      return { probabilities, confidence: 0.99 };
    });

    const result = await walkTree(sampleTree(), ask, opts({ beamWidth: 4, maxLabels: 2, multiLabelThreshold: 0.1 }));

    expect(result.paths.length).toBeLessThanOrEqual(2);
  });

  it('stops at the last confident ancestor when a deeper level is uncertain', async () => {
    const { ask } = fakeAsker((level) => {
      const ids = level.options.map((o) => o.id);
      if (ids.includes(1)) return pick(1, 0.95, [2]);
      if (ids.includes(10)) return pick(10, 0.9, [11]);
      // MCP vs Agents is a coin flip - report "AI > Harnesses" instead.
      return { probabilities: new Map([[100, 0.5], [101, 0.5]]), confidence: 0.2 };
    });

    const result = await walkTree(sampleTree(), ask, opts());

    expect(result.unresolved).toBe(false);
    expect(result.paths).toHaveLength(1);
    expect(result.paths[0]!.nodes.map((n) => n.name)).toEqual(['AI', 'Harnesses']);
    expect(result.paths[0]!.confident).toBe(false);
  });

  it('reports unresolved when not even the root level is confident', async () => {
    const { ask } = fakeAsker(() => ({
      probabilities: new Map([[1, 0.5], [2, 0.5]]),
      confidence: 0.1,
    }));

    const result = await walkTree(sampleTree(), ask, opts());

    expect(result.paths).toHaveLength(0);
    expect(result.unresolved).toBe(true);
  });

  it('never descends deeper than maxDepth', async () => {
    const { ask, calls } = fakeAsker((level) => {
      const probabilities = new Map(level.options.map((o) => [o.id, 0.99] as const));
      return { probabilities, confidence: 0.99 };
    });

    const result = await walkTree(sampleTree(), ask, opts({ beamWidth: 1, maxDepth: 2 }));

    expect(calls).toHaveLength(2);
    for (const path of result.paths) expect(path.nodes.length).toBeLessThanOrEqual(2);
    expect(result.paths[0]!.nodes.map((n) => n.name)).toEqual(['AI', 'Harnesses']);
  });

  it('stops naturally at a leaf without asking a pointless question', async () => {
    const { ask, calls } = fakeAsker((level) => {
      const ids = level.options.map((o) => o.id);
      if (ids.includes(1)) return pick(2, 0.95, [1]);
      return pick(20, 0.95, []);
    });

    const result = await walkTree(sampleTree(), ask, opts({ beamWidth: 1, maxDepth: 4 }));

    // Cooking > Baking is only two levels deep; no third question is asked.
    expect(calls).toHaveLength(2);
    expect(result.paths[0]!.nodes.map((n) => n.name)).toEqual(['Cooking', 'Baking']);
    expect(result.paths[0]!.confident).toBe(true);
  });

  it('drops a path that is only a prefix of a deeper kept path', async () => {
    const { ask } = fakeAsker((level) => {
      const ids = level.options.map((o) => o.id);
      if (ids.includes(1)) return pick(1, 0.95, [2]);
      if (ids.includes(10)) return { probabilities: new Map([[10, 0.95], [11, 0.9]]), confidence: 0.95 };
      return pick(100, 0.95, [101]);
    });

    const result = await walkTree(sampleTree(), ask, opts({ beamWidth: 3, multiLabelThreshold: 0.5 }));

    const names = result.paths.map((p) => p.nodes.map((n) => n.name).join(' > '));
    // "AI > Harnesses" must not appear alongside "AI > Harnesses > MCP".
    expect(names).not.toContain('AI > Harnesses');
    expect(names).toContain('AI > Harnesses > MCP');
  });

  it('treats an empty tree as unresolved without asking anything', async () => {
    const { ask, calls } = fakeAsker(() => pick(1, 1, []));

    const result = await walkTree([], ask, opts());

    expect(result).toEqual({ paths: [], unresolved: true });
    expect(calls).toHaveLength(0);
  });

  it('treats a missing answer as low confidence rather than crashing', async () => {
    const ask: AskLevels = async () => [];

    const result = await walkTree(sampleTree(), ask, opts());

    expect(result.paths).toHaveLength(0);
    expect(result.unresolved).toBe(true);
  });

  it('scores a path as the length-normalized geometric mean of its edges', async () => {
    const { ask } = fakeAsker((level) => {
      const ids = level.options.map((o) => o.id);
      if (ids.includes(1)) return { probabilities: new Map([[1, 0.8]]), confidence: 0.9 };
      if (ids.includes(10)) return { probabilities: new Map([[11, 0.6]]), confidence: 0.9 };
      return { probabilities: new Map(), confidence: 0.9 };
    });

    const result = await walkTree(sampleTree(), ask, opts({ beamWidth: 1 }));

    // Research is a leaf, so the walk stops after two decisions: sqrt(0.8*0.6).
    expect(result.paths[0]!.nodes.map((n) => n.name)).toEqual(['AI', 'Research']);
    expect(result.paths[0]!.score).toBeCloseTo(Math.sqrt(0.8 * 0.6), 10);
  });
});
