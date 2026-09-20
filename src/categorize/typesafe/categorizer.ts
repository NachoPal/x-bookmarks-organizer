/**
 * `TypeSafeCategorizer` - the opt-in pass-2 assignment categorizer (issue #61).
 *
 * It implements the SAME `BatchCategorizer` interface as the LLM `Categorizer`,
 * which is why `src/ingest.ts` needs no changes at all: the ingestion loop
 * already injects this seam. The two differ only in how a bookmark is placed:
 *
 * - The LLM renders the whole tree into one prompt and parses a path back out
 *   of free text, defending against invented nodes and malformed JSON.
 * - This walks the tree one level at a time (`walk.ts`), building the path in
 *   code from real DB nodes. Off-tree paths are structurally impossible, so
 *   there is nothing to parse and nothing to repair.
 *
 * `treeText` is accepted (the interface supplies it) and deliberately ignored:
 * this reads the real tree from the database, which is also what gives it node
 * ids and descriptions the rendered text does not carry.
 *
 * Pass 1 (taxonomy design) is untouched and stays on Claude - Jev invents no
 * labels. Two behaviours cover what it therefore cannot do on its own:
 *
 * - **Confidence-gated fallback.** A descent cut short by low confidence
 *   reports the last confident ANCESTOR ("AI > Harnesses") instead of guessing
 *   a leaf or dumping the bookmark in the flat `Uncategorized` bucket.
 * - **Hybrid `extend`.** A bookmark the walk cannot place anywhere is routed,
 *   alone, to the injected LLM categorizer in `extend` mode to propose a new
 *   node. Jev is the high-precision filter; the LLM handles only the genuinely
 *   novel tail.
 */
import type { EntryType, JsonValue } from '@typesafe-ai/sdk';
import type { ArticleContext } from '../../articles/link-metadata';
import type { Database } from '../../db/database';
import type { Assignment, CategoryTreeNode, RawBookmark } from '../../types';
import type { AssignMode, BatchCategorizer } from '../llm';
import { buildCategoryTree } from '../tree';
import type { LevelAsker } from './client';
import { DEFAULT_WALK_OPTIONS, walkTree, type WalkOptions, type WalkTreeNode } from './walk';

/** Text budget for the post body placed in the state. Mirrors the LLM prompt's. */
const MAX_TEXT_CHARS = 500;

/** Text budget for the linked article's title+description in the state. */
const MAX_ARTICLE_CHARS = 300;

export interface TypeSafeCategorizerOptions extends WalkOptions {
  /** How many bookmarks to walk at once. Each is independent, so this is pure throughput. */
  concurrency: number;
}

export const DEFAULT_TYPESAFE_OPTIONS: TypeSafeCategorizerOptions = {
  ...DEFAULT_WALK_OPTIONS,
  concurrency: 8,
};

export interface TypeSafeCategorizerDeps {
  /** The real tree lives here - node ids, names and descriptions. */
  db: Database;
  /** Answers one batched frontier of level questions. The offline test seam. */
  asker: LevelAsker;
  /**
   * The existing LLM categorizer, used ONLY for bookmarks the walk could not
   * place, and only in `extend` mode (where inventing a node is allowed).
   * Omitted, an unplaceable bookmark simply falls through to `Uncategorized`
   * exactly as today.
   */
  extendFallback?: BatchCategorizer;
  logger?: (message: string) => void;
}

/**
 * The structured `state` one bookmark is classified against.
 *
 * Named, self-describing parts rather than a flat blob: TypeSafe accepts a JSON
 * object as state, and naming each piece means the model never has to guess
 * what a span of text represents.
 */
export function buildBookmarkState(
  bookmark: RawBookmark,
  articleContext?: Map<string, ArticleContext>,
): EntryType {
  const state: Record<string, JsonValue> = {
    author: `@${bookmark.authorUsername}`,
    post_text: bookmark.text.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_CHARS),
  };
  const article = articleContext?.get(bookmark.postId);
  if (article) {
    const combined = article.description ? `${article.title} - ${article.description}` : article.title;
    state.linked_article = combined.replace(/\s+/g, ' ').trim().slice(0, MAX_ARTICLE_CHARS);
  }
  return state;
}

