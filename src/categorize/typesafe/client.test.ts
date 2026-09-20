import { describe, expect, it } from 'vitest';
import type { Fetch } from '@typesafe-ai/sdk';
import {
  buildLevelCriteria,
  buildLevelInstructions,
  describeTypeSafeError,
  MAX_CHOICE_OPTIONS,
  TypeSafeLevelAsker,
} from './client';
import type { AskLevel } from './walk';

/**
 * Every test here drives the real SDK through its injectable `Fetch`, so the
 * request/response mapping is exercised end to end with NO network call, no
 * API key and no spend - the same discipline as the `claude-cli` adapter's
 * stub-binary tests.
 */

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  body: { state: unknown; questions: Record<string, unknown>; model?: string };
}

/** A `Fetch` that records the request and replies with `answers`. */
function stubFetch(
  answers: Record<string, unknown>,
  captured: CapturedRequest[] = [],
): { fetch: Fetch; captured: CapturedRequest[] } {
  const fetch: Fetch = async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    captured.push({ url: input, headers, body: JSON.parse(String(init?.body)) });
    return new Response(
      JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 10, output_tokens: 0 } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  return { fetch, captured };
}

/** A `Fetch` that always fails with the given HTTP status. */
function failingFetch(status: number): Fetch {
  return async () =>
    new Response(JSON.stringify({ error: { message: 'nope' } }), {
      status,
      headers: { 'content-type': 'application/json' },
    });
}

const rootLevel: AskLevel = {
  path: [],
  options: [
    { id: 1, name: 'AI', description: 'Machine learning, models and tooling.' },
    { id: 2, name: 'Cooking', description: null },
  ],
};

const nestedLevel: AskLevel = {
  path: [{ id: 1, name: 'AI' }],
  options: [
    { id: 10, name: 'Harnesses', description: 'Agent harnesses and CLIs.' },
    { id: 11, name: 'Research', description: 'Papers and preprints.' },
  ],
};

function asker(fetch: Fetch, logger?: (m: string) => void): TypeSafeLevelAsker {
  return new TypeSafeLevelAsker({ apiKey: 'test-key-not-real', fetch, ...(logger ? { logger } : {}) });
}

describe('buildLevelCriteria', () => {
  it('maps node names to labels and descriptions to criteria', () => {
    const { criteria, idByLabel } = buildLevelCriteria(rootLevel);

    expect(criteria).toEqual({ AI: 'Machine learning, models and tooling.', Cooking: null });
    expect(idByLabel.get('AI')).toBe(1);
    expect(idByLabel.get('Cooking')).toBe(2);
  });

  it('disambiguates labels that differ only by case, never collapsing two nodes', () => {
    const { criteria, idByLabel } = buildLevelCriteria({
      path: [],
      options: [
        { id: 1, name: 'AI', description: null },
        { id: 2, name: 'AI', description: null },
      ],
    });

    expect(Object.keys(criteria)).toHaveLength(2);
    expect(idByLabel.size).toBe(2);
    expect(new Set(idByLabel.values())).toEqual(new Set([1, 2]));
  });

  it('caps options at the documented Choice limit and reports the overflow', () => {
    const options = Array.from({ length: MAX_CHOICE_OPTIONS + 5 }, (_, i) => ({
      id: i + 1,
      name: `Cat ${i}`,
      description: null,
    }));

    const { criteria, truncated } = buildLevelCriteria({ path: [], options });

    expect(Object.keys(criteria)).toHaveLength(MAX_CHOICE_OPTIONS);
    expect(truncated).toBe(5);
  });
});

describe('buildLevelInstructions', () => {
  it('asks about top-level categories at the root', () => {
    expect(buildLevelInstructions(rootLevel)).toContain('top-level categories');
  });

  it('names the branch already walked for a nested level', () => {
    const instructions = buildLevelInstructions({
      path: [
        { id: 1, name: 'AI' },
        { id: 10, name: 'Harnesses' },
      ],
      options: nestedLevel.options,
    });

    expect(instructions).toContain('AI > Harnesses');
  });
});

