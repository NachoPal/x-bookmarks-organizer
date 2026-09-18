import { articleRecordFromResult, type ArticleFetcher } from './fetch-article';
import type { ArticleRecord } from '../types';

/** The slice of `Database` this pass needs - the `articles` and `summaries` caches only. */
export interface RefetchDeps {
  getFailedArticles(): ArticleRecord[];
  saveArticle(record: ArticleRecord): void;
  deleteSummary(bookmarkId: number): boolean;
}

export interface RefetchOptions {
  /** How many links to fetch in parallel. */
  concurrency?: number;
  logger?: (message: string) => void;
}

export interface RefetchSummary {
  /** Cached `failed` article rows that were re-fetched. */
  retried: number;
  /** Rows that now extract a readable body. */
  recovered: number;
  stillFailed: number;
  /** Cached summaries dropped because they were generated without the now-available body. */
  summariesCleared: number;
}

const DEFAULT_CONCURRENCY = 4;

/**
 * Re-fetch every bookmark article cached as `failed` (the summary endpoint
 * serves that row forever otherwise, even after the fetcher or extractor that
 * produced it has been fixed) and re-cache the fresh result.
 *
 * When a row now yields a body, that bookmark's cached summary - generated
 * from the post text and card alone - is dropped so the next Summarize
 * regenerates it with the article. Every other summary, and every row that
 * already had a body, is left untouched. Idempotent: a second run only
 * re-tries what is still failing.
 */
export async function refetchFailedArticles(
  db: RefetchDeps,
  fetcher: ArticleFetcher,
  options: RefetchOptions = {},
): Promise<RefetchSummary> {
  const { concurrency = DEFAULT_CONCURRENCY, logger } = options;
  const failed = db.getFailedArticles();
  logger?.(`Found ${failed.length} cached article(s) with no readable body; re-fetching.`);

  let recovered = 0;
  let summariesCleared = 0;
  let next = 0;
  const worker = async () => {
    while (next < failed.length) {
      const row = failed[next++]!;
      let record: ArticleRecord;
      try {
        record = articleRecordFromResult(row.bookmarkId, row.url, await fetcher.fetch(row.url));
      } catch {
        // A fetcher is contracted never to throw; if one does, keep the old row.
        continue;
      }
      db.saveArticle(record);
      if (record.status !== 'ok') continue;
      recovered++;
      const cleared = db.deleteSummary(row.bookmarkId);
      if (cleared) summariesCleared++;
      logger?.(
        `  bookmark ${row.bookmarkId}: readable body recovered` +
          (cleared ? ' (stale summary cleared - Summarize regenerates it)' : ''),
      );
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));

  return { retried: failed.length, recovered, stillFailed: failed.length - recovered, summariesCleared };
}
