import type { Database } from './db/database';
import type { XClient } from './x/client';
import type { AssignMode, BatchCategorizer } from './categorize/llm';
import type { TaxonomyDesigner } from './categorize/taxonomy';
import {
  buildCategoryTree,
  findMergeTarget,
  materializeTaxonomy,
  pruneToProtected,
  renderTreeForPrompt,
} from './categorize/tree';
import { findOwnerAnchor, stripOwnerMarker } from './categorize/owner-categories';
import { buildArticleContext } from './articles/link-metadata';
import { HttpArticleFetcher, type ArticleFetcher } from './articles/fetch-article';
import type { Assignment, RawBookmark } from './types';

/** Root node used when the LLM finds no fitting category, so everything is filed. */
const FALLBACK_CATEGORY = 'Uncategorized';

/**
 * Whether the next sync designs a taxonomy (pass 1) before filing: true until
 * the passes have built one. Only GENERATED categories count - the owner's own
 * (added in the category editor before the first sync) are anchors the first
 * design is built around, not a tree that makes the design unnecessary.
 */
export function needsTaxonomyDesign(db: Database): boolean {
  return !db.hasGeneratedCategories();
}

export interface IngestDeps {
  db: Database;
  client: XClient;
  /** Pass 1: holistic taxonomy design (Opus-class, medium effort by default). */
  taxonomer: TaxonomyDesigner;
  /** Pass 2: assignment into the finished tree (Haiku-class). */
  categorizer: BatchCategorizer;
  batchSize: number;
  maxDepth: number;
  /** Safety bound on pages fetched per run. */
  maxPages?: number;
  /**
   * Fetches a link post's linked article title/description, fed into both
   * categorization passes (issue #25). Injectable so tests can fake the
   * network fetch; defaults to the real HTTP fetcher, mirroring the reader
   * view's `ServerOptions.articleFetcher` seam.
   */
  articleFetcher?: ArticleFetcher;
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
  /** Same seam as {@link IngestDeps.articleFetcher} - see there. */
  articleFetcher?: ArticleFetcher;
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
export type PathResolver = (
  db: Database,
  path: string[],
  maxDepth: number,
  when: string,
) => number | undefined;

/** A model-written path, minus copied `[owner]` markers and empty segments. */
function cleanPath(path: string[]): string[] {
  return path.map(stripOwnerMarker).filter((name) => name.length > 0);
}

/** Walk `names` down from `parentId` through EXISTING nodes only. */
function walkExisting(db: Database, names: string[], parentId: number | null): number | undefined {
  let leafId: number | undefined;
  for (const name of names) {
    const node = db.findCategory(name, parentId);
    if (!node) return undefined;
    parentId = node.id;
    leafId = node.id;
  }
  return leafId;
}

/**
 * A path that does not resolve as written, rescued when it names one of the
 * owner's categories: the deepest segment that is the (unambiguous) name of
 * an owner category anchors it, and whatever follows is walked from there.
 * The model placed the bookmark INSIDE the owner's category, just under a
 * wrong prefix ("Programming > Rust" for the owner's root "Rust") or a
 * sub-node that does not exist - filing it in the owner's category honours
 * what the model decided, where `Uncategorized` would throw it away.
 */
function resolveViaOwnerAnchor(db: Database, names: string[]): number | undefined {
  for (let i = names.length - 1; i >= 0; i--) {
    const anchor = findOwnerAnchor(db, names[i]!);
    if (!anchor) continue;
    return walkExisting(db, names.slice(i + 1), anchor.id) ?? anchor.id;
  }
  return undefined;
}

/**
 * Resolve a single category path (root -> leaf) to the leaf node id WITHOUT
 * creating anything: every segment must already exist in the (designed) tree.
 * Off-tree paths resolve to undefined so they fall back to `Uncategorized`
 * rather than minting ad-hoc nodes that would defeat the holistic taxonomy -
 * unless the path names one of the owner's categories, which is always a
 * valid target (see `resolveViaOwnerAnchor`).
 * Used by the first run and by `recategorize`, where the tree is fixed.
 *
 * Exported for the categorizer comparison (`src/eval/`), which must decide
 * "is this path on the tree?" the exact same way a real strict run does -
 * including the case-insensitive sibling matching - or its agreement numbers
 * would be measuring its own resolver rather than the two filing methods.
 */
export const resolveExistingPathToLeafId: PathResolver = (db, path, maxDepth) => {
  const names = cleanPath(path).slice(0, maxDepth);
  if (names.length === 0) return undefined;
  return walkExisting(db, names, null) ?? resolveViaOwnerAnchor(db, names);
};

/** How deep `id` sits (a root is 0), for a path re-anchored mid-tree. */
function depthOf(db: Database, id: number): number {
  let depth = 0;
  for (let node = db.getCategoryById(id); node?.parentId != null; node = db.getCategoryById(node.parentId)) depth++;
  return depth;
}

/**
 * Resolve a single category path (root -> leaf) to the leaf node id, CREATING
 * any missing segments. Used by incremental runs that extend an existing
 * tree: the model may reuse existing nodes or introduce a new one when nothing
 * fits (reuse-or-create).
 *
 * Reuse comes first, and it includes the owner's categories under a name that
 * only NEARLY matches (`findMergeTarget`): "LLM" next to the owner's "LLMs"
 * files into theirs rather than minting a twin, and a path that starts at an
 * owner category the model re-rooted continues from where it really is. A new
 * node is never created at or below `maxDepth`; the deepest reachable node
 * takes the bookmark instead.
 */
const resolveOrCreatePathToLeafId: PathResolver = (db, path, maxDepth, when) => {
  const names = cleanPath(path);
  let parentId: number | null = null;
  let depth = 0; // depth the NEXT segment would sit at
  let leafId: number | undefined;
  for (const [i, name] of names.entries()) {
    const existing = findMergeTarget(db, name, parentId, i === 0);
    if (existing) {
      depth = existing.parentId === parentId ? depth + 1 : depthOf(db, existing.id) + 1;
      parentId = existing.id;
      leafId = existing.id;
      continue;
    }
    if (depth >= maxDepth) break;
    const node = db.getOrCreateCategory(name, parentId, when);
    parentId = node.id;
    leafId = node.id;
    depth++;
  }
  return leafId;
};

/**
 * Build the resolver passed to `storeCategorizedBatch`: map a bookmark to the
 * leaf ids it was assigned to (via `resolvePath`), falling back to
 * `Uncategorized` when the model returned nothing that resolves - unless
 * `alreadyFiled` says the bookmark is still filed somewhere (a recategorize
 * keeps its links into the owner's categories), where that would only add a
 * misleading second home.
 */
function makeResolver(
  db: Database,
  byPostId: Map<string, string[][]>,
  maxDepth: number,
  when: string,
  resolvePath: PathResolver,
  alreadyFiled: (bm: RawBookmark) => boolean = () => false,
) {
  return (bm: RawBookmark): number[] => {
    const paths = byPostId.get(bm.postId) ?? [];
    const ids = new Set<number>();
    for (const path of paths) {
      const id = resolvePath(db, path, maxDepth, when);
      if (id !== undefined) ids.add(id);
    }
    if (ids.size === 0 && !alreadyFiled(bm)) {
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
 * the first run (no generated tree yet); once one exists, incremental runs skip
 * it to conserve subscription quota:
 *
 *   - First run (no GENERATED categories yet - see {@link needsTaxonomyDesign}):
 *     pass 1 designs a genuinely nested tree over ALL newly-collected bookmarks
 *     at once, then the assignment pass files each bookmark strictly into that
 *     fixed tree (off-tree paths -> `Uncategorized`). Categories the owner
 *     added by hand before it are fixed anchors: the design is shown them and
 *     builds around and inside them, and materializing merges into them.
 *   - Incremental run (tree already exists): SKIP the taxonomy designer entirely
 *     and never re-touch already-stored bookmarks. The assignment pass files the
 *     NEW bookmarks into the existing tree, reusing nodes and creating a new one
 *     only when a bookmark fits nothing (reuse-or-create). A full holistic
 *     redesign is available on demand via `recategorize`.
 *
 * The owner's categories are never renamed, moved, re-described or deleted by
 * either path - they are filed into, and may gain generated sub-categories.
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
  // The fetch against X succeeded at this point, regardless of whether it
  // turned up anything new - that is what "last synced" means to the owner.
  db.setLastSyncedAt(new Date().toISOString());

  const nodesBefore = db.getAllCategories().length;
  const firstRun = needsTaxonomyDesign(db);

  if (newBookmarks.length === 0) {
    if (newestPostId) db.setNewestSeenPostId(newestPostId);
    log('No new bookmarks since last run.');
    return { newBookmarks: 0, batches: 0, nodesCreated: 0 };
  }

  // Oldest-first so assignment batches read in bookmark order.
  const ordered = [...newBookmarks].reverse();
  log(`Found ${ordered.length} new bookmark(s).`);

  const articleFetcher = deps.articleFetcher ?? new HttpArticleFetcher();
  log('Fetching linked article titles for categorization...');
  const articleContext = await buildArticleContext(ordered, articleFetcher, db);

  const when = new Date().toISOString();
  let mode: AssignMode;
  let resolvePath: PathResolver;

  if (firstRun) {
    // First run: design the taxonomy holistically over all new bookmarks, then
    // file strictly into the fixed tree. The owner's own categories (if they
    // added any before this sync) are the design's fixed anchors.
    const anchors = buildCategoryTree(db);
    log(
      anchors.length > 0
        ? 'Designing taxonomy (pass 1) around the categories you added...'
        : 'Designing taxonomy (pass 1)...',
    );
    const taxonomy = await taxonomer.designTaxonomy(ordered, renderTreeForPrompt(anchors), articleContext);
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

  const batches = chunk(ordered, batchSize);
  log(`Assigning ${ordered.length} bookmark(s) into the tree in ${batches.length} batch(es).`);
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i]!;
    // Re-render per batch so an extend batch sees nodes created by earlier
    // batches and reuses them instead of minting near-duplicate siblings.
    const treeText = renderTreeForPrompt(buildCategoryTree(db));
    const assignments = await categorizer.categorizeBatch(batch, treeText, mode, articleContext);
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
 * (possibly shallow) generated taxonomy and rebuild it holistically over ALL
 * stored bookmarks, then reassign them. Bookmarks themselves - including read
 * state and read dates - are never touched. Lets the owner redo a shallow first
 * run without re-fetching from X.
 *
 * The owner's own categories survive exactly as they are, with the ancestors
 * that hold them in place and the posts already in them
 * (`Database.clearGeneratedCategories`): the new design is built around them
 * as fixed anchors, just like a first sync's, and every bookmark is re-filed
 * into the merged tree.
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

  const articleFetcher = deps.articleFetcher ?? new HttpArticleFetcher();
  log('Fetching linked article titles for categorization...');
  const articleContext = await buildArticleContext(bookmarks, articleFetcher, db);

  // Pass 1: design the taxonomy over all stored bookmarks BEFORE touching the
  // DB. designTaxonomy throws on a malformed LLM response, so clearing first
  // would risk wiping the existing taxonomy with nothing to replace it; only
  // clear once the new taxonomy is in hand. What survives the clear - the
  // owner's categories and their ancestors - is what the design is anchored on.
  const anchors = pruneToProtected(buildCategoryTree(db), db.getProtectedCategoryIds());
  log(
    anchors.length > 0
      ? 'Designing taxonomy (pass 1), keeping your own categories as they are...'
      : 'Designing taxonomy (pass 1)...',
  );
  const taxonomy = await taxonomer.designTaxonomy(bookmarks, renderTreeForPrompt(anchors), articleContext);
  const when = new Date().toISOString();
  db.clearGeneratedCategories();
  materializeTaxonomy(db, taxonomy, maxDepth, when);
  const treeText = renderTreeForPrompt(buildCategoryTree(db));
  // A post still in one of the owner's categories is filed; it only falls
  // back to `Uncategorized` when it has nowhere else at all.
  const keptLinks = db.getCategoryIdsForBookmarks(bookmarks.map((b) => b.id));
  const filedPostIds = new Set(bookmarks.filter((b) => keptLinks.has(b.id)).map((b) => b.postId));
  const alreadyFiled = (bm: RawBookmark) => filedPostIds.has(bm.postId);

  // Pass 2: reassign every bookmark into the finished tree, in batches. Reusing
  // storeCategorizedBatch is safe: the bookmark rows already exist (insert is a
  // no-op via ON CONFLICT), so only the fresh category links are written.
  const batches = chunk(bookmarks, batchSize);
  log(`Assigning ${bookmarks.length} bookmark(s) into the tree in ${batches.length} batch(es) (pass 2).`);
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i]!;
    const assignments = await categorizer.categorizeBatch(batch, treeText, 'strict', articleContext);
    const byPostId = indexAssignments(assignments);
    db.storeCategorizedBatch(
      batch,
      makeResolver(db, byPostId, maxDepth, when, resolveExistingPathToLeafId, alreadyFiled),
      when,
    );
    log(`Reassigned batch ${i + 1}/${batches.length} (${batch.length} bookmark(s)).`);
  }

  const nodesCreated = db.getAllCategories().length;
  return { bookmarks: bookmarks.length, batches: batches.length, nodesCreated };
}