describe('TypeSafeLevelAsker', () => {
  it('sends state and one Choice question per level, and maps answers back to node ids', async () => {
    const { fetch, captured } = stubFetch({
      level_0: { type: 'choice', choice: 'AI', confidence: 0.91, probabilities: { AI: 0.87, Cooking: 0.13 } },
      level_1: {
        type: 'choice',
        choice: 'Harnesses',
        confidence: 0.77,
        probabilities: { Harnesses: 0.7, Research: 0.3 },
      },
    });

    const answers = await asker(fetch).ask({ post_text: 'a post about agents' }, [rootLevel, nestedLevel]);

    // One HTTP round trip for the whole frontier.
    expect(captured).toHaveLength(1);
    expect(captured[0]!.body.state).toEqual({ post_text: 'a post about agents' });
    expect(Object.keys(captured[0]!.body.questions)).toEqual(['level_0', 'level_1']);

    expect(answers[0]!.confidence).toBeCloseTo(0.91);
    expect(answers[0]!.probabilities.get(1)).toBeCloseTo(0.87);
    expect(answers[0]!.probabilities.get(2)).toBeCloseTo(0.13);
    expect(answers[1]!.probabilities.get(10)).toBeCloseTo(0.7);
    expect(answers[1]!.probabilities.get(11)).toBeCloseTo(0.3);
  });

  it('sends the node descriptions as the Choice criteria', async () => {
    const { fetch, captured } = stubFetch({
      level_0: { type: 'choice', choice: 'AI', confidence: 0.9, probabilities: { AI: 0.9, Cooking: 0.1 } },
    });

    await asker(fetch).ask({ post_text: 'x' }, [rootLevel]);

    const question = captured[0]!.body.questions.level_0 as { type: string; criteria: Record<string, unknown> };
    expect(question.type).toBe('choice');
    expect(question.criteria).toEqual({ AI: 'Machine learning, models and tooling.', Cooking: null });
  });

  it('authenticates with the key it was handed, not one read from the environment', async () => {
    const { fetch, captured } = stubFetch({
      level_0: { type: 'choice', choice: 'AI', confidence: 0.9, probabilities: { AI: 0.9, Cooking: 0.1 } },
    });

    await asker(fetch).ask({ post_text: 'x' }, [rootLevel]);

    expect(captured[0]!.headers.authorization).toBe('Bearer test-key-not-real');
  });

  it('treats an unexpected or missing answer as zero confidence rather than throwing', async () => {
    const { fetch } = stubFetch({ level_0: { type: 'noul', noul: 0.5 } });

    const answers = await asker(fetch).ask({ post_text: 'x' }, [rootLevel]);

    expect(answers).toHaveLength(1);
    expect(answers[0]!.confidence).toBe(0);
    expect(answers[0]!.probabilities.size).toBe(0);
  });

  it('ignores a probability for a label that is not on the tree', async () => {
    const { fetch } = stubFetch({
      level_0: {
        type: 'choice',
        choice: 'AI',
        confidence: 0.9,
        probabilities: { AI: 0.6, Cooking: 0.2, Hallucinated: 0.2 },
      },
    });

    const answers = await asker(fetch).ask({ post_text: 'x' }, [rootLevel]);

    expect([...answers[0]!.probabilities.keys()].sort()).toEqual([1, 2]);
  });

  it('makes no request at all when there is nothing to ask', async () => {
    const { fetch, captured } = stubFetch({});

    expect(await asker(fetch).ask({ post_text: 'x' }, [])).toEqual([]);
    expect(captured).toHaveLength(0);
  });

  it('logs when a level has more siblings than a Choice can carry', async () => {
    const logs: string[] = [];
    const options = Array.from({ length: MAX_CHOICE_OPTIONS + 2 }, (_, i) => ({
      id: i + 1,
      name: `Cat ${i}`,
      description: null,
    }));
    const { fetch } = stubFetch({
      level_0: { type: 'choice', choice: 'Cat 0', confidence: 0.9, probabilities: { 'Cat 0': 0.9 } },
    });

    await asker(fetch, (m) => logs.push(m)).ask({ post_text: 'x' }, [{ path: [], options }]);

    expect(logs.join('\n')).toContain('2 were not offered');
  });

  it('surfaces a rejected key as an actionable message that never echoes the key', async () => {
    await expect(asker(failingFetch(401)).ask({ post_text: 'x' }, [rootLevel])).rejects.toThrow(
      /TYPESAFE_API_KEY/,
    );
    await expect(asker(failingFetch(401)).ask({ post_text: 'x' }, [rootLevel])).rejects.not.toThrow(
      /test-key-not-real/,
    );
  });
});

describe('describeTypeSafeError', () => {
  it('explains an auth failure', () => {
    expect(describeTypeSafeError({ status: 401 })).toContain('TYPESAFE_API_KEY');
  });

  it('explains a rate limit and points at the concurrency knob', () => {
    expect(describeTypeSafeError({ status: 429 })).toContain('XBOOKMARKS_TYPESAFE_CONCURRENCY');
  });

  it('explains a server error', () => {
    expect(describeTypeSafeError({ status: 503 })).toContain('HTTP 503');
  });

  it('falls back to the error message for anything else', () => {
    expect(describeTypeSafeError(new Error('socket hang up'))).toContain('socket hang up');
  });
});
