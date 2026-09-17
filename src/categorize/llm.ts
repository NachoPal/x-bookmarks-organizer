import type { ArticleContext } from '../articles/link-metadata';
import type { Assignment, RawBookmark } from '../types';
import { buildExtendPrompt, buildPrompt, parseAssignments } from './prompt';

/**
 * How the assignment pass treats the tree it is given:
 * - `strict`: the tree is fixed (designed by pass 1); off-tree paths are dropped.
 * - `extend`: incremental runs may create a new node when nothing existing fits.
 */
export type AssignMode = 'strict' | 'extend';

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
 */
export interface BatchCategorizer {
  categorizeBatch(
    bookmarks: RawBookmark[],
    treeText: string,
    mode?: AssignMode,
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
   * Categorize a batch of bookmarks against the current tree (rendered as
   * text). Returns one assignment per bookmark the model classified. `mode`
   * selects the strict (fixed-tree) or extend (reuse-or-create) prompt.
   */
  async categorizeBatch(
    bookmarks: RawBookmark[],
    treeText: string,
    mode: AssignMode = 'strict',
    articleContext?: Map<string, ArticleContext>,
  ): Promise<Assignment[]> {
    if (bookmarks.length === 0) return [];
    const prompt =
      mode === 'extend'
        ? buildExtendPrompt(bookmarks, treeText, this.options.maxDepth, articleContext)
        : buildPrompt(bookmarks, treeText, this.options.maxDepth, articleContext);
    const response = await this.runner(prompt);
    const validIds = new Set(bookmarks.map((b) => b.postId));
    return parseAssignments(response, validIds, this.options.maxDepth);
  }
}