/** Project the counted viewer tree onto the minimal shape the walk needs. */
export function toWalkTree(roots: CategoryTreeNode[]): WalkTreeNode[] {
  return roots.map((node) => ({
    id: node.id,
    name: node.name,
    description: node.description ?? null,
    children: toWalkTree(node.children),
  }));
}

/** Run `task` over `items` with at most `limit` in flight, preserving order. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await task(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}

export class TypeSafeCategorizer implements BatchCategorizer {
  private readonly options: TypeSafeCategorizerOptions;
  private readonly log: (message: string) => void;

  constructor(
    private readonly deps: TypeSafeCategorizerDeps,
    options: Partial<TypeSafeCategorizerOptions> = {},
  ) {
    this.options = { ...DEFAULT_TYPESAFE_OPTIONS, ...options };
    this.log = deps.logger ?? (() => {});
  }

  /**
   * Walk each bookmark down the current tree and return the same
   * `Assignment[]` shape the LLM categorizer returns, so the caller cannot
   * tell which one ran.
   *
   * A bookmark with no returned assignment is left out entirely, which is
   * exactly how `makeResolver` in `src/ingest.ts` already routes it to
   * `Uncategorized` - so the strict path degrades to today's behaviour rather
   * than inventing anything.
   */
  async categorizeBatch(
    bookmarks: RawBookmark[],
    treeText: string,
    mode: AssignMode = 'strict',
    articleContext?: Map<string, ArticleContext>,
  ): Promise<Assignment[]> {
    if (bookmarks.length === 0) return [];

    // Read the real tree per batch: an `extend` batch must see nodes that an
    // earlier batch's LLM fallback created.
    const roots = toWalkTree(buildCategoryTree(this.deps.db));
    if (roots.length === 0) {
      // Nothing to file into. Hand the whole batch to the LLM when it is
      // allowed to build, otherwise let it fall through to `Uncategorized`.
      return this.runFallback(bookmarks, treeText, mode, articleContext);
    }

    const walked = await mapWithConcurrency(bookmarks, this.options.concurrency, async (bookmark) => {
      const state = buildBookmarkState(bookmark, articleContext);
      const result = await walkTree(
        roots,
        (levels) => this.deps.asker.ask(state, levels),
        this.options,
      );
      return { bookmark, result };
    });

    const assignments: Assignment[] = [];
    const unplaced: RawBookmark[] = [];
    let parentFallbacks = 0;

    for (const { bookmark, result } of walked) {
      if (result.paths.length === 0) {
        unplaced.push(bookmark);
        continue;
      }
      if (result.paths.some((p) => !p.confident)) parentFallbacks++;
      assignments.push({
        postId: bookmark.postId,
        categories: result.paths.map((p) => p.nodes.map((n) => n.name)),
      });
    }

    if (parentFallbacks > 0) {
      this.log(
        `TypeSafe: ${parentFallbacks} bookmark(s) filed at a confident parent category rather than a guessed leaf.`,
      );
    }

    if (unplaced.length > 0) {
      this.log(`TypeSafe: ${unplaced.length} bookmark(s) fit nothing in the tree.`);
      assignments.push(...(await this.runFallback(unplaced, treeText, mode, articleContext)));
    }

    return assignments;
  }

  /**
   * Route bookmarks the walk could not place to the LLM categorizer.
   *
   * Only in `extend` mode: that is the one mode where creating a new node is
   * permitted, and inventing nodes is the only thing the LLM can do here that
   * the walk cannot. In `strict` mode the tree is fixed by pass 1, so an
   * unplaceable bookmark correctly falls through to `Uncategorized`.
   */
  private async runFallback(
    bookmarks: RawBookmark[],
    treeText: string,
    mode: AssignMode,
    articleContext?: Map<string, ArticleContext>,
  ): Promise<Assignment[]> {
    const { extendFallback } = this.deps;
    if (bookmarks.length === 0 || mode !== 'extend' || !extendFallback) return [];
    this.log(`Routing ${bookmarks.length} bookmark(s) to the LLM to propose a new category.`);
    return extendFallback.categorizeBatch(bookmarks, treeText, 'extend', articleContext);
  }
}
