import { describe, expect, it } from 'vitest';
import {
  ASSIGNMENT_BASE_OUTPUT_TOKENS,
  ASSIGNMENT_OUTPUT_TOKENS_PER_BOOKMARK,
  SUMMARY_OUTPUT_TOKENS,
  TAXONOMY_OUTPUT_TOKENS,
  outputBudgetFor,
} from './output-budget';

/**
 * The per-role answer budgets (security review 2, #19). Each is far below the
 * 128k output tokens a model like Claude Sonnet 5 would otherwise be allowed,
 * and far above what the role legitimately writes.
 */
describe('outputBudgetFor', () => {
  it('bounds a summary at a few thousand tokens, not the model maximum', () => {
    expect(outputBudgetFor('summary', { batchSize: 15 })).toBe(SUMMARY_OUTPUT_TOKENS);
    expect(SUMMARY_OUTPUT_TOKENS).toBeLessThanOrEqual(8_192);
  });

  it('sizes the assignment pass from its batch, with room per bookmark', () => {
    expect(outputBudgetFor('assignment', { batchSize: 15 })).toBe(
      ASSIGNMENT_BASE_OUTPUT_TOKENS + 15 * ASSIGNMENT_OUTPUT_TOKENS_PER_BOOKMARK,
    );
    // A realistic answer for one bookmark - three 4-level paths with long
    // names - is well inside its share (chars/4 is the app's token estimate).
    const entry = JSON.stringify({
      post_id: '1912345678901234567',
      categories: Array.from({ length: 3 }, () => [
        'Artificial Intelligence',
        'Agent Harnesses and Tooling',
        'Evaluation Frameworks',
        'Long-horizon Benchmarks',
      ]),
    });
    expect(Math.ceil(entry.length / 4)).toBeLessThan(ASSIGNMENT_OUTPUT_TOKENS_PER_BOOKMARK);
    // A nonsensical batch size still leaves room for one bookmark.
    expect(outputBudgetFor('assignment', { batchSize: 0 })).toBe(
      ASSIGNMENT_BASE_OUTPUT_TOKENS + ASSIGNMENT_OUTPUT_TOKENS_PER_BOOKMARK,
    );
  });

  it('leaves the taxonomy pass room for a tree of hundreds of described nodes', () => {
    const node = JSON.stringify({
      name: 'Long-horizon Benchmarks',
      description: 'x'.repeat(160),
      children: [],
    });
    const nodesThatFit = TAXONOMY_OUTPUT_TOKENS / Math.ceil(node.length / 4);
    expect(nodesThatFit).toBeGreaterThan(400);
    expect(outputBudgetFor('taxonomy', { batchSize: 15 })).toBe(TAXONOMY_OUTPUT_TOKENS);
  });
});
