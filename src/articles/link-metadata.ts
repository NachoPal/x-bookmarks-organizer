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

async function resolveMetadata(
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
        ? { url, status: 'ok', title: result.title, description: result.excerpt, fetchedAt }
        : { url, status: 'failed', title: null, description: null, fetchedAt };
  } catch {
    // A fetcher must never take down ingest - a thrown error degrades to
    // today's behavior (no article context) exactly like a typed failure.
    record = { url, status: 'failed', title: null, description: null, fetchedAt };
  }
  cache.saveArticleLinkMetadata(record);
  return record;
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

  const urls = [...postIdsByUrl.keys()];
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < urls.length) {
      const url = urls[cursor++]!;
      const record = await resolveMetadata(url, fetcher, cache);
      const ctx = toContext(record);
      if (!ctx) continue;
      for (const postId of postIdsByUrl.get(url)!) context.set(postId, ctx);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, urls.length) }, () => worker()),
  );
  return context;
}
