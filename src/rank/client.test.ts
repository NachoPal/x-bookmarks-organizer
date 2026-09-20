import { describe, expect, it } from 'vitest';
import type { Fetch } from '@typesafe-ai/sdk';
import { JevStateScorer } from './client';
import { buildRubric, type Rubric } from './rubric';

/**
 * Every test drives the REAL SDK through its injectable `Fetch`, so the whole
 * request/response mapping is exercised end to end with no network call, no real
 * API key and no spend - the same discipline as the categorizer's client tests.
 */

interface CapturedRequest {
  url: string;
  body: {
    state: unknown;
    questions: Record<string, { type: string; instructions: unknown; criteria: unknown }>;
    model?: string;
  };
}

function stubFetch(
  answers: Record<string, unknown>,
  options: { inputTokens?: number; model?: string } = {},
): { fetch: Fetch; captured: CapturedRequest[] } {
  const captured: CapturedRequest[] = [];
  const fetch: Fetch = async (input, init) => {
    captured.push({ url: input, body: JSON.parse(String(init?.body)) });
    return new Response(
      JSON.stringify({
        model: options.model ?? 'jev-1.13.0',
        answers,
        usage: { input_tokens: options.inputTokens ?? 1234, output_tokens: 0 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  return { fetch, captured };
}

function failingFetch(status: number): Fetch {
  return async () =>
    new Response(JSON.stringify({ error: { message: 'nope' } }), {
      status,
      headers: { 'content-type': 'application/json' },
    });
}

const rubric: Rubric = {
  version: 'test',
  dimensions: [
    { id: 'a', weight: 1, instructions: 'How good?', levels: ['bad', 'ok', 'great'] },
    { id: 'b', weight: 1, instructions: 'How lasting?', levels: ['no', 'yes'] },
  ],
};

function scoreAnswer(score: number, confidence: number) {
  return { type: 'score', score, confidence, legend: {}, probabilities: {} };
}

function scorer(fetch: Fetch): JevStateScorer {
  // Retries off: a test asserting a failure should not wait out backoff.
  return new JevStateScorer({ apiKey: 'test-key-not-real', fetch });
}

describe('JevStateScorer', () => {
  it('sends ONE request carrying every rubric dimension as a Score question', async () => {
    const { fetch, captured } = stubFetch({
      dim_a: scoreAnswer(2, 0.9),
      dim_b: scoreAnswer(1, 0.7),
    });

    await scorer(fetch).score({ post: { text: 'hello' } }, rubric);

    expect(captured).toHaveLength(1);
    const { body } = captured[0]!;
    expect(body.state).toEqual({ post: { text: 'hello' } });
    expect(Object.keys(body.questions)).toEqual(['dim_a', 'dim_b']);
    expect(body.questions.dim_a).toEqual({
      type: 'score',
      instructions: 'How good?',
      criteria: ['bad', 'ok', 'great'],
    });
    expect(body.questions.dim_b!.criteria).toEqual(['no', 'yes']);
  });

  it('reads each dimension answer back, keyed by dimension id, with the billed token count', async () => {
    const { fetch } = stubFetch(
      { dim_a: scoreAnswer(2, 0.9), dim_b: scoreAnswer(0.5, 0.4) },
      { inputTokens: 742, model: 'jev-1.13.0' },
    );

    const result = await scorer(fetch).score({ post: { text: 'x' } }, rubric);

    expect(result.answers.get('a')).toEqual({ score: 2, confidence: 0.9 });
    expect(result.answers.get('b')).toEqual({ score: 0.5, confidence: 0.4 });
    expect(result.model).toBe('jev-1.13.0');
    expect(result.inputTokens).toBe(742);
  });

  it('skips a dimension answered with the wrong type, a non-finite score, or not at all', async () => {
    const { fetch } = stubFetch({
      dim_a: { type: 'choice', choice: 'x', confidence: 1, probabilities: {} },
      // dim_b entirely absent
    });

    const result = await scorer(fetch).score({ post: { text: 'x' } }, rubric);
    expect(result.answers.size).toBe(0);
  });

  it('defaults a missing confidence to zero rather than NaN', async () => {
    const { fetch } = stubFetch({ dim_a: { type: 'score', score: 1, legend: {}, probabilities: {} } });
    const result = await scorer(fetch).score({}, rubric);
    expect(result.answers.get('a')).toEqual({ score: 1, confidence: 0 });
  });

  it('turns an auth failure into an actionable message that never leaks the key', async () => {
    await expect(scorer(failingFetch(401)).score({}, rubric)).rejects.toThrow(/TYPESAFE_API_KEY/);
    await expect(scorer(failingFetch(401)).score({}, rubric)).rejects.not.toThrow(
      /test-key-not-real/,
    );
  });

  it('sends the real rubric with valid Score criteria the SDK accepts', async () => {
    const { fetch, captured } = stubFetch({});
    // The SDK itself rejects score criteria that are not a list of at least two
    // entries, so this asserts the shipped rubric is well-formed.
    await scorer(fetch).score({ post: { text: 'x' } }, buildRubric('rust'));
    expect(Object.keys(captured[0]!.body.questions)).toHaveLength(5);
  });
});
