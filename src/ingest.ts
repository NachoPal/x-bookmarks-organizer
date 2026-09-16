import type { Database } from './db/database';
import type { XClient } from './x/client';
import type { AssignMode, BatchCategorizer } from './categorize/llm';
import type { TaxonomyDesigner } from './categorize/taxonomy';
import { buildCategoryTree, materializeTaxonomy, renderTreeForPrompt } from './categorize/tree';
import type { Assignment, RawBookmark } from './types';

/** Root node used when the LLM finds no fitting category, so everything is filed. */
const FALLBACK_CATEGORY = 'Uncategorized';

/** Text used for the "existing tree" section when no categories exist yet. */
const EMPTY_TREE_TEXT = '(no categories yet)';

export interface IngestDeps {
  db: Database;
  client: XClient;
  /** Pass 1: holistic taxonomy design (Opus-class, high effort). */
  taxonomer: TaxonomyDesigner;
  /** Pass 2: assignment into the finished tree (Haiku-class). */
  categorizer: BatchCategorizer;
  batchSize: number;
  maxDepth: number;
  /** Safety bound on pages fetched per run. */
  maxPages?: number;
  logger?: (message: string) => void;
}

export interface IngestSummary {
  newBookmarks: number;
  batches: number;
  nodesCreated: number;
}

export interface RecategorizeDeps {
  db: Database;
  taxonomer: TaxonomyDesigner;
  categorizer: BatchCategorizer;
  batchSize: number;
  maxDepth: number;
  logger?: (message: string) => void;
}

export interface RecategorizeSummary {
  bookmarks: number;
  batches: number;
  nodesCreated: number;
}

/**
 * Walk the bookmarks timeline (newest bookmark-time first) collecting bookmarks
 * not yet stored, stopping as soon as an already-seen bookmark appears - because
 * the timeline is ordered by bookmark time, everything after that point is older
 * and already processed. Returns the new bookmarks (newest first) and the id at
 * the very top of the list as the marker for observability.
 */
export async function collectNewBookmarks(
  client: XClient,
  knownPostIds: Set<string>,
  maxPages = 50,
): Promise<{ newBookmarks: RawBookmark[]; newestPostId?: string }> {
  const newBookmarks: RawBookmark[] = [];
  let token: string | undefined;
  let newestPostId: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    const { bookmarks, nextToken } = await client.fetchBookmarksPage(token);
    if (bookmarks.length === 0) break;
    if (page === 0) newestPostId = bookmarks[0]?.postId;

    let hitSeen = false;
    for (const bm of bookmarks) {
      if (knownPostIds.has(bm.postId)) {
        hitSeen = true;
        break;
      }
      newBookmarks.push(bm);
    }
    if (hitSeen || !nextToken) break;
    token = nextToken;
  }

  return { newBookmarks, newestPostId };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Maps one assignment path (root -> leaf) to a leaf category id, or undefined
 * when the path cannot/should not resolve to a node.
 */
type PathResolver = (
  db: Database,
  path: string[],
  maxDepth: number,
  when: string,
) => number | undefined;

/**
 * Resolve a single category path (root -> leaf) to the leaf node id WITHOUT
 * creating anything: every segment must already exist in the (designed) tree.
 * Off-tree paths resolve to undefined so they fall back to `Uncategorized`
 * rather than minting ad-hoc nodes that would defeat the holistic taxonomy.
 * Used by the first run and by `recategorize`, where the tree is fixed.
 */
const resolveExistingPathToLeafId: PathResolver = (db, path, maxDepth) => {
  const capped = path.slice(0, maxDepth);
  let parentId: number | null = null;
  let leafId: number | undefined;
  for (const name of capped) {
    const node = db.findCategory(name, parentId);
    if (!node) return undefined;
    parentId = node.id;
    leafId = node.id;
  }
  return leafId;
};

