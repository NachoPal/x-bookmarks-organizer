/**
 * The ranking pass: score stored bookmarks by learning value and remember the
 * verdict (issue #62).
 *
 * Shape and discipline mirror `backfill-previews` (`src/articles/backfill.ts`),
 * which is the closest existing thing: a one-off, resumable pass over already
 * stored bookmarks that touches exactly one cache and nothing else. No bookmark,
 * category or taxonomy row is read or written here - ranking is additive, and
 * turning it off (or never turning it on) leaves the library byte-identical.
 *
 * It is resumable because `getBookmarksToScore` selects only what is missing or
 * scored under a different rubric version, and each bookmark's row is written as
 * soon as it is scored: an interrupted run has already paid for those calls, and
 * re-running never pays for them twice.
 */
import type { Database } from '../db/database';
import { buildBookmarkContent } from '../content/bookmark-content';
import type { BookmarkScoreRecord, StoredBookmark } from '../types';
import type { StateScorer } from './client';
import { combineDimensionScores, type Rubric } from './rubric';
import { buildRankState, hasRankableContent } from './state';

export interface RankDeps {
  db: Database;
  /** Answers one bookmark's whole rubric. The offline test seam. */
  scorer: StateScorer;
  logger?: (message: string) => void;
}

export interface RankOptions {
  rubric: Rubric;
  /** How many bookmarks are scored concurrently. Each call is independent. */
  concurrency?: number;
  /** Re-score bookmarks already current under this rubric, not just missing ones. */
  rescoreAll?: boolean;
  /** Stop after this many bookmarks - a cost ceiling for a first look. */
  limit?: number;
  /** Injected clock, so a test can assert the stored timestamp. */
  now?: () => string;
}

export interface RankSummary {
  /** Bookmarks selected for scoring this run. */
  candidates: number;
  /** Bookmarks scored and stored. */
  scored: number;
  /** Selected but holding nothing a model could judge, so never sent. */
  skipped: number;
  /** Selected and sent, but the call failed (or answered nothing usable). */
  failed: number;
  /** Input tokens the API reported billing, summed - what this run cost. */
  inputTokens: number;
}

const DEFAULT_CONCURRENCY = 6;

/**
 * Run `task` over `items` with at most `limit` in flight.
 *
 * Local rather than shared: the categorizer's equivalent is private to its own
 * module and lifting it out would mean editing the categorization path, which
 * this feature has no business touching.
 */
async function forEachWithConcurrency<T>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await task(items[i]!);
    }
  });
  await Promise.all(workers);
}

/**
 * Which bookmarks a run would score, without scoring any of them.
 *
 * This is what `rank --dry-run` reports, and it makes no API call at all - the
 * owner can see the size (and therefore the rough cost) of a run before
 * authorizing one.
 */
export function planRanking(db: Database, options: RankOptions): StoredBookmark[] {
  return db.getBookmarksToScore({
    rubricVersion: options.rubric.version,
    ...(options.rescoreAll ? { rescoreAll: true } : {}),
    ...(options.limit != null ? { limit: options.limit } : {}),
  });
}

export async function rankBookmarks(deps: RankDeps, options: RankOptions): Promise<RankSummary> {
  const { db, scorer } = deps;
  const log = deps.logger ?? (() => {});
  const now = options.now ?? (() => new Date().toISOString());
  const candidates = planRanking(db, options);

  const summary: RankSummary = {
    candidates: candidates.length,
    scored: 0,
    skipped: 0,
    failed: 0,
    inputTokens: 0,
  };
  if (candidates.length === 0) {
    log('Nothing to rank: every bookmark already has a score under this rubric.');
    return summary;
  }

  log(
    `Ranking ${candidates.length} bookmark(s) against rubric ${options.rubric.version} ` +
      `(${options.rubric.dimensions.length} question(s) per bookmark, one request each).`,
  );

  await forEachWithConcurrency(candidates, options.concurrency ?? DEFAULT_CONCURRENCY, async (bookmark) => {
    const state = buildRankState(buildBookmarkContent(db, bookmark));
    if (!hasRankableContent(state)) {
      summary.skipped++;
      return;
    }

    let result;
    try {
      result = await scorer.score(state, options.rubric);
    } catch (err) {
      summary.failed++;
      // The adapter's message is already redacted and actionable; one line per
      // failure so a systematic problem (a bad key, a rate limit) is obvious
      // without the run stopping on the first bookmark.
      log(`Could not rank bookmark ${bookmark.id}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    summary.inputTokens += result.inputTokens;
    const combined = combineDimensionScores(options.rubric, result.answers);
    if (Object.keys(combined.dimensions).length === 0) {
      // Every question came back unusable. Storing a zero would misreport the
      // bookmark as judged worthless, so leave it unscored and retryable.
      summary.failed++;
      log(`Bookmark ${bookmark.id} got no usable answers; left unscored.`);
      return;
    }

    const record: BookmarkScoreRecord = {
      bookmarkId: bookmark.id,
      score: combined.score,
      confidence: combined.confidence,
      dimensions: combined.dimensions,
      model: result.model,
      rubricVersion: options.rubric.version,
      scoredAt: now(),
    };
    db.saveBookmarkScore(record);
    summary.scored++;
  });

  log(
    `Ranking done. ${summary.scored} scored, ${summary.skipped} skipped (nothing to judge), ` +
      `${summary.failed} failed; ${summary.inputTokens} input token(s) billed.`,
  );
  return summary;
}
