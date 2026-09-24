import type { ArticleContext } from '../articles/link-metadata';
import type { Assignment, RawBookmark } from '../types';
import { buildPrompt, parseAssignments } from './prompt';

/**
 * A function that runs a single prompt against an LLM and returns its raw text
 * response.
 *
 * This is the narrow, provider-agnostic port every LLM feature consumes. Real
 * runners are built from a provider adapter via `toRunner` (`src/llm/runner.ts`);
 * tests inject a plain fake (no network, no subscription usage).
 */
export type LlmRunner = (prompt: string) => Promise<string>;

export interface CategorizerOptions {
  model: string;
  maxDepth: number;
}

/**
 * Turns a batch of bookmarks into category assignments against the current tree.
 * The ingestion loop depends on this interface so a fake can be injected in
 * tests with no network and no subscription usage.
 *
 * Filing never creates a category: the tree is fixed by pass 1 before any
 * batch is filed, and a path that is not on it resolves to `Uncategorized`.
 */
export interface BatchCategorizer {
  categorizeBatch(
    bookmarks: RawBookmark[],
    treeText: string,
    articleContext?: Map<string, ArticleContext>,
  ): Promise<Assignment[]>;
}

/**
 * Turns batches of bookmarks into category assignments by prompting an LLM.
 * Pure orchestration around an injected {@link LlmRunner}.
 */
export class Categorizer implements BatchCategorizer {
  constructor(
    private readonly runner: LlmRunner,
    private readonly options: CategorizerOptions,
  ) {}

  /**
   * Categorize a batch of bookmarks against the fixed tree (rendered as
   * text). Returns one assignment per bookmark the model classified.
   */
  async categorizeBatch(
    bookmarks: RawBookmark[],
    treeText: string,
    articleContext?: Map<string, ArticleContext>,
  ): Promise<Assignment[]> {
    if (bookmarks.length === 0) return [];
    const prompt = buildPrompt(bookmarks, treeText, this.options.maxDepth, articleContext);
    const response = await this.runner(prompt);
    const validIds = new Set(bookmarks.map((b) => b.postId));
    return parseAssignments(response, validIds, this.options.maxDepth);
  }
}
