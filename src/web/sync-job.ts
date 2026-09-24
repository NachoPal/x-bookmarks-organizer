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
  filingSetting,
  reportCategorizerBilling,
  requirePassSettings,
  TAXONOMY_SETTING,
  type BuiltCategorizers,
  type Log,
  type PassSetting,
} from '../categorize/build';
import { createLlmFactory, type LlmFactory } from '../llm/factory';
import { needsTaxonomyDesign, runIngest as defaultRunIngest, type IngestSummary } from '../ingest';
import { buildSettingsCatalog } from '../settings/catalog';
import { createModelBrowser, type ModelBrowser } from '../settings/model-browser';
import { applySettingsToConfig, effectiveSettings } from '../settings/settings';
import { DEFAULT_TYPESAFE_MODEL } from '../categorize/typesafe/client';
import { asPaidPass, describeRoleSpend, type PaidPass } from './paid-spend';
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
  const preflight = createSyncPreflight(deps);

  return async (log) => {
    const { db, store } = deps;
    const { config, llm } = await preflight();
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

/**
 * Everything a sync checks before it reads X or calls a model, as its own
 * step: the job runs it first, and `POST /api/sync` runs it BEFORE asking the
 * owner to confirm a paid run, so a sync that cannot start is refused with
 * the reason instead of being authorized and then failing.
 *
 * Only the language models this run will actually call are required: pass 1
 * and a language-model filer always, but Jev's fallback only when an existing
 * tree is being extended - on a first run Jev files strictly into the new
 * tree and never calls it. A failure names the Settings field that chose the
 * model (`requirePassSettings`).
 */
export function createSyncPreflight(
  deps: Pick<SyncJobDeps, 'db' | 'store' | 'config'>,
): () => Promise<{ config: Config; llm: LlmFactory }> {
  const catalog = buildSettingsCatalog();
  return async () => {
    const { db, store } = deps;
    // No `env` argument: in the app the owner's visible choice wins over a
    // stray variable in the shell that launched `serve` - see
    // `applySettingsToConfig`.
    const config = applySettingsToConfig(deps.config, effectiveSettings(db, catalog));

    requireXCredentials(config);
    if (!db.getRefreshToken()) throw new Error(NOT_CONNECTED_MESSAGE);

    const llm = createLlmFactory(config, process.env, store);
    const passes: PassSetting[] = [TAXONOMY_SETTING];
    if (config.categorizer !== 'typesafe' || !needsTaxonomyDesign(db)) passes.push(filingSetting(config));
    await requirePassSettings(llm, passes);
    return { config, llm };
  };
}

export interface SyncSpendDeps {
  db: Database;
  store: CredentialStore;
  /** The same env-shaped baseline the job gets; the stored settings are layered on top per call. */
  config: Config;
  /** Where a catalog model's price is read from. Defaults to the real (local, free) browser. */
  browser?: ModelBrowser;
}

/**
 * Which passes of the NEXT sync will be billed per token (security review 2,
 * #20) - what `POST /api/sync` demands an explicit `{ confirm: true }` for and
 * the viewer's confirmation names.
 *
 * Resolved exactly the way {@link createSyncJob} resolves a run - the stored
 * settings layered on `config`, re-read on every call - so the confirmation
 * describes the run it authorizes. Only passes that will actually run count:
 * pass 1 (taxonomy) runs only while the library has no generated tree yet
 * (the owner's own categories do not count - see `needsTaxonomyDesign`), and Jev's
 * LLM fallback only when an existing tree is being extended. A local read
 * throughout: nothing is called and nothing is spent.
 */
export function createSyncSpend(deps: SyncSpendDeps): () => Promise<PaidPass[]> {
  const catalog = buildSettingsCatalog();
  const browser = deps.browser ?? createModelBrowser();

  return async () => {
    const { db, store } = deps;
    const config = applySettingsToConfig(deps.config, effectiveSettings(db, catalog));
    const llm = createLlmFactory(config, process.env, store);
    const firstRun = needsTaxonomyDesign(db);
    const passes: (PaidPass | undefined)[] = [];

    if (firstRun) {
      passes.push(asPaidPass(await describeRoleSpend(llm, 'taxonomy', catalog, browser), 'taxonomy', 'Taxonomy pass'));
    }
    const filing = await describeRoleSpend(llm, 'assignment', catalog, browser);
    if (config.categorizer === 'typesafe') {
      const model = config.typesafe.model ?? DEFAULT_TYPESAFE_MODEL;
      passes.push({
        pass: 'filing',
        label: 'Filing pass',
        providerId: 'typesafe',
        providerLabel: 'TypeSafe',
        model,
        modelLabel: `Jev (${model})`,
      });
      if (!firstRun) passes.push(asPaidPass(filing, 'filing-fallback', 'New-category fallback'));
    } else {
      passes.push(asPaidPass(filing, 'filing', 'Filing pass'));
    }
    return passes.filter((p): p is PaidPass => p !== undefined);
  };
}
