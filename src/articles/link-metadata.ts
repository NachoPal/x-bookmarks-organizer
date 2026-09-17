import { extractArticleLink } from './extract-link';
import type { ArticleFetcher } from './fetch-article';
import type { ArticleLinkMetadata, RawBookmark } from '../types';

/** Article title/description handed to the categorization prompts for a link post. */
export interface ArticleContext {
  title: string;
  description?: string;
}

/** Cache seam for the URL-keyed article metadata; `Database` satisfies this directly. */
export interface ArticleMetadataCache {
  getArticleLinkMetadata(url: string): ArticleLinkMetadata | undefined;
  saveArticleLinkMetadata(record: ArticleLinkMetadata): void;
}

/** How many links to fetch in parallel, bounding the total time added to a run. */
const DEFAULT_CONCURRENCY = 4;

function toContext(record: ArticleLinkMetadata): ArticleContext | undefined {
  if (record.status !== 'ok' || !record.title) return undefined;
  return { title: record.title, description: record.description ?? undefined };
}

/**
 * Fetch (or reuse the cached) metadata for a single URL. Exported so the web
 * viewer's server can reuse the exact same cache-or-fetch + failure-caching
 * semantics for the link-preview card (issue #26) as ingest uses for
 * categorization signal (issue #25) - the same cache row serves both.
 */
export async function resolveArticleLinkMetadata(
  url: string,
  fetcher: ArticleFetcher,
  cache: ArticleMetadataCache,
): Promise<ArticleLinkMetadata> {
  const cached = cache.getArticleLinkMetadata(url);
  if (cached) return cached;

  const fetchedAt = new Date().toISOString();
  let record: ArticleLinkMetadata;
  try {
    const result = await fetcher.fetch(url);
    record =
      result.status === 'ok'
        ? {
            url,
            status: 'ok',
            // Prefer OpenGraph-specific fields (purpose-built for a preview
            // card) and fall back to the readability-derived ones when a page
            // has no OG tags.
            title: result.ogTitle || result.title,
            description: result.ogDescription ?? result.excerpt,
            image: result.ogImage ?? null,
            siteName: result.ogSiteName ?? result.siteName,
            fetchedAt,
          }
        : { url, status: 'failed', title: null, description: null, image: null, siteName: null, fetchedAt };
  } catch {
    // A fetcher must never take down ingest - a thrown error degrades to
    // today's behavior (no article context) exactly like a typed failure.
    record = { url, status: 'failed', title: null, description: null, image: null, siteName: null, fetchedAt };
  }
  cache.saveArticleLinkMetadata(record);
  return record;
}

/**
 * Resolve metadata for many URLs at once, deduplicated, with at most
 * `concurrency` fetches in flight - the shared worker-pool implementation
 * behind both `buildArticleContext` (ingest) and the viewer's bookmark list
 * (which only ever reads the cache - see its call site).
 */
export async function resolveManyArticleLinkMetadata(
  urls: string[],
  fetcher: ArticleFetcher,
  cache: ArticleMetadataCache,
  concurrency = DEFAULT_CONCURRENCY,
): Promise<Map<string, ArticleLinkMetadata>> {
  const results = new Map<string, ArticleLinkMetadata>();
  const uniqueUrls = [...new Set(urls)];
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < uniqueUrls.length) {
      const url = uniqueUrls[cursor++]!;
      results.set(url, await resolveArticleLinkMetadata(url, fetcher, cache));
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, uniqueUrls.length) }, () => worker()));
  return results;
}

/**
 * Fetch (or reuse the cached) article title/description for every bookmark
 * whose post text contains a link, so the categorization prompts can be built
 * from what the link is actually about instead of just the post text + domain
 * (issue #25 - link-heavy posts otherwise carry almost no signal and fall back
 * to Uncategorized).
 *
 * Never throws and never blocks ingest on a slow/broken link: each fetch runs
 * through the injected `fetcher`, bounded by its own timeout (see
 * `HttpArticleFetcher`); a failure (or thrown error) is cached too, so a dead
 * link is not retried every run; and a bounded number of distinct links are
 * fetched concurrently, deduplicated by URL, so a large batch never fetches
 * one link at a time or the same shared link twice.
 */
export async function buildArticleContext(
  bookmarks: RawBookmark[],
  fetcher: ArticleFetcher,
  cache: ArticleMetadataCache,
  concurrency = DEFAULT_CONCURRENCY,
): Promise<Map<string, ArticleContext>> {
  const context = new Map<string, ArticleContext>();

  const postIdsByUrl = new Map<string, string[]>();
  for (const bm of bookmarks) {
    const url = extractArticleLink(bm.text);
    if (!url) continue;
    const existing = postIdsByUrl.get(url);
    if (existing) existing.push(bm.postId);
    else postIdsByUrl.set(url, [bm.postId]);
  }
  if (postIdsByUrl.size === 0) return context;

  const metadataByUrl = await resolveManyArticleLinkMetadata([...postIdsByUrl.keys()], fetcher, cache, concurrency);
  for (const [url, postIds] of postIdsByUrl) {
    const ctx = toContext(metadataByUrl.get(url)!);
    if (!ctx) continue;
    for (const postId of postIds) context.set(postId, ctx);
  }
  return context;
}
