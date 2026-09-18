import { extractArticleLink } from '../articles/extract-link';
import type { ArticleLinkMetadata, StoredBookmark, XArticle } from '../types';
import { articleIdFromUrl } from './article';
import type { XPostLookupClient } from './client';

/** The slice of `Database` this pass needs - no category/taxonomy access. */
export interface XArticleBackfillDeps {
  getAllBookmarks(): StoredBookmark[];
  getArticleLinkMetadata(url: string): ArticleLinkMetadata | undefined;
  getXArticle(postId: string): XArticle | undefined;
  saveXArticle(postId: string, article: XArticle): void;
  setQuotedPostId(postId: string, quotedPostId: string): void;
}

export interface XArticleBackfillOptions {
  /** List what would be fetched (and its estimated cost) without calling X. */
  dryRun?: boolean;
  logger?: (message: string) => void;
}

export interface XArticleBackfillSummary {
  /** Bookmarks whose link resolved to an `x.com/i/article/...` with no stored Article. */
  direct: number;
  /** Bookmarks whose link resolved to another X post they quote, not yet checked. */
  quoted: number;
  /** Distinct post ids requested from X (0 on a dry run or when nothing is missing). */
  requested: number;
  /** Articles stored (own or quoted). */
  stored: number;
  /** Quoted posts that turned out to be ordinary posts, recorded so they are not re-checked. */
  quotedNonArticle: number;
  /** Posts with an `article` object whose fields were not recognized - left to retry. */
  unrecognized: number;
  /** Requested posts X did not return (deleted/protected), or returned without an article. */
  missing: number;
  /** Bookmarks with a link whose destination is not cached yet, so it is unknown. */
  unresolved: number;
}

/** Per-post read price for `GET /2/tweets` (non-owned Post read), for the dry-run estimate. */
const ESTIMATED_COST_PER_POST_USD = 0.005;

const STATUS_LINK = /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/(?:[^/]+|i\/web)\/status\/(\d+)/i;

/**
 * Backfill X-native Article data (`x_articles`) for bookmarks stored before
 * the bookmarks request asked for the `article` field. An incremental `run`
 * never re-reads stored bookmarks, so without this they would never get their
 * card, categorization context or summary body.
 *
 * Only bookmarks that can be shown to need it are sent to X - each read is a
 * PAID call: those whose link (already resolved by ingest/`backfill-previews`
 * into `article_link_metadata.resolved_url`) is an `x.com/i/article/<id>`
 * (the bookmark hosts an Article) or another X post (it quotes one, which may
 * be an Article). Idempotent and resumable: a bookmark with its Article stored,
 * or whose quoted post was already checked, is skipped; anything X did not
 * return, or returned in an unrecognized shape, is left to retry next run.
 *
 * `connect` is only invoked when there is something to fetch and this is not a
 * dry run, so a no-op or dry run never authenticates (which rotates the stored
 * refresh token) and never spends money.
 */
export async function backfillXArticles(
  db: XArticleBackfillDeps,
  connect: () => Promise<XPostLookupClient>,
  options: XArticleBackfillOptions = {},
): Promise<XArticleBackfillSummary> {
  const log = options.logger ?? (() => {});

  const directPostIds: string[] = [];
  /** quoted post id -> bookmark post ids that quote it */
  const quoters = new Map<string, string[]>();
  let unresolved = 0;

  for (const bm of db.getAllBookmarks()) {
    // Already has its Article, or its quote was already checked.
    if (bm.quotedPostId || db.getXArticle(bm.postId)) continue;
    const link = extractArticleLink(bm.text);
    if (!link) continue;
    const metadata = db.getArticleLinkMetadata(link);
    const resolved = metadata?.resolvedUrl ?? null;
    if (!resolved) {
      unresolved++;
      continue;
    }
    if (articleIdFromUrl(resolved)) {
      directPostIds.push(bm.postId);
      continue;
    }
    const quotedId = STATUS_LINK.exec(resolved)?.[1];
    if (quotedId && quotedId !== bm.postId) {
      const list = quoters.get(quotedId);
      if (list) list.push(bm.postId);
      else quoters.set(quotedId, [bm.postId]);
    }
  }

  const quotedCount = [...quoters.values()].reduce((n, list) => n + list.length, 0);
  const ids = [...new Set([...directPostIds, ...quoters.keys()])];
  const summary: XArticleBackfillSummary = {
    direct: directPostIds.length,
    quoted: quotedCount,
    requested: 0,
    stored: 0,
    quotedNonArticle: 0,
    unrecognized: 0,
    missing: 0,
    unresolved,
  };

  log(
    `Found ${summary.direct} bookmark(s) linking an X Article and ${summary.quoted} quoting another X post ` +
      `without stored Article data; ${ids.length} post(s) to read from X ` +
      `(estimated one-time cost ~$${(ids.length * ESTIMATED_COST_PER_POST_USD).toFixed(3)}).`,
  );
  if (unresolved > 0) {
    log(
      `${unresolved} bookmark link(s) have no resolved destination cached yet, so it is unknown whether they ` +
        'are X Articles; run `backfill-previews` first to resolve them, then re-run this.',
    );
  }
  if (ids.length === 0 || options.dryRun) {
    if (options.dryRun) log('Dry run: nothing was requested from X.');
    return summary;
  }

  const client = await connect();
  const posts = await client.fetchPostsByIds(ids);
  summary.requested = ids.length;
  const byId = new Map(posts.map((p) => [p.postId, p]));

  for (const postId of directPostIds) {
    const post = byId.get(postId);
    if (post?.xArticle) {
      db.saveXArticle(postId, post.xArticle);
      summary.stored++;
    } else if (post?.articleUnrecognized) {
      summary.unrecognized++;
    } else {
      summary.missing++;
    }
  }

  for (const [quotedId, bookmarkPostIds] of quoters) {
    const post = byId.get(quotedId);
    if (!post) {
      summary.missing += bookmarkPostIds.length;
      continue;
    }
    if (post.articleUnrecognized) {
      summary.unrecognized += bookmarkPostIds.length;
      continue;
    }
    if (post.xArticle) {
      db.saveXArticle(quotedId, post.xArticle);
      summary.stored++;
    } else {
      summary.quotedNonArticle += bookmarkPostIds.length;
    }
    for (const bookmarkPostId of bookmarkPostIds) db.setQuotedPostId(bookmarkPostId, quotedId);
  }

  log(
    `Backfill done. Requested ${summary.requested} post(s): stored ${summary.stored} X Article(s), ` +
      `${summary.quotedNonArticle} quoted post(s) were ordinary posts, ${summary.unrecognized} had an ` +
      `unrecognized article shape, ${summary.missing} not returned or without an article.`,
  );
  return summary;
}
