import { extractArticleLink } from './extract-link';
import { resolveManyArticleLinkMetadata, type ArticleMetadataCache } from './link-metadata';
import type { ArticleFetcher } from './fetch-article';
import type { StoredBookmark } from '../types';

/** Read-only slice of `Database` this pass needs - no category/taxonomy access. */
export interface BackfillDeps {
  getAllBookmarks(): StoredBookmark[];
  getArticleLinkMetadata: ArticleMetadataCache['getArticleLinkMetadata'];
  saveArticleLinkMetadata: ArticleMetadataCache['saveArticleLinkMetadata'];
}

export interface BackfillOptions {
  /** Bounded fetch concurrency, forwarded to `resolveManyArticleLinkMetadata`. */
  concurrency?: number;
  /** Re-fetch urls previously cached as `failed`, not just missing ones. */
  retryFailed?: boolean;
  logger?: (message: string) => void;
}

export interface BackfillSummary {
  /** Distinct article links found across all stored bookmarks. */
  totalLinks: number;
  /** Links that were actually fetched this run. */
  fetched: number;
  /** Resolved to a readable article (card + reader body). */
  ok: number;
  /** Resolved to a preview card only - no readable body, but the card renders. */
  card: number;
  failed: number;
  /** Links already cached usably (or `failed` with `retryFailed` off) - left untouched. */
  skipped: number;
}

/**
 * Backfill `article_link_metadata` for bookmarks that predate the previews
 * feature (issue #39) - fetch + cache only, no categorization or taxonomy
 * work. Reuses the same fetch-or-cache path as ingest and the viewer
 * (`resolveManyArticleLinkMetadata`) so behavior (redirects, UA, failure
 * caching) is identical everywhere; it never writes a second fetcher.
 *
 * To force a re-fetch of urls already cached as `failed` when `retryFailed`
 * is set, only the urls actually selected for fetching are handed to
 * `resolveManyArticleLinkMetadata`, through a cache view that always reports
 * them as uncached - the real cache is still what gets written to.
 */
export async function backfillArticlePreviews(
  db: BackfillDeps,
  fetcher: ArticleFetcher,
  options: BackfillOptions = {},
): Promise<BackfillSummary> {
  const { concurrency, retryFailed = false, logger } = options;

  const urls = new Set<string>();
  for (const bm of db.getAllBookmarks()) {
    const url = extractArticleLink(bm.text);
    if (url) urls.add(url);
  }

  const toFetch: string[] = [];
  let skipped = 0;
  for (const url of urls) {
    const cached = db.getArticleLinkMetadata(url);
    if (!cached || (cached.status === 'failed' && retryFailed)) toFetch.push(url);
    else skipped++;
  }

  logger?.(
    `Found ${urls.size} distinct article link(s); ${toFetch.length} to fetch, ${skipped} already cached.`,
  );

  const forceFetchCache: ArticleMetadataCache = {
    getArticleLinkMetadata: () => undefined,
    saveArticleLinkMetadata: (record) => db.saveArticleLinkMetadata(record),
  };
  const results = await resolveManyArticleLinkMetadata(toFetch, fetcher, forceFetchCache, concurrency);

  let ok = 0;
  let card = 0;
  let failed = 0;
  for (const record of results.values()) {
    if (record.status === 'ok') ok++;
    else if (record.status === 'card') card++;
    else failed++;
  }

  const summary: BackfillSummary = { totalLinks: urls.size, fetched: toFetch.length, ok, card, failed, skipped };
  logger?.(
    `Backfill done. Fetched ${summary.fetched} (${ok} readable article(s), ${card} preview card(s), ` +
      `${failed} with nothing usable), ${skipped} skipped.`,
  );
  return summary;
}
