/**
 * The in-app "Find bookmarks for this category" run.
 *
 * It asks the phase-2 FILING method, exactly as the settings panel
 * configured it for syncs - the filing language model (the assignment role),
 * or Jev - which already-stored bookmarks belong in one category, and adds
 * them there (`src/categorize/find.ts`). A library-wide pass takes minutes,
 * so it is the sync's shape: one run at a time on a {@link FindRunner},
 * started by `POST /api/categories/:id/find-bookmarks` and polled at
 * `GET /api/find-bookmarks`.
 *
 * Paid safety mirrors a sync's (security review 2, #20): the method's billing
 * is described up front (`describe`, a local read - no call, no spend), a
 * per-token method (Jev always is) makes the route demand `{ confirm: true }`,
 * and the billing line is the first line of the run's own progress log.
 *
 * `createLlm`, `buildFiler` and `articleFetcher` are the offline test seams.
 */
import type { Config } from '../config';
import type { CredentialStore } from '../creds/resolve';
import type { Database } from '../db/database';
import { buildArticleContext } from '../articles/link-metadata';
import { HttpArticleFetcher, type ArticleFetcher } from '../articles/fetch-article';
import { TYPESAFE_API_KEY, type CategorizerId } from '../config';
import {
  buildFilingCategorizer,
  FILING_SETTING,
  JEV_SETTING,
  jevBillingLine,
  passSettingProblem,
  requirePassSettings,
  type Log,
} from '../categorize/build';
import {
  filingFindMatcher,
  findBookmarksForCategory,
  llmFindMatcher,
  type FindMatcher,
  type FindSummary,
} from '../categorize/find';
import type { BatchCategorizer } from '../categorize/llm';
import { buildCategoryTree, renderTreeForPrompt } from '../categorize/tree';
import { DEFAULT_TYPESAFE_MODEL } from '../categorize/typesafe/client';
import { billingLabel, createLlmFactory, type LlmFactory } from '../llm/factory';
import { toRunner } from '../llm/runner';
import { buildSettingsCatalog } from '../settings/catalog';
import { createModelBrowser, type ModelBrowser } from '../settings/model-browser';
import { applySettingsToConfig, effectiveSettings } from '../settings/settings';
import { JobRunner, type Job, type JobStatus } from './job-runner';
import { describeRoleSpend, type RoleSpend } from './paid-spend';

export type FindStatus = JobStatus<FindSummary>;

const FIND_FAILED_MESSAGE = 'Finding bookmarks failed. Please try again.';

export class FindRunner extends JobRunner<FindSummary> {
  constructor() {
    // Every run brings its own job (which category it is for) to `start`.
    super(async () => {
      throw new Error('No category was chosen.');
    }, FIND_FAILED_MESSAGE);
  }
}

/** What the confirmation says about the model a find would use. */
export interface FindModel {
  /** False when the filing model cannot run at all; `reason` says why. */
  available: boolean;
  reason?: string;
  /** How its calls are billed; absent when the provider is unknown. */
  spend?: RoleSpend;
  /** The provider's own risk notice (the subscription driven through pi). */
  warning?: string;
}

export interface FindWiring {
  describe(): Promise<FindModel>;
  job(categoryId: number): Job<FindSummary>;
}

export interface FindWiringDeps {
  db: Database;
  store: CredentialStore;
  /** The env-shaped baseline; the stored settings are layered on top per call. */
  config: Config;
  browser?: ModelBrowser;
  /** Test seam: the provider factory. Defaults to the real one. */
  createLlm?: (config: Config) => LlmFactory;
  /** Test seam: builds Jev (the phase-2 method). Defaults to the shared real builder. */
  buildFiler?: (config: Config, llm: LlmFactory, db: Database, store: CredentialStore, log: Log) => BatchCategorizer;
  /** Test seam: linked-article lookups. Defaults to the real HTTP fetcher. */
  articleFetcher?: ArticleFetcher;
}

/** Jev's billing as the confirmation shows it - always per token, never a secret. */
function jevSpend(config: Config): RoleSpend {
  const model = config.typesafe.model ?? DEFAULT_TYPESAFE_MODEL;
  return {
    providerId: 'typesafe',
    providerLabel: 'TypeSafe',
    model,
    modelLabel: `Jev (${model})`,
    billing: 'per-token',
  };
}

const isJev = (categorizer: CategorizerId) => categorizer === 'typesafe';

export function createFindWiring(deps: FindWiringDeps): FindWiring {
  const catalog = buildSettingsCatalog();
  const browser = deps.browser ?? createModelBrowser();
  const createLlm = deps.createLlm ?? ((config: Config) => createLlmFactory(config, process.env, deps.store));
  const buildFiler = deps.buildFiler ?? buildFilingCategorizer;

  // Re-read on every call, like the sync job: a model changed in the Settings
  // panel applies to the next find without a restart. No `env` argument, so
  // the owner's visible choice wins over a stray variable in the shell.
  const current = () => {
    const config = applySettingsToConfig(deps.config, effectiveSettings(deps.db, catalog));
    return { config, llm: createLlm(config) };
  };

  return {
    async describe() {
      const { config, llm } = current();
      if (isJev(config.categorizer)) {
        // A local read of the credential chain: never the key's value.
        const hasKey = !!deps.store.get(TYPESAFE_API_KEY).value;
        return {
          available: hasKey,
          ...(hasKey ? {} : { reason: passSettingProblem(JEV_SETTING, `${TYPESAFE_API_KEY} is not set`) }),
          spend: jevSpend(config),
        };
      }
      const health = await llm.check('assignment');
      const spend = await describeRoleSpend(llm, 'assignment', catalog, browser);
      let warning: string | undefined;
      try {
        warning = llm.describe('assignment').warning;
      } catch {
        warning = undefined;
      }
      return {
        available: health.state === 'ok',
        // Names the Settings field that chose this model, not just the
        // provider's own complaint.
        ...(health.state === 'ok' ? {} : { reason: passSettingProblem(FILING_SETTING, health.detail) }),
        ...(spend ? { spend } : {}),
        ...(warning ? { warning } : {}),
      };
    },

    job(categoryId) {
      return async (log) => {
        const { config, llm } = current();
        let matcher: FindMatcher;
        if (isJev(config.categorizer)) {
          // Refuses without the key before anything can spend money.
          const jev = buildFiler(config, llm, deps.db, deps.store, log);
          log(`Filing method: ${jevBillingLine(config)}`);
          matcher = filingFindMatcher(jev, renderTreeForPrompt(buildCategoryTree(deps.db)));
        } else {
          await requirePassSettings(llm, [FILING_SETTING]);
          const role = llm.describe('assignment');
          const line = `Filing model: ${role.providerId} / ${role.model} - ${billingLabel(role.billing)}.`;
          log(role.warning ? `${line} ${role.warning}` : line);
          matcher = llmFindMatcher(toRunner(llm.forRole('assignment'), { json: true }));
        }
        const fetcher = deps.articleFetcher ?? new HttpArticleFetcher();
        return findBookmarksForCategory({
          db: deps.db,
          matcher,
          categoryId,
          batchSize: config.batchSize,
          articleContext: (bookmarks) => buildArticleContext(bookmarks, fetcher, deps.db),
          logger: log,
        });
      };
    },
  };
}
