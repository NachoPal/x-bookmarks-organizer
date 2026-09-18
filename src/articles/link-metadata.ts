import { extractArticleLink } from './extract-link';
import type { ArticleFetcher } from './fetch-article';
import type { ArticleLinkMetadata, RawBookmark, XArticle } from '../types';

/** Article title/description handed to the categorization prompts for a link post. */
export interface ArticleContext {
  title: string;
  description?: string;
}

/** Cache seam for the URL-keyed article metadata; `Database` satisfies this directly. */
export interface ArticleMetadataCache {
  getArticleLinkMetadata(url: string): ArticleLinkMetadata | undefined;
  saveArticleLinkMetadata(record: ArticleLinkMetadata): void;
  /**
   * Stored X-native Articles for bookmarks that were fetched without one in
   * hand (e.g. `recategorize` over stored rows). Optional so a plain URL cache
   * still satisfies this; `Database` implements it.
   */
  getXArticlesForBookmarks?(
    bookmarks: Pick<RawBookmark, 'postId' | 'quotedPostId'>[],
  ): Map<string, { article: XArticle }>;
}

/**
 * The X-native Article a bookmark hosts or quotes, from the bookmark itself
 * (fresh from the X API) or else from the store.
 */
function xArticleContext(article: XArticle | null | undefined): ArticleContext | undefined {
  const title = article?.title ?? article?.previewText;
  if (!article || !title) return undefined;
  return { title, description: article.title ? article.previewText ?? undefined : undefined };
}

/** How many links to fetch in parallel, bounding the total time added to a run. */
const DEFAULT_CONCURRENCY = 4;

function toContext(record: ArticleLinkMetadata): ArticleContext | undefined {
  // A `card`-only page carries just as much categorization signal as a
  // readable article does: a title and a description are exactly what a
  // link-heavy post is missing (issue #25).
  if (record.status === 'failed' || !record.title) return undefined;
  return { title: record.title, description: record.description ?? undefined };
}

/** An empty (nothing usable) record for a url whose fetch yielded no card and no body. */
function failedRecord(url: string, resolvedUrl: string | null, fetchedAt: string): ArticleLinkMetadata {
  return {
    url,
    status: 'failed',
    title: null,
    description: null,
    image: null,
    siteName: null,
    resolvedUrl,
    fetchedAt,
  };
}

/**
 * Fetch (or reuse the cached) metadata for a single URL, resolving it to one
 * of three outcomes - a readable article (`ok`), a preview card only (`card`)
 * or nothing usable (`failed`); see {@link ArticleLinkMetadata.status}.
 *
 * Exported so the web viewer's server can reuse the exact same
 * cache-or-fetch + failure-caching semantics for the link-preview card
 * (issue #26) as ingest uses for categorization signal (issue #25) - the same
 * cache row serves both.
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
    const preview = result.preview ?? null;
    if (result.status === 'ok') {
      record = {
        url,
        status: 'ok',
        // Prefer the OpenGraph/card fields (purpose-built for a preview card)
        // and fall back to the readability-derived ones when a page has none.
        title: preview?.title || result.title,
        description: preview?.description ?? result.excerpt,
        image: preview?.image ?? null,
        siteName: preview?.siteName ?? result.siteName,
        resolvedUrl: result.resolvedUrl ?? null,
        fetchedAt,
      };
    } else if (preview?.title) {
      // The page has no readable body, but it does have a card - which is the
      // common case for the tools, product pages, repos and videos that make
      // up most of a real library. Caching this as `failed` (what we used to
      // do) is what left every preview empty; cache the card instead, marked
      // `card` so the reader-view affordance stays gated on a real body.
      record = {
        url,
        status: 'card',
        title: preview.title,
        description: preview.description,
        image: preview.image,
        siteName: preview.siteName,
        resolvedUrl: result.resolvedUrl ?? null,
        fetchedAt,
      };
    } else {
      record = failedRecord(url, result.resolvedUrl ?? null, fetchedAt);
    }
  } catch {
    // A fetcher must never take down ingest - a thrown error degrades to
    // today's behavior (no article context) exactly like a typed failure.
    record = failedRecord(url, null, fetchedAt);
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
 *
 * A bookmark that hosts or quotes an X-native Article gets that Article's
 * title + preview text as its context instead (no fetch - see below).
 */
export async function buildArticleContext(
  bookmarks: RawBookmark[],
  fetcher: ArticleFetcher,
  cache: ArticleMetadataCache,
  concurrency = DEFAULT_CONCURRENCY,
): Promise<Map<string, ArticleContext>> {
  const context = new Map<string, ArticleContext>();

  // An X-native Article's title/preview come straight from the X API, so a
  // bookmark that hosts or quotes one needs no link fetch at all - its link is
  // a t.co hop back to x.com, which could only ever cache a useless `failed`.
  const stored = cache.getXArticlesForBookmarks?.(bookmarks) ?? new Map<string, { article: XArticle }>();
  const needsLink: RawBookmark[] = [];
  for (const bm of bookmarks) {
    const ctx = xArticleContext(bm.xArticle ?? bm.quotedXArticle ?? stored.get(bm.postId)?.article);
    if (ctx) context.set(bm.postId, ctx);
    else needsLink.push(bm);
  }

  const postIdsByUrl = new Map<string, string[]>();
  for (const bm of needsLink) {
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
