import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TAXONOMY_CONTEXT_WINDOW,
  effectiveContextWindow,
  estimateTokens,
  inputBudgetFor,
  planBatches,
  type BatchRange,
} from './taxonomy-budget';

const sizes = (weights: number[], ranges: BatchRange[]) =>
  ranges.map((r) => weights.slice(r.start, r.end).reduce((a, b) => a + b, 0));

describe('estimateTokens', () => {
  it('is chars / 4, rounded up', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });
});

describe('effectiveContextWindow', () => {
  it('uses a declared window as-is', () => {
    expect(effectiveContextWindow(1_000_000)).toBe(1_000_000);
    expect(effectiveContextWindow(32_768)).toBe(32_768);
  });

  it('falls back to the safe default when the model declares none (or nonsense)', () => {
    for (const bad of [undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(effectiveContextWindow(bad)).toBe(DEFAULT_TAXONOMY_CONTEXT_WINDOW);
    }
  });

  it('never credits an unknown model with a big window', () => {
    expect(DEFAULT_TAXONOMY_CONTEXT_WINDOW).toBeLessThanOrEqual(200_000);
  });
});

describe('inputBudgetFor', () => {
  it('leaves a quarter of the window for the response and the estimate error', () => {
    expect(inputBudgetFor(200_000)).toBe(150_000);
    expect(inputBudgetFor(1_000_000)).toBe(750_000);
  });
});

describe('planBatches', () => {
  it('keeps everything in one batch when it fits', () => {
    expect(planBatches([10, 10, 10], 30)).toEqual([{ start: 0, end: 3 }]);
  });

  it('splits into the FEWEST batches that each fit, covering every item in order', () => {
    const weights = Array.from({ length: 10 }, () => 10);
    const ranges = planBatches(weights, 40);
    expect(ranges).toHaveLength(3); // 100 / 40 -> at least 3
    expect(ranges[0]!.start).toBe(0);
    expect(ranges.at(-1)!.end).toBe(10);
    for (let i = 1; i < ranges.length; i++) expect(ranges[i]!.start).toBe(ranges[i - 1]!.end);
    for (const size of sizes(weights, ranges)) expect(size).toBeLessThanOrEqual(40);
  });

  it('evens the batches out rather than leaving a thin tail', () => {
    // Greedy would cut 40 | 40 | 20; the same three batches can be ~33 each.
    const weights = Array.from({ length: 10 }, () => 10);
    const counts = planBatches(weights, 40).map((r) => r.end - r.start);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  });

  it('falls back to the greedy cut when an even cut would overflow a batch', () => {
    // An even cut by weight puts every light item AND the heavy one together.
    expect(planBatches([1, 1, 1, 1, 10], 10)).toEqual([
      { start: 0, end: 4 },
      { start: 4, end: 5 },
    ]);
  });

  it('refuses when a single item cannot fit, rather than dropping it', () => {
    expect(() => planBatches([5, 50, 5], 20)).toThrow(/context window is too small/);
  });
});
