/**
 * The work an in-app sync actually performs (issue #71).
 *
 * Exactly what `node dist/index.js run` does, assembled from the SAME pieces:
 * the credential chain, `buildCategorizers`, and `runIngest`. The only
 * difference is where the choice of categorizer/provider/model/effort comes
 * from - the durable settings the owner picked in the app
 * (`src/settings/settings.ts`) rather than `XBOOKMARKS_*` variables exported
 * into whichever shell started the viewer.
 *
 * The settings are re-read on EVERY run, not captured when the server started,
 * so changing them in the Settings panel takes effect on the next sync without
 * a restart.
 *
 * `connect`, `buildCategorizers` and `ingest` are the offline test seams
 * (mirroring `IngestDeps.articleFetcher` and `ServerOptions.articleFetcher`):
 * a test drives the real job with a fake X client and a fake categorizer, so
 * nothing reaches X and nothing spends a model call.
 */
import { requireXCredentials, type Config } from '../config';
import type { CredentialStore } from '../creds/resolve';
import type { Database } from '../db/database';
import type { XClient } from '../x/client';
import { getAuthenticatedClient } from '../x/auth';
import {
  buildCategorizers as defaultBuildCategorizers,
  reportCategorizerBilling,
  requireLlm,
  type BuiltCategorizers,
  type Log,
} from '../categorize/build';
import { createLlmFactory, type LlmFactory } from '../llm/factory';
import { runIngest as defaultRunIngest, type IngestSummary } from '../ingest';
import { buildSettingsCatalog } from '../settings/catalog';
import { applySettingsToConfig, effectiveSettings } from '../settings/settings';
import type { SyncJob } from './sync';

/** What the owner is told when X has never been connected from this machine. */
export const NOT_CONNECTED_MESSAGE =
  'Not connected to X yet. Open Settings and choose "Connect X" to authorize this app once - ' +
  'X opens a consent page in your browser, and every later sync runs without it.';

export interface SyncJobDeps {
  db: Database;
  store: CredentialStore;
  /** The env-shaped baseline; the stored settings are layered on top per run. */
  config: Config;
  /** Test seam: returns an authenticated X client. Defaults to the real OAuth client. */
  connect?: (config: Config, db: Database) => Promise<XClient>;
  /** Test seam: builds the two passes. Defaults to the shared real builder. */
  buildCategorizers?: (
    config: Config,
    llm: LlmFactory,
    db: Database,
    store: CredentialStore,
    log: Log,
  ) => BuiltCategorizers;
  /** Test seam: the ingest itself. Defaults to the real `runIngest`. */
  ingest?: typeof defaultRunIngest;
}

/**
 * Build the sync job the {@link SyncRunner} executes.
 *
 * The preflight order matters: every condition that can be checked without
 * spending anything is checked FIRST, so a missing credential or an
 * unreachable `claude` CLI is reported as an actionable message before a single
 * X read or model call happens. Billing is announced (into the same progress
 * stream the owner is watching) before the run starts, never after.
 */
export function createSyncJob(deps: SyncJobDeps): SyncJob {
  const connect = deps.connect ?? ((config, db) => getAuthenticatedClient(config, db));
  const build = deps.buildCategorizers ?? defaultBuildCategorizers;
  const ingest = deps.ingest ?? defaultRunIngest;
  const catalog = buildSettingsCatalog();

  return async (log) => {
    const { db, store } = deps;
    const settings = effectiveSettings(db, catalog);
    // No `env` argument: in the app the owner's visible choice wins over a
    // stray variable in the shell that launched `serve` - see
    // `applySettingsToConfig`.
    const config = applySettingsToConfig(deps.config, settings);

    requireXCredentials(config);
    if (!db.getRefreshToken()) throw new Error(NOT_CONNECTED_MESSAGE);

    const llm = createLlmFactory(config, process.env, store);
    await requireLlm(llm, ['taxonomy', 'assignment']);
    reportCategorizerBilling(config, llm, log);

    log('Connecting to X...');
    const client = await connect(config, db);
    const { taxonomer, categorizer } = build(config, llm, db, store, log);

    return ingest({
      db,
      client,
      taxonomer,
      categorizer,
      batchSize: config.batchSize,
      maxDepth: config.maxCategoryDepth,
      logger: log,
    }) as Promise<IngestSummary>;
  };
}
