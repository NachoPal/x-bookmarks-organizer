/**
 * The in-app "Refresh from X": re-read the owner's bookmarks in place
 * (`src/x/refresh.ts`) to pick up what the library is missing - images and
 * their text above all - and then read that text in the background.
 *
 * It is a PAID X read (owned reads, see `src/x/pricing.ts`), so it carries the
 * paid-run discipline the sync and the ranking run already have: the scope
 * and its estimated cost are shown first, `POST /api/refresh` refuses without
 * `{ confirm: true }`, the price is the first line of the run's own log, and
 * it never races a sync or a ranking run.
 *
 * The job slot covers only the X read. Reading the images' text is the
 * {@link ImageTextWorker}'s background pass, kicked once the posts are
 * stored, so a sync is never held up by OCR.
 */
import { requireXCredentials, type Config } from '../config';
import type { Database } from '../db/database';
import type { ImageTextWorker } from '../images/worker';
import { buildSettingsCatalog } from '../settings/catalog';
import { applySettingsToConfig, effectiveSettings } from '../settings/settings';
import { getAuthenticatedClient } from '../x/auth';
import type { XClient } from '../x/client';
import { X_OWNED_READ_USD, X_POST_READ_USD, X_PRICES_CHECKED_ON } from '../x/pricing';
import {
  estimateRefresh,
  refreshBookmarks,
  type RefreshEstimate,
  type RefreshScope,
  type RefreshSummary,
} from '../x/refresh';
import { JobRunner, type Job } from './job-runner';
import { NOT_CONNECTED_MESSAGE } from './sync-job';

/** What the owner is told when a refresh fails without a message of its own. */
const REFRESH_FAILED_MESSAGE = 'The refresh failed. Please try again.';

export class RefreshRunner extends JobRunner<RefreshSummary> {
  constructor() {
    super(async () => {
      throw new Error('A refresh needs a scope.');
    }, REFRESH_FAILED_MESSAGE);
  }
}

export interface RefreshWiring {
  runner: RefreshRunner;
  /** Rejects with an owner-facing reason when a refresh cannot start (no X keys, not connected). */
  preflight(): Promise<void>;
  /** The scope's size and estimated cost - a free local count. */
  estimate(scope: RefreshScope): RefreshEstimate;
  /** The run itself, handed to {@link RefreshRunner.start}. */
  job(scope: RefreshScope): Job<RefreshSummary>;
}

export interface RefreshWiringDeps {
  db: Database;
  /** The env-shaped baseline; the stored settings are layered on top per run (as the sync does). */
  config: Config;
  /** Reads the refreshed images' text in the background. */
  images?: ImageTextWorker;
  /** Test seam: an authenticated X client. Defaults to the real OAuth client. */
  connect?: (config: Config, db: Database) => Promise<XClient>;
}

/** The price line every refresh's log opens with - the run's own billing notice. */
export function refreshBillingLine(estimate: RefreshEstimate): string {
  return (
    `Billing: X API owned reads, $${X_OWNED_READ_USD.toFixed(3)} per post read ` +
    `(a quoted post may count as a $${X_POST_READ_USD.toFixed(3)} read; prices from X's docs, ${X_PRICES_CHECKED_ON}). ` +
    `Estimated $${estimate.cost.low.toFixed(2)}-$${estimate.cost.high.toFixed(2)} for this refresh.`
  );
}

export function createRefreshWiring(deps: RefreshWiringDeps): RefreshWiring {
  const catalog = buildSettingsCatalog();
  const connect = deps.connect ?? ((config, db) => getAuthenticatedClient(config, db));
  const currentConfig = () => applySettingsToConfig(deps.config, effectiveSettings(deps.db, catalog));

  const preflight = async () => {
    requireXCredentials(currentConfig());
    if (!deps.db.getRefreshToken()) throw new Error(NOT_CONNECTED_MESSAGE);
  };

  return {
    runner: new RefreshRunner(),
    preflight,
    estimate: (scope) => estimateRefresh(deps.db, scope),
    job: (scope) => async (log) => {
      await preflight();
      log(refreshBillingLine(estimateRefresh(deps.db, scope)));
      log('Connecting to X...');
      const client = await connect(currentConfig(), deps.db);
      const summary = await refreshBookmarks(deps.db, client, { scope, logger: log });
      if (deps.images) {
        deps.images.kick();
        if (summary.imagesFound > 0) log('Reading the text in the images in the background...');
      }
      return summary;
    },
  };
}
