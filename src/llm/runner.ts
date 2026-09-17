import type { LlmRunner } from '../categorize/llm';
import type { LlmClient } from './types';

/**
 * Adapt a provider client to the narrow {@link LlmRunner} port the feature code
 * already consumes.
 *
 * This is the whole reason the abstraction is additive: `Categorizer`,
 * `LlmTaxonomyDesigner` and `LlmSummaryGenerator` keep depending on
 * `(prompt) => Promise<string>` and need no changes, and their tests keep
 * injecting a plain fake function.
 */
export function toRunner(client: LlmClient, opts: { json?: boolean } = {}): LlmRunner {
  return async (prompt: string) => {
    const result = await client.complete({
      prompt,
      responseFormat: opts.json ? 'json' : 'text',
    });
    return result.text;
  };
}
