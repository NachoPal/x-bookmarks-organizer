/**
 * The work an in-app ranking run actually performs (issue #80), and the two
 * free questions the UI asks about it before offering the button.
 *
 * Exactly what `node dist/index.js rank` does, assembled from the SAME pieces:
 * `buildRanker` (which is where the paid gate lives), `reportRankerBilling`,
 * and `rankBookmarks`. Nothing about scoring is reimplemented here - this
 * module only hands the CLI's own pass a logger that writes into the progress
 * stream the owner is watching instead of stdout.
 *
 * PAID-SAFETY, and it is the same set of gates the CLI has, in the same order:
 *
 *  1. `requireRankerCredentials` (inside `buildRanker`) refuses unless ranking
 *     is enabled (it is by default - `XBOOKMARKS_RANKER=off` turns it off) AND
 *     `TYPESAFE_API_KEY` resolves. The KEY is what gates a run in practice, and
 *     a resolvable key on its own still spends nothing: it only makes the
 *     button offerable, and gate 3 stands between it and any call.
 *  2. `reportRankerBilling` announces the price tag BEFORE the first call, into
 *     the same progress stream, so the run says what it costs while it runs.
 *  3. The route (`POST /api/rank`) additionally requires an explicit
 *     `{ confirm: true }`, and the viewer only sends it from a confirmation
 *     dialog that states the run is paid. That is the in-app equivalent of the
 *     CLI's deliberate `rank` invocation: a paid run is never one careless
 *     click away.
 *
 * Unlike the sync job, no app setting is layered onto the config: the ranker's
 * knobs (`XBOOKMARKS_RANKER*`) are deliberately NOT in the settings panel. A
 * stray env var cannot start a run by itself either; it only decides whether
 * the button exists, and gate 3 still stands between it and any spend.
 *
 * `buildRanker` and `rank` are the offline test seams (mirroring
 * `SyncJobDeps.ingest`): a test drives the real wiring with a fake scorer, so
 * nothing reaches `api.typesafe.ai` and nothing is billed.
 */
import { requireRankerCredentials, type Config } from '../config';
import type { CredentialStore } from '../creds/resolve';
import type { Database } from '../db/database';
import { buildRanker as defaultBuildRanker, reportRankerBilling, type BuiltRanker } from '../rank/build';
import { resolveActiveRubric } from '../rank/preset-store';
import { planRanking, rankBookmarks as defaultRankBookmarks, type RankSummary } from '../rank/ranker';
import type { RankJob } from './rank';

export interface RankJobDeps {
  db: Database;
  store: CredentialStore;
  config: Config;
  /** Test seam: constructs the scorer + rubric. Defaults to the real paid gate. */
  buildRanker?: (config: Config, store: CredentialStore, db: Database) => BuiltRanker;
  /** Test seam: the ranking pass itself. Defaults to the real `rankBookmarks`. */
  rank?: typeof defaultRankBookmarks;
}

/**
 * Everything the server needs to offer in-app ranking: the run, plus the two
 * questions it can answer for free (no API call, no spend) so the button can
 * say what a run would do and why it cannot run yet.
 */
export interface RankWiring {
  job: RankJob;
  /**
   * Score ONE bookmark (issue #98's per-post empty badge), through the very
   * same pass - `buildRanker`'s paid gate, `reportRankerBilling`'s price tag,
   * and `rankBookmarks` narrowed to a single id. It is one API call, so unlike
   * a whole-library run it is awaited by the request that starts it rather
   * than polled; every gate it passes through is unchanged.
   */
  rankOne: (bookmarkId: number, log: (message: string) => void) => Promise<RankSummary>;
  /**
   * Why a run cannot start right now - in practice the missing
   * `TYPESAFE_API_KEY`, since ranking is on by default - as the credential
   * chain's own actionable sentence (led by `TYPESAFE_API_KEY_MISSING`), or
   * null when it can. Only a key's PRESENCE is ever consulted; its value is
   * never read out (`AGENTS.md`).
   */
  blocker: () => string | null;
  /** How many bookmarks a run would score right now. A pure DB read - no API call. */
  pending: () => number;
}

export function createRankWiring(deps: RankJobDeps): RankWiring {
  const build = deps.buildRanker ?? defaultBuildRanker;
  const rank = deps.rank ?? defaultRankBookmarks;
  const { db, store, config } = deps;

  return {
    job: async (log) => {
      const { scorer, rubric } = build(config, store, db);
      reportRankerBilling(config, rubric, log);
      return rank(
        { db, scorer, logger: log },
        { rubric, concurrency: config.ranker.concurrency },
      );
    },

    // Assembled from the SAME three pieces, in the same order, so the one-post
    // path cannot drift from the whole-library one: refuse (inside
    // `buildRanker`), announce the price, then score. The only difference is
    // `bookmarkIds`, which NARROWS the normal selection - an already-scored id
    // is still not a candidate, so this can never pay twice for one bookmark.
    rankOne: async (bookmarkId, log) => {
      const { scorer, rubric } = build(config, store, db);
      reportRankerBilling(config, rubric, log);
      return rank({ db, scorer, logger: log }, { rubric, concurrency: 1, bookmarkIds: [bookmarkId] });
    },

    blocker: () => {
      try {
        requireRankerCredentials(config, store);
        return null;
      } catch (err) {
        return err instanceof Error ? err.message : 'Ranking is not available.';
      }
    },

    // The rubric is pure (no SDK, no clock, no network) and the active preset
    // is one `run_state` read, so the same selection `rank --dry-run` reports
    // is available to the dialog for free - which is what lets it name the size
    // of the bill before the owner authorizes it. Reading the ACTIVE preset
    // here is also what makes selecting a preset nothing has been scored under
    // say how much a re-rank would cost, without spending anything to find out.
    pending: () =>
      planRanking(db, {
        rubric: resolveActiveRubric(db, config.ranker.interests),
        concurrency: config.ranker.concurrency,
      }).length,
  };
}
