/**
 * The in-app Recategorize (top bar, between Sync and Settings): its cost
 * description and its three jobs - generate a proposal, accept it, and finish
 * a re-file a failed accept left part way.
 *
 * One {@link RecategorizeRunner} slot for all three, sharing the sync's shape:
 * started by a POST, polled at `GET /api/recategorize`, refused (409) while a
 * sync, ranking run or find is going - and every one of those refuses while
 * this runs (`server.ts`).
 *
 * The passes are the ones the Settings panel configured, re-read on every
 * call like a sync's: phase 1 on the taxonomy model, phase 2 with the filing
 * method (a language model, or Jev). `describe` is a local read - no call, no
 * spend - and every job announces its pass's billing as its first log line.
 *
 * `createLlm`, `buildTaxonomer`, `buildFiler` and `articleFetcher` are the
 * offline test seams.
 */
import { TYPESAFE_API_KEY, type Config } from '../config';
import type { CredentialStore } from '../creds/resolve';
import type { Database } from '../db/database';
import type { ArticleFetcher } from '../articles/fetch-article';
import {
  buildFilingCategorizer,
  buildTaxonomyDesigner,
  FILING_SETTING,
  JEV_SETTING,
  jevBillingLine,
  passSettingProblem,
  requirePassSettings,
  TAXONOMY_SETTING,
  type Log,
  type PassSetting,
} from '../categorize/build';
import type { BatchCategorizer } from '../categorize/llm';
import type { TaxonomyDesigner } from '../categorize/taxonomy';
import type { RecategorizeMode } from '../categorize/proposal';
import {
  acceptProposal,
  generateProposal,
  refileRemaining,
  type RecategorizeSummary,
} from '../categorize/recategorize';
import { billingLabel, createLlmFactory, type LlmFactory } from '../llm/factory';
import { buildSettingsCatalog } from '../settings/catalog';
import { createModelBrowser, requireCatalogModels, retiredModelProblem, type ModelBrowser } from '../settings/model-browser';
import { applySettingsToConfig, effectiveSettings, type AppSettings } from '../settings/settings';
import { jevSpend } from './find-job';
import { JobRunner, type Job, type JobStatus } from './job-runner';
import { describeRoleSpend, type RoleSpend } from './paid-spend';

export type RecategorizeStatus = JobStatus<RecategorizeSummary>;

const RECATEGORIZE_FAILED_MESSAGE = 'Recategorizing failed. Nothing was lost; please try again.';

export class RecategorizeRunner extends JobRunner<RecategorizeSummary> {
  constructor() {
    // Every run brings its own job (which step it is) to `start`.
    super(async () => {
      throw new Error('No recategorize step was chosen.');
    }, RECATEGORIZE_FAILED_MESSAGE);
  }
}

/** One pass of a recategorize, as the dialog describes it. */
export interface RecategorizePass {
  /** False when it cannot run at all; `reason` says why. */
  available: boolean;
  reason?: string;
  spend?: RoleSpend;
  /** The provider's own risk notice (the subscription driven through pi). */
  warning?: string;
}

export interface RecategorizeCost {
  /** Phase 1: designs the proposal. */
  taxonomy: RecategorizePass;
  /** Phase 2: re-files every post once a proposal is accepted. */
  filing: RecategorizePass;
}

export interface RecategorizeWiring {
  describe(): Promise<RecategorizeCost>;
  proposalJob(mode: RecategorizeMode): Job<RecategorizeSummary>;
  acceptJob(): Job<RecategorizeSummary>;
  refileJob(): Job<RecategorizeSummary>;
}

export interface RecategorizeWiringDeps {
  db: Database;
  store: CredentialStore;
  /** The env-shaped baseline; the stored settings are layered on top per call. */
  config: Config;
  browser?: ModelBrowser;
  /** Test seam: the provider factory. Defaults to the real one. */
  createLlm?: (config: Config) => LlmFactory;
  /** Test seam: phase 1's designer. Defaults to the shared real builder. */
  buildTaxonomer?: (config: Config, llm: LlmFactory, log: Log) => TaxonomyDesigner;
  /** Test seam: phase 2's filer. Defaults to the shared real builder. */
  buildFiler?: (config: Config, llm: LlmFactory, db: Database, store: CredentialStore, log: Log) => BatchCategorizer;
  /** Test seam: linked-article lookups. Defaults to the real HTTP fetcher. */
  articleFetcher?: ArticleFetcher;
}

