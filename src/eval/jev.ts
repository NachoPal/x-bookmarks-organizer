/**
 * The TypeSafe/Jev half of the categorizer comparison.
 *
 * It does NOT wrap `TypeSafeCategorizer`, and that is deliberate rather than a
 * shortcut: the comparison needs per-bookmark confidence and the "stopped at a
 * confident ancestor" flag, and `BatchCategorizer` returns a bare
 * `Assignment[]` that has thrown both away by design. So this composes the
 * exact same pieces the categorizer composes - `buildBookmarkState`,
 * `toWalkTree` and the pure `walkTree` - and keeps the richer `WalkResult`.
 *
 * In `strict` mode (which is all the eval ever uses, because the tree is fixed
 * by pass 1) that composition is behaviourally identical to
 * `TypeSafeCategorizer.categorizeBatch`: its only other behaviour is the
 * `extend`-mode LLM fallback for unplaceable bookmarks, which `strict` mode
 * already turns into a no-op. Nothing in the live categorization path is
 * touched, read or re-implemented.
 */
import type { EntryType, Fetch } from '@typesafe-ai/sdk';
import type { ArticleContext } from '../articles/link-metadata';
import { buildBookmarkState, toWalkTree } from '../categorize/typesafe/categorizer';
import type { LevelAsker } from '../categorize/typesafe/client';
import { walkTree, type WalkOptions } from '../categorize/typesafe/walk';
import type { CategoryTreeNode, RawBookmark } from '../types';

/** What a comparison run cost on the Jev side, as the API itself reported it. */
export interface JevUsage {
  /** HTTP requests actually issued, retries included. One per tree level per bookmark. */
  requests: number;
  /** Input tokens billed, summed over every response that reported a usage block. */
  inputTokens: number;
}

/** A fresh, zeroed usage tally. */
export function newJevUsage(): JevUsage {
  return { requests: 0, inputTokens: 0 };
}

/**
 * Wrap a `Fetch` so every TypeSafe response's reported `usage.input_tokens` is
 * added to `usage`.
 *
 * Metering here rather than in `TypeSafeLevelAsker` keeps the live categorizer
 * untouched: the SDK's injectable transport is already the seam the asker
 * exposes, and it is also the seam every offline test drives, so the eval's
 * cost reporting is exercised without a network call or a cent of spend.
 *
 * The body is read from a CLONE - the SDK still has to consume the original -
 * and a response that is not JSON, or carries no usage block, simply bills
 * nothing we can attribute rather than failing the run.
 */
export function meteringFetch(inner: Fetch, usage: JevUsage): Fetch {
  return async (input, init) => {
    const response = await inner(input, init);
    usage.requests++;
    try {
      const body = (await response.clone().json()) as { usage?: { input_tokens?: unknown } } | null;
      const tokens = body?.usage?.input_tokens;
      if (typeof tokens === 'number' && Number.isFinite(tokens)) usage.inputTokens += tokens;
    } catch {
      // Unreadable body: nothing to attribute, and nothing worth failing over.
    }
    return response;
  };
}

/** One path Jev filed a bookmark under, carried with the evidence behind it. */
export interface JevPath {
  /** Real category ids from the eval tree, root -> leaf. */
  nodeIds: number[];
  /** The same nodes' names, root -> leaf. */
  names: string[];
  /** Length-normalized geometric mean of the edge probabilities, 0..1. */
  score: number;
  /** False when this path is the last CONFIDENT ancestor, not a node the walk reached. */
  confident: boolean;
}

/** How Jev filed one bookmark. */
export interface JevFiling {
  postId: string;
  /** Best first. Empty when the walk placed the bookmark nowhere. */
  paths: JevPath[];
  /** True when at least one kept path was cut short by low confidence. */
  earlyStopped: boolean;
  /** True when not even the root level was answered confidently. */
  unresolved: boolean;
  /** The error that ended this bookmark's walk, redacted by the client. */
  error?: string;
}

/**
 * Run `task` over `items` with at most `limit` in flight, preserving order.
 *
 * Local, like the ranker's equivalent and for the same reason: the
 * categorizer's copy is private to its module, and lifting it out would mean
 * editing the live categorization path this feature has no business touching.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await task(items[i]!);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface FileWithJevOptions extends WalkOptions {
  concurrency: number;
}

/**
 * File every bookmark into `tree` with the Jev beam walk, keeping the
 * confidence the walk reported.
 *
 * A bookmark whose walk throws is reported as an errored filing rather than
 * aborting the run: a comparison over most of the library still answers the
 * owner's question, and the report says how many failed.
 */
export async function fileWithJev(
  bookmarks: RawBookmark[],
  tree: CategoryTreeNode[],
  asker: LevelAsker,
  options: FileWithJevOptions,
  articleContext?: Map<string, ArticleContext>,
): Promise<JevFiling[]> {
  const roots = toWalkTree(tree);
  if (bookmarks.length === 0 || roots.length === 0) {
    return bookmarks.map((bm) => ({ postId: bm.postId, paths: [], earlyStopped: false, unresolved: true }));
  }

  return mapWithConcurrency(bookmarks, options.concurrency, async (bookmark) => {
    const state: EntryType = buildBookmarkState(bookmark, articleContext);
    try {
      const result = await walkTree(roots, (levels) => asker.ask(state, levels), options);
      return {
        postId: bookmark.postId,
        paths: result.paths.map((p) => ({
          nodeIds: p.nodes.map((n) => n.id),
          names: p.nodes.map((n) => n.name),
          score: p.score,
          confident: p.confident,
        })),
        earlyStopped: result.paths.some((p) => !p.confident),
        unresolved: result.unresolved,
      };
    } catch (err) {
      return {
        postId: bookmark.postId,
        paths: [],
        earlyStopped: false,
        unresolved: true,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });
}