/**
 * Resolve a single category path (root -> leaf) to the leaf node id, CREATING
 * any missing segments (capped at `maxDepth`). Used by incremental runs that
 * extend an existing tree: the model may reuse existing nodes or introduce a new
 * one when nothing fits (reuse-or-create).
 */
const resolveOrCreatePathToLeafId: PathResolver = (db, path, maxDepth, when) => {
  const capped = path.slice(0, maxDepth);
  let parentId: number | null = null;
  let leafId: number | undefined;
  for (const name of capped) {
    const node = db.getOrCreateCategory(name, parentId, when);
    parentId = node.id;
    leafId = node.id;
  }
  return leafId;
};

/**
 * Build the resolver passed to `storeCategorizedBatch`: map a bookmark to the
 * leaf ids it was assigned to (via `resolvePath`), falling back to
 * `Uncategorized` when the model returned nothing that resolves.
 */
function makeResolver(
  db: Database,
  byPostId: Map<string, string[][]>,
  maxDepth: number,
  when: string,
  resolvePath: PathResolver,
) {
  return (bm: RawBookmark): number[] => {
    const paths = byPostId.get(bm.postId) ?? [];
    const ids = new Set<number>();
    for (const path of paths) {
      const id = resolvePath(db, path, maxDepth, when);
      if (id !== undefined) ids.add(id);
    }
    if (ids.size === 0) {
      ids.add(db.getOrCreateCategory(FALLBACK_CATEGORY, null, when).id);
    }
    return [...ids];
  };
}

/** Index a batch of assignments by post id for O(1) lookup during storage. */
function indexAssignments(assignments: Assignment[]): Map<string, string[][]> {
  const byPostId = new Map<string, string[][]>();
  for (const a of assignments) byPostId.set(a.postId, a.categories);
  return byPostId;
}

/**
 * Full incremental run. The expensive holistic taxonomy-design pass runs ONLY on
 * the first run (empty tree); once a tree exists, incremental runs skip it to
 * conserve subscription quota:
 *
 *   - First run (no categories yet): pass 1 designs a genuinely nested tree over
 *     ALL newly-collected bookmarks at once, then the assignment pass files each
 *     bookmark strictly into that fixed tree (off-tree paths -> `Uncategorized`).
 *   - Incremental run (tree already exists): SKIP the taxonomy designer entirely
 *     and never re-touch already-stored bookmarks. The assignment pass files the
 *     NEW bookmarks into the existing tree, reusing nodes and creating a new one
 *     only when a bookmark fits nothing (reuse-or-create). A full holistic
 *     redesign is available on demand via `recategorize`.
 *
 * Either way a bookmark may be filed under several branches; anything that fits
 * nothing lands in `Uncategorized`. Each assignment batch is stored atomically
 * with its category links, so a bookmark is only marked "seen" once stored with
 * categories: an interrupted run simply retries the unstored bookmarks next time
 * (idempotent).
 */
