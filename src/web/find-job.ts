/**
 * The in-app "Find bookmarks for this category" run.
 *
 * It asks the FILING model - the assignment role, exactly as the settings
 * panel configured it for syncs - which already-stored bookmarks belong in one
 * category, and adds them there (`src/categorize/find.ts`). A library-wide
 * pass takes minutes, so it is the sync's shape: one run at a time on a
 * {@link FindRunner}, started by `POST /api/categories/:id/find-bookmarks`
 * and polled at `GET /api/find-bookmarks`.
 *
 * Paid safety mirrors a sync's (security review 2, #20): the filing model's
 * billing is described up front (`describe`, a local read - no call, no
 * spend), a per-token model makes the route demand `{ confirm: true }`, and
 * the billing line is the first line of the run's own progress log.
 *
 * `createLlm` and `articleFetcher` are the offline test seams.
 */
import type { Config } from '../config';
import type { CredentialStore } from '../creds/resolve';
import type { Database } from '../db/database';
import { buildArticleContext } from '../articles/link-metadata';
import { HttpArticleFetcher, type ArticleFetcher } from '../articles/fetch-article';
import { requireLlm } from '../categorize/build';
import { findBookmarksForCategory, type FindSummary } from '../categorize/find';
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
  /** Test seam: linked-article lookups. Defaults to the real HTTP fetcher. */
  articleFetcher?: ArticleFetcher;
}

export function createFindWiring(deps: FindWiringDeps): FindWiring {
  const catalog = buildSettingsCatalog();
  const browser = deps.browser ?? createModelBrowser();
  const createLlm = deps.createLlm ?? ((config: Config) => createLlmFactory(config, process.env, deps.store));

  // Re-read on every call, like the sync job: a model changed in the Settings
  // panel applies to the next find without a restart. No `env` argument, so
  // the owner's visible choice wins over a stray variable in the shell.
  const current = () => {
    const config = applySettingsToConfig(deps.config, effectiveSettings(deps.db, catalog));
    return { config, llm: createLlm(config) };
  };

  return {
    async describe() {
      const { llm } = current();
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
        ...(health.state === 'ok' ? {} : { reason: health.detail }),
        ...(spend ? { spend } : {}),
        ...(warning ? { warning } : {}),
      };
    },

    job(categoryId) {
      return async (log) => {
        const { config, llm } = current();
        await requireLlm(llm, ['assignment']);
        const role = llm.describe('assignment');
        const line = `Filing model: ${role.providerId} / ${role.model} - ${billingLabel(role.billing)}.`;
        log(role.warning ? `${line} ${role.warning}` : line);
        const fetcher = deps.articleFetcher ?? new HttpArticleFetcher();
        return findBookmarksForCategory({
          db: deps.db,
          runner: toRunner(llm.forRole('assignment'), { json: true }),
          categoryId,
          batchSize: config.batchSize,
          articleContext: (bookmarks) => buildArticleContext(bookmarks, fetcher, deps.db),
          logger: log,
        });
      };
    },
  };
}
