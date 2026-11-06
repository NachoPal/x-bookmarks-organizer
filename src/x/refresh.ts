/**
 * The one-time, in-place refresh of STORED bookmarks from X.
 *
 * An incremental sync stops at the first post it already has, so a bookmark
 * stored before the bookmarks request asked for images never gets them. This
 * re-reads the owner's bookmarks timeline - the same request, billed as owned
 * reads - and updates each stored post with what X says now: the X-sourced
 * fields and its (and its quoted post's) Article, quote and media data. It is
 * never a reset: `Database.refreshBookmarkFromX` touches no category, origin,
 * list, score, summary, read or favorite state, and never re-adds a post the
 * owner deleted in the app. A post that is not stored yet is left for the
 * next sync, which also files it.
 *
 * Two scopes, both explicit and confirmed in the app before anything is read:
 * a TEST of the {@link REFRESH_TEST_SIZE} newest bookmarks (one request with
 * `max_results` lowered, so only those are billed), and ALL, which pages until
 * every stored bookmark has been seen or the timeline ends.
 */
import type { Database } from '../db/database';
import type { XClient } from './client';
import { bookmarkReadCost, type CostRange } from './pricing';

export type RefreshScope = 'newest' | 'all';

/** How many bookmarks the "test" refresh reads. */
export const REFRESH_TEST_SIZE = 10;
/** A safety bound on pages: X's bookmarks timeline holds at most 800 posts (8 pages). */
const MAX_PAGES = 20;

export function isRefreshScope(value: unknown): value is RefreshScope {
  return value === 'newest' || value === 'all';
}

export interface RefreshEstimate {
  scope: RefreshScope;
  /** Stored bookmarks the refresh would update. */
  posts: number;
  /** The most posts X could bill: those plus posts deleted in the app but still bookmarked on X. */
  maxPostsRead: number;
  /** How many of those quote another post (each possibly a non-owned read). */
  quoted: number;
  cost: CostRange;
}

/** What a refresh of `scope` would read and cost - a free local count, no X call. */
export function estimateRefresh(db: Pick<Database, 'getRefreshCounts'>, scope: RefreshScope): RefreshEstimate {
  if (scope === 'newest') {
    const counts = db.getRefreshCounts(REFRESH_TEST_SIZE);
    const posts = Math.min(REFRESH_TEST_SIZE, counts.stored);
    const maxPostsRead = Math.min(REFRESH_TEST_SIZE, counts.stored + counts.deleted);
    return {
      scope,
      posts,
      maxPostsRead,
      quoted: counts.quoted,
      cost: { low: bookmarkReadCost(posts, 0).low, high: bookmarkReadCost(maxPostsRead, counts.quoted).high },
    };
  }
  const counts = db.getRefreshCounts();
  const maxPostsRead = counts.stored + counts.deleted;
  const high = bookmarkReadCost(maxPostsRead, counts.quoted).high;
  return {
    scope,
    posts: counts.stored,
    maxPostsRead,
    quoted: counts.quoted,
    cost: { low: bookmarkReadCost(counts.stored, 0).low, high },
  };
}

export interface RefreshSummary {
  scope: RefreshScope;
  pagesRead: number;
  /** Posts X returned (what was billed). */
  postsRead: number;
  /** Stored bookmarks updated in place. */
  refreshed: number;
  /** Posts the owner deleted in the app - skipped, never re-added. */
  skippedDeleted: number;
  /** Posts not stored yet - left for the next sync. */
  notStored: number;
  /** Images, videos and GIFs found on the refreshed posts and the posts they quote. */
  imagesFound: number;
  /** The posts whose media was written - the OCR pass's scope. */
  mediaPostIds: string[];
}

export interface RefreshOptions {
  scope: RefreshScope;
  logger?: (message: string) => void;
}

export async function refreshBookmarks(
  db: Pick<Database, 'getStoredPostIds' | 'refreshBookmarkFromX'>,
  client: XClient,
  options: RefreshOptions,
): Promise<RefreshSummary> {
  const log = options.logger ?? (() => {});
  const stored = db.getStoredPostIds();
  const seen = new Set<string>();
  const mediaPostIds = new Set<string>();
  const summary: RefreshSummary = {
    scope: options.scope,
    pagesRead: 0,
    postsRead: 0,
    refreshed: 0,
    skippedDeleted: 0,
    notStored: 0,
    imagesFound: 0,
    mediaPostIds: [],
  };
  const maxResults = options.scope === 'newest' ? REFRESH_TEST_SIZE : undefined;

  let token: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { bookmarks, nextToken } = await client.fetchBookmarksPage(token, maxResults ? { maxResults } : {});
    summary.pagesRead++;
    summary.postsRead += bookmarks.length;
    const when = new Date().toISOString();
    let refreshedHere = 0;
    for (const bm of bookmarks) {
      const outcome = db.refreshBookmarkFromX(bm, when);
      if (outcome === 'deleted') summary.skippedDeleted++;
      else if (outcome === 'not-stored') summary.notStored++;
      else {
        summary.refreshed++;
        refreshedHere++;
        seen.add(bm.postId);
        summary.imagesFound += (bm.media?.length ?? 0) + (bm.quotedMedia?.length ?? 0);
        if (bm.media?.length) mediaPostIds.add(bm.postId);
        if (bm.quotedPostId && bm.quotedMedia?.length) mediaPostIds.add(bm.quotedPostId);
      }
    }
    log(`Read ${bookmarks.length} post(s) from X (page ${page + 1}); refreshed ${refreshedHere}.`);
    if (options.scope === 'newest' || !nextToken || bookmarks.length === 0) break;
    // Every stored bookmark has been seen: the rest of the timeline is posts
    // that are not stored, which a refresh would only pay to skip.
    if ([...stored].every((id) => seen.has(id))) break;
    token = nextToken;
  }

  summary.mediaPostIds = [...mediaPostIds];
  if (options.scope === 'all') {
    const missed = [...stored].filter((id) => !seen.has(id)).length;
    if (missed > 0) {
      log(
        `${missed} stored bookmark(s) were not in your X bookmarks (removed there, or older than the 800 ` +
          'most recent X returns) and were left as they are.',
      );
    }
  }
  if (summary.skippedDeleted > 0) {
    log(`Skipped ${summary.skippedDeleted} post(s) you deleted in the app - they stay deleted.`);
  }
  if (summary.notStored > 0) {
    log(`${summary.notStored} post(s) are not in the library yet; the next sync adds and files them.`);
  }
  log(`Refreshed ${summary.refreshed} bookmark(s); found ${summary.imagesFound} image(s).`);
  return summary;
}