export async function runIngest(deps: IngestDeps): Promise<IngestSummary> {
  const { db, client, taxonomer, categorizer, batchSize, maxDepth } = deps;
  const log = deps.logger ?? (() => {});

  const known = db.getKnownPostIds();
  const { newBookmarks, newestPostId } = await collectNewBookmarks(
    client,
    known,
    deps.maxPages ?? 50,
  );

  const nodesBefore = db.getAllCategories().length;

  if (newBookmarks.length === 0) {
    if (newestPostId) db.setNewestSeenPostId(newestPostId);
    log('No new bookmarks since last run.');
    return { newBookmarks: 0, batches: 0, nodesCreated: 0 };
  }

  // Oldest-first so assignment batches read in bookmark order.
  const ordered = [...newBookmarks].reverse();
  log(`Found ${ordered.length} new bookmark(s).`);

  const when = new Date().toISOString();
  let mode: AssignMode;
  let resolvePath: PathResolver;

  if (nodesBefore === 0) {
    // First run: design the taxonomy holistically over all new bookmarks, then
    // file strictly into the fixed tree.
    log('Designing taxonomy (pass 1)...');
    const taxonomy = await taxonomer.designTaxonomy(ordered, EMPTY_TREE_TEXT);
    materializeTaxonomy(db, taxonomy, maxDepth, when);
    mode = 'strict';
    resolvePath = resolveExistingPathToLeafId;
  } else {
    // Incremental run: a tree already exists. Skip the taxonomy designer and
    // extend the existing tree via the cheap assignment pass over ONLY the new
    // bookmarks (reuse existing nodes; create one only when nothing fits).
    log('Existing taxonomy found; extending it via the assignment pass.');
    mode = 'extend';
    resolvePath = resolveOrCreatePathToLeafId;
  }

  const treeText = renderTreeForPrompt(buildCategoryTree(db));

  const batches = chunk(ordered, batchSize);
  log(`Assigning ${ordered.length} bookmark(s) into the tree in ${batches.length} batch(es).`);
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i]!;
    const assignments = await categorizer.categorizeBatch(batch, treeText, mode);
    const byPostId = indexAssignments(assignments);
    db.storeCategorizedBatch(batch, makeResolver(db, byPostId, maxDepth, when, resolvePath), when);
    log(`Stored batch ${i + 1}/${batches.length} (${batch.length} bookmark(s)).`);
  }

  if (newestPostId) db.setNewestSeenPostId(newestPostId);

  const nodesCreated = db.getAllCategories().length - nodesBefore;
  return { newBookmarks: ordered.length, batches: batches.length, nodesCreated };
}

/**
 * Re-categorize every already-stored bookmark from scratch: drop the current
 * (possibly shallow) taxonomy and rebuild it holistically over ALL stored
 * bookmarks, then reassign them. Bookmarks themselves - including read state and
 * read dates - are never touched. Lets the owner redo a shallow first run
 * without re-fetching from X.
 */
export async function recategorizeAll(deps: RecategorizeDeps): Promise<RecategorizeSummary> {
  const { db, taxonomer, categorizer, batchSize, maxDepth } = deps;
  const log = deps.logger ?? (() => {});

  const bookmarks = db.getAllBookmarks();
  if (bookmarks.length === 0) {
    log('No stored bookmarks to re-categorize.');
    return { bookmarks: 0, batches: 0, nodesCreated: 0 };
  }

  log(`Re-categorizing ${bookmarks.length} stored bookmark(s).`);

  // Pass 1: design the taxonomy from scratch over all stored bookmarks BEFORE
  // touching the DB. designTaxonomy throws on a malformed LLM response, so
  // clearing first would risk wiping the existing taxonomy with nothing to
  // replace it; only clear once the new taxonomy is in hand.
  log('Designing taxonomy (pass 1)...');
  const taxonomy = await taxonomer.designTaxonomy(bookmarks, EMPTY_TREE_TEXT);
  const when = new Date().toISOString();
  db.clearCategories();
  materializeTaxonomy(db, taxonomy, maxDepth, when);
  const treeText = renderTreeForPrompt(buildCategoryTree(db));

  // Pass 2: reassign every bookmark into the finished tree, in batches. Reusing
  // storeCategorizedBatch is safe: the bookmark rows already exist (insert is a
  // no-op via ON CONFLICT), so only the fresh category links are written.
  const batches = chunk(bookmarks, batchSize);
  log(`Assigning ${bookmarks.length} bookmark(s) into the tree in ${batches.length} batch(es) (pass 2).`);
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i]!;
    const assignments = await categorizer.categorizeBatch(batch, treeText, 'strict');
    const byPostId = indexAssignments(assignments);
    db.storeCategorizedBatch(
      batch,
      makeResolver(db, byPostId, maxDepth, when, resolveExistingPathToLeafId),
      when,
    );
    log(`Reassigned batch ${i + 1}/${batches.length} (${batch.length} bookmark(s)).`);
  }

  const nodesCreated = db.getAllCategories().length;
  return { bookmarks: bookmarks.length, batches: batches.length, nodesCreated };
}
