import type { Database } from './db/database';
import type { XClient } from './x/client';
import type { BatchCategorizer } from './categorize/llm';
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
 * Resolve a single category path (root -> leaf) to the leaf node id WITHOUT
 * creating anything: every segment must already exist in the (designed) tree.
 * Off-tree paths resolve to undefined so they fall back to `Uncategorized`
 * rather than minting ad-hoc nodes that would defeat the holistic taxonomy.
 */
function resolveExistingPathToLeafId(
  db: Database,
  path: string[],
  maxDepth: number,
): number | undefined {
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
}

/**
 * Build the resolver passed to `storeCategorizedBatch`: map a bookmark to the
 * designed-tree leaf ids it was assigned to, falling back to `Uncategorized`
 * when the model returned nothing that fits the tree.
 */
function makeResolver(
  db: Database,
  byPostId: Map<string, string[][]>,
  maxDepth: number,
  when: string,
) {
  return (bm: RawBookmark): number[] => {
    const paths = byPostId.get(bm.postId) ?? [];
    const ids = new Set<number>();
    for (const path of paths) {
      const id = resolveExistingPathToLeafId(db, path, maxDepth);
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
 * Full incremental run, in two passes:
 *
 *   1. Taxonomy design (holistic): show the model ALL newly-collected bookmarks
 *      at once and have it design a genuinely nested tree, seeded with any
 *      existing tree so incremental runs extend rather than churn it.
 *   2. Assignment: file each bookmark into that finished tree (multi-category
 *      preserved; anything that fits nothing lands in `Uncategorized`).
 *
 * Each assignment batch is stored atomically with its category links, so a
 * bookmark is only marked "seen" once stored with categories: an interrupted
 * run simply retries the unstored bookmarks next time (idempotent).
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

  // Pass 1: design the taxonomy holistically over all new bookmarks.
  const existingTreeText = renderTreeForPrompt(buildCategoryTree(db));
  log('Designing taxonomy (pass 1)...');
  const taxonomy = await taxonomer.designTaxonomy(ordered, existingTreeText);
  const when = new Date().toISOString();
  materializeTaxonomy(db, taxonomy, maxDepth, when);
  const treeText = renderTreeForPrompt(buildCategoryTree(db));

  // Pass 2: assign each bookmark into the finished tree, in batches.
  const batches = chunk(ordered, batchSize);
  log(`Assigning ${ordered.length} bookmark(s) into the tree in ${batches.length} batch(es) (pass 2).`);
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i]!;
    const assignments = await categorizer.categorizeBatch(batch, treeText);
    const byPostId = indexAssignments(assignments);
    db.storeCategorizedBatch(batch, makeResolver(db, byPostId, maxDepth, when), when);
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
  db.clearCategories();

  // Pass 1: design the taxonomy from scratch over all stored bookmarks.
  log('Designing taxonomy (pass 1)...');
  const taxonomy = await taxonomer.designTaxonomy(bookmarks, EMPTY_TREE_TEXT);
  const when = new Date().toISOString();
  materializeTaxonomy(db, taxonomy, maxDepth, when);
  const treeText = renderTreeForPrompt(buildCategoryTree(db));

  // Pass 2: reassign every bookmark into the finished tree, in batches. Reusing
  // storeCategorizedBatch is safe: the bookmark rows already exist (insert is a
  // no-op via ON CONFLICT), so only the fresh category links are written.
  const batches = chunk(bookmarks, batchSize);
  log(`Assigning ${bookmarks.length} bookmark(s) into the tree in ${batches.length} batch(es) (pass 2).`);
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i]!;
    const assignments = await categorizer.categorizeBatch(batch, treeText);
    const byPostId = indexAssignments(assignments);
    db.storeCategorizedBatch(batch, makeResolver(db, byPostId, maxDepth, when), when);
    log(`Reassigned batch ${i + 1}/${batches.length} (${batch.length} bookmark(s)).`);
  }

  const nodesCreated = db.getAllCategories().length;
  return { bookmarks: bookmarks.length, batches: batches.length, nodesCreated };
}