export function createRecategorizeWiring(deps: RecategorizeWiringDeps): RecategorizeWiring {
  const catalog = buildSettingsCatalog();
  const browser = deps.browser ?? createModelBrowser();
  const createLlm = deps.createLlm ?? ((config: Config) => createLlmFactory(config, process.env, deps.store));
  const buildTaxonomer = deps.buildTaxonomer ?? buildTaxonomyDesigner;
  const buildFiler = deps.buildFiler ?? buildFilingCategorizer;

  // No `env` argument: the owner's visible choice wins over a stray variable
  // in the shell that launched `serve` (`applySettingsToConfig`).
  const current = () => {
    const settings = effectiveSettings(deps.db, catalog);
    const config = applySettingsToConfig(deps.config, settings);
    return { settings, config, llm: createLlm(config) };
  };

  /** A pass whose saved model the installed catalog no longer lists is refused, named, never swapped. */
  const requireListed = (settings: AppSettings, setting: PassSetting) =>
    requireCatalogModels(settings, catalog, browser, [setting], passSettingProblem);

  async function describeRole(llm: LlmFactory, setting: PassSetting, settings: AppSettings): Promise<RecategorizePass> {
    const spend = await describeRoleSpend(llm, setting.role, catalog, browser);
    const retired = await retiredModelProblem(settings, catalog, browser, setting, passSettingProblem);
    if (retired) return { available: false, reason: retired, ...(spend ? { spend } : {}) };
    const health = await llm.check(setting.role);
    let warning: string | undefined;
    try {
      warning = llm.describe(setting.role).warning;
    } catch {
      warning = undefined;
    }
    return {
      available: health.state === 'ok',
      ...(health.state === 'ok' ? {} : { reason: passSettingProblem(setting, health.detail) }),
      ...(spend ? { spend } : {}),
      ...(warning ? { warning } : {}),
    };
  }

  function passLine(llm: LlmFactory, setting: PassSetting): string {
    const role = llm.describe(setting.role);
    const line = `${role.providerId} / ${role.model} - ${billingLabel(role.billing)}.`;
    return role.warning ? `${line} ${role.warning}` : line;
  }

  /** Phase 2's filer, refusing (before anything can spend) when it cannot run. */
  async function filer(settings: AppSettings, config: Config, llm: LlmFactory, log: Log): Promise<BatchCategorizer> {
    if (config.categorizer === 'typesafe') {
      const jev = buildFiler(config, llm, deps.db, deps.store, log);
      log(`Filing pass: ${jevBillingLine(config)}`);
      return jev;
    }
    await requireListed(settings, FILING_SETTING);
    await requirePassSettings(llm, [FILING_SETTING]);
    log(`Filing pass: ${passLine(llm, FILING_SETTING)}`);
    return buildFiler(config, llm, deps.db, deps.store, log);
  }

  return {
    async describe() {
      const { settings, config, llm } = current();
      const taxonomy = await describeRole(llm, TAXONOMY_SETTING, settings);
      let filing: RecategorizePass;
      if (config.categorizer === 'typesafe') {
        // A local read of the credential chain: never the key's value.
        const hasKey = !!deps.store.get(TYPESAFE_API_KEY).value;
        filing = {
          available: hasKey,
          ...(hasKey ? {} : { reason: passSettingProblem(JEV_SETTING, `${TYPESAFE_API_KEY} is not set`) }),
          spend: jevSpend(config),
        };
      } else {
        filing = await describeRole(llm, FILING_SETTING, settings);
      }
      return { taxonomy, filing };
    },

    proposalJob(mode) {
      return async (log) => {
        const { settings, config, llm } = current();
        await requireListed(settings, TAXONOMY_SETTING);
        await requirePassSettings(llm, [TAXONOMY_SETTING]);
        log(`Taxonomy pass: ${passLine(llm, TAXONOMY_SETTING)}`);
        return generateProposal(
          {
            db: deps.db,
            taxonomer: buildTaxonomer(config, llm, log),
            maxDepth: config.maxCategoryDepth,
            articleFetcher: deps.articleFetcher,
            logger: log,
          },
          mode,
        );
      };
    },

    acceptJob() {
      return async (log) => {
        const { settings, config, llm } = current();
        const categorizer = await filer(settings, config, llm, log);
        return acceptProposal({
          db: deps.db,
          categorizer,
          batchSize: config.batchSize,
          maxDepth: config.maxCategoryDepth,
          articleFetcher: deps.articleFetcher,
          logger: log,
        });
      };
    },

    refileJob() {
      return async (log) => {
        const { settings, config, llm } = current();
        const categorizer = await filer(settings, config, llm, log);
        return refileRemaining({
          db: deps.db,
          categorizer,
          batchSize: config.batchSize,
          maxDepth: config.maxCategoryDepth,
          articleFetcher: deps.articleFetcher,
          logger: log,
        });
      };
    },
  };
}
