import type { Database } from './db/database';
import type { XClient } from './x/client';
import type { BatchCategorizer } from './categorize/llm';
import { buildCategoryTree, renderTreeForPrompt } from './categorize/tree';
import type { Assignment, RawBookmark } from './types';

/** Root node used when the LLM finds no fitting category, so everything is filed. */
const FALLBACK_CATEGORY = 'Uncategorized';

export interface IngestDeps {
  db: Database;
  client: XClient;
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
 * Resolve a single category path (root -> leaf) to the leaf node id, creating
 * any missing nodes along the way. Paths are capped at `maxDepth`.
 */
function resolvePathToLeafId(
  db: Database,
  path: string[],
  maxDepth: number,
  when: string,
): number | undefined {
  const capped = path.slice(0, maxDepth);
  let parentId: number | null = null;
  let leafId: number | undefined;
  for (const name of capped) {
    const node = db.getOrCreateCategory(name, parentId, when);
    parentId = node.id;
    leafId = node.id;
  }
  return leafId;
}

/**
 * Full incremental run: fetch new bookmarks, categorize them in batches, and
 * store each batch atomically with its category links. A bookmark is only
 * marked "seen" once it is stored with categories, so an interrupted run simply
 * retries the unstored bookmarks next time (idempotent, no duplicates).
 */
export async function runIngest(deps: IngestDeps): Promise<IngestSummary> {
  const { db, client, categorizer, batchSize, maxDepth } = deps;
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

  // Oldest-first so the tree grows in bookmark order and reuse is natural.
  const ordered = [...newBookmarks].reverse();
  const batches = chunk(ordered, batchSize);
  log(`Found ${ordered.length} new bookmark(s); categorizing in ${batches.length} batch(es).`);

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i]!;
    const treeText = renderTreeForPrompt(buildCategoryTree(db));
    const assignments = await categorizer.categorizeBatch(batch, treeText);
    const byPostId = new Map<string, string[][]>();
    for (const a of assignments as Assignment[]) byPostId.set(a.postId, a.categories);

    const when = new Date().toISOString();
    db.storeCategorizedBatch(
      batch,
      (bm) => {
        const paths = byPostId.get(bm.postId) ?? [];
        const ids = new Set<number>();
        for (const path of paths) {
          const id = resolvePathToLeafId(db, path, maxDepth, when);
          if (id !== undefined) ids.add(id);
        }
        if (ids.size === 0) {
          // Guarantee everything gets filed, even if the LLM returned nothing.
          ids.add(db.getOrCreateCategory(FALLBACK_CATEGORY, null, when).id);
        }
        return [...ids];
      },
      when,
    );
    log(`Stored batch ${i + 1}/${batches.length} (${batch.length} bookmark(s)).`);
  }

  if (newestPostId) db.setNewestSeenPostId(newestPostId);

  const nodesCreated = db.getAllCategories().length - nodesBefore;
  return { newBookmarks: ordered.length, batches: batches.length, nodesCreated };
}
