/**
 * How many tokens each role is allowed to ANSWER with (security review 2, #19).
 *
 * Without an explicit cap a per-token provider falls back to the model's own
 * maximum - 128,000 output tokens for Claude Sonnet 5 - so a bookmark whose
 * text talks the model into rambling can bill that much on one call. Every
 * role's budget is therefore stated here, sized from what the role actually
 * produces, with generous headroom so a legitimate answer never hits it:
 *
 * - `summary`: a short lead plus a tight bullet list (`buildSummaryPrompt`),
 *   typically well under 1,000 tokens. 8,192 leaves room for a model that
 *   reasons without being asked to.
 * - `chat`: no feature uses it yet; the same conversational bound as a summary.
 * - `assignment`: one `{"post_id", "categories": [[...path]]}` entry per
 *   bookmark (`buildPrompt`), about 40-80 tokens for a few paths of up to
 *   `maxDepth` names. 256 per bookmark covers several long paths, plus 1,024
 *   for the envelope, at the configured batch size.
 * - `taxonomy`: the whole tree as JSON (`OUTPUT_SPEC` in `taxonomy.ts`),
 *   about 50-60 tokens per node with its one-line description. 32,768 is room
 *   for roughly 500 nodes - far past a tree anyone could browse.
 *
 * This is the ANSWER budget. A pass run with a reasoning effort also gets that
 * effort's thinking allowance on top, added by the adapter that knows whether
 * the model actually reasons (`completeOnPi`), so a deep taxonomy pass is not
 * starved by its own thinking.
 */
import type { LlmRole } from './types';

export const SUMMARY_OUTPUT_TOKENS = 8_192;
export const CHAT_OUTPUT_TOKENS = 8_192;
export const TAXONOMY_OUTPUT_TOKENS = 32_768;
export const ASSIGNMENT_BASE_OUTPUT_TOKENS = 1_024;
export const ASSIGNMENT_OUTPUT_TOKENS_PER_BOOKMARK = 256;

/** The role's answer budget in tokens. `batchSize` sizes the assignment pass. */
export function outputBudgetFor(role: LlmRole, opts: { batchSize: number }): number {
  switch (role) {
    case 'summary':
      return SUMMARY_OUTPUT_TOKENS;
    case 'chat':
      return CHAT_OUTPUT_TOKENS;
    case 'taxonomy':
      return TAXONOMY_OUTPUT_TOKENS;
    case 'assignment':
      return ASSIGNMENT_BASE_OUTPUT_TOKENS + ASSIGNMENT_OUTPUT_TOKENS_PER_BOOKMARK * Math.max(1, opts.batchSize);
  }
}
