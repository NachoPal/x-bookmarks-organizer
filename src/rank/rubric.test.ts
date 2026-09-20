import { describe, expect, it } from 'vitest';
import {
  buildRubric,
  combineDimensionScores,
  normalizeDimensionScore,
  RUBRIC_VERSION,
  type DimensionAnswer,
  type Rubric,
} from './rubric';

/**
 * The rubric and its arithmetic are pure, so every test here runs with nothing
 * stubbed - no SDK, no database, no network, no spend.
 */

const twoDim: Rubric = {
  version: 'test',
  dimensions: [
    { id: 'a', weight: 3, instructions: 'A?', levels: ['low', 'mid', 'high'] },
    { id: 'b', weight: 1, instructions: 'B?', levels: ['no', 'yes'] },
  ],
};

function answers(entries: Record<string, DimensionAnswer>): Map<string, DimensionAnswer> {
  return new Map(Object.entries(entries));
}

describe('normalizeDimensionScore', () => {
  it('maps a level index onto 0..1 across the rubric levels', () => {
    expect(normalizeDimensionScore(0, 3)).toBe(0);
    expect(normalizeDimensionScore(1, 3)).toBe(0.5);
    expect(normalizeDimensionScore(2, 3)).toBe(1);
  });

  it('keeps a fractional expected score fractional', () => {
    // Jev returns an EXPECTED score, which may sit between integer levels.
    expect(normalizeDimensionScore(1.5, 3)).toBe(0.75);
  });

  it('clamps out-of-range and non-finite scores instead of propagating them', () => {
    expect(normalizeDimensionScore(-1, 3)).toBe(0);
    expect(normalizeDimensionScore(9, 3)).toBe(1);
    expect(normalizeDimensionScore(Number.NaN, 3)).toBe(0);
    expect(normalizeDimensionScore(1, 1)).toBe(0);
  });
});

describe('combineDimensionScores', () => {
  it('weights the normalized dimensions and averages the confidences', () => {
    const combined = combineDimensionScores(
      twoDim,
      answers({ a: { score: 2, confidence: 0.8 }, b: { score: 0, confidence: 0.4 } }),
    );

    // a = 1.0 at weight 3, b = 0.0 at weight 1 -> 3/4.
    expect(combined.score).toBeCloseTo(0.75, 10);
    expect(combined.confidence).toBeCloseTo((0.8 * 3 + 0.4 * 1) / 4, 10);
    expect(combined.dimensions).toEqual({ a: 1, b: 0 });
  });

  it('drops a missing dimension from BOTH the score and the weighting, never scoring it zero', () => {
    const combined = combineDimensionScores(twoDim, answers({ a: { score: 1, confidence: 0.6 } }));

    // Only `a` answered, so the result is `a` alone - not a/(a+b) with b at 0,
    // which would rank the bookmark down for an API hiccup.
    expect(combined.score).toBeCloseTo(0.5, 10);
    expect(combined.confidence).toBeCloseTo(0.6, 10);
    expect(combined.dimensions).toEqual({ a: 0.5 });
  });

  it('reports no dimensions at all when nothing was answered, so the caller can refuse to store it', () => {
    const combined = combineDimensionScores(twoDim, answers({}));
    expect(combined).toEqual({ score: 0, confidence: 0, dimensions: {} });
  });

  it('clamps a confidence outside 0..1', () => {
    const combined = combineDimensionScores(
      { version: 't', dimensions: [twoDim.dimensions[0]!] },
      answers({ a: { score: 1, confidence: 4 } }),
    );
    expect(combined.confidence).toBe(1);
  });
});

describe('buildRubric', () => {
  it('asks only about the content itself when no interests are given', () => {
    const rubric = buildRubric();
    expect(rubric.version).toBe(RUBRIC_VERSION);
    expect(rubric.dimensions.map((d) => d.id)).toEqual([
      'learning_value',
      'insight_density',
      'durability',
      'actionability',
    ]);
  });

  it('treats blank interests as none', () => {
    expect(buildRubric('   ').version).toBe(RUBRIC_VERSION);
    expect(buildRubric('   ').dimensions).toHaveLength(4);
  });

  it('adds a relevance question, naming the interests, when they are given', () => {
    const rubric = buildRubric('rust compilers, distributed systems');
    const relevance = rubric.dimensions.find((d) => d.id === 'relevance');
    expect(relevance?.instructions).toContain('rust compilers, distributed systems');
  });

  it('versions each distinct interest statement separately, so two scales never mix in one sort', () => {
    const a = buildRubric('rust').version;
    const b = buildRubric('cooking').version;
    expect(a).not.toBe(b);
    expect(a).not.toBe(RUBRIC_VERSION);
    // Whitespace is normalized, so the same statement typed differently is the
    // same scale and does NOT trigger a paid re-score.
    expect(buildRubric('  rust   ').version).toBe(a);
  });

  it('gives every dimension at least the two levels the SDK requires', () => {
    for (const dimension of buildRubric('anything').dimensions) {
      expect(dimension.levels.length).toBeGreaterThanOrEqual(2);
      expect(dimension.weight).toBeGreaterThan(0);
    }
  });
});
