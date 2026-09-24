/**
 * Build the two categorization passes' collaborators.
 *
 * Extracted from `src/index.ts` so the CLI (`run`/`recategorize`) and the
 * viewer's in-app sync (issue #71) construct categorization through ONE path:
 * a second copy would be a second place for the "never silently spend money"
 * invariant to drift.
 */
import { requireTypeSafeCredentials, type Config } from '../config';
import type { CredentialStore } from '../creds/resolve';
import type { Database } from '../db/database';
import { Categorizer, type BatchCategorizer } from './llm';
import { LlmTaxonomyDesigner, type TaxonomyDesigner } from './taxonomy';
import { TypeSafeCategorizer } from './typesafe/categorizer';
import { DEFAULT_TYPESAFE_MODEL, TypeSafeLevelAsker } from './typesafe/client';
import { billingLabel, type LlmFactory, type RoleDescription } from '../llm/factory';
import { toRunner } from '../llm/runner';
import type { LlmRole } from '../llm/types';

export interface BuiltCategorizers {
  taxonomer: TaxonomyDesigner;
  categorizer: BatchCategorizer;
}

/** Where a build/billing line goes; the CLI prints it, a sync records it as progress. */
export type Log = (message: string) => void;

/**
 * Pass 1 (taxonomy design) is ALWAYS the LLM: it invents labels, which the
 * TypeSafe classifier cannot do at all. It is provider-agnostic - it takes a
 * narrow `LlmRunner` bridged from whichever provider the factory resolved for
 * that role, so the Opus-pass-1 / Haiku-pass-2 economics stay expressible
 * without the class knowing what is behind it.
 *
 * Pass 2 (assignment) is {@link buildFilingCategorizer}.
 */
export function buildCategorizers(
  config: Config,
  llm: LlmFactory,
  db: Database,
  store: CredentialStore,
  log: Log = () => {},
): BuiltCategorizers {
  return {
    taxonomer: buildTaxonomyDesigner(config, llm, log),
    categorizer: buildFilingCategorizer(config, llm, db, store, log),
  };
}

/**
 * Pass 2 - filing into the tree pass 1 fixed - as whichever implementation
 * `config.categorizer` selects, behind the shared `BatchCategorizer`
 * interface, so `runIngest`, `recategorizeAll` and "Find bookmarks for this
 * category" are identical either way. Neither ever creates a category:
 *
 * - `claude-cli` (the DEFAULT): the prompt-and-parse `Categorizer`, on whichever
 *   provider the assignment role resolves to - the flat-rate Claude
 *   subscription by default (zero marginal cost), or a paid pi-ai model when
 *   the owner picked one for that pass (issue #70).
 * - `typesafe`: the opt-in beam-search walk (issue #61). PAID per token, so it
 *   is reached only via an explicit opt-in AND a resolved `TYPESAFE_API_KEY`,
 *   and `db` is required because the walk reads the real tree rather than a
 *   rendered copy of it. It calls no language model, so the assignment role
 *   is never built for it.
 */
export function buildFilingCategorizer(
  config: Config,
  llm: LlmFactory,
  db: Database,
  store: CredentialStore,
  log: Log = () => {},
): BatchCategorizer {
  if (config.categorizer !== 'typesafe') {
    const assignment = llm.forRole('assignment');
    return new Categorizer(toRunner(assignment, { json: true }), {
      model: assignment.model,
      maxDepth: config.maxCategoryDepth,
    });
  }

  // Refuses before anything can spend money; the key's VALUE is never printed.
  const apiKey = requireTypeSafeCredentials(store);
  const ts = config.typesafe;
  return new TypeSafeCategorizer(
    {
      db,
      asker: new TypeSafeLevelAsker({
        apiKey,
        model: ts.model,
        baseURL: ts.baseUrl,
        logger: log,
      }),
      logger: log,
    },
    {
      beamWidth: ts.beamWidth,
      maxDepth: config.maxCategoryDepth,
      confidenceThreshold: ts.confidenceThreshold,
      multiLabelThreshold: ts.multiLabelThreshold,
      maxLabels: ts.maxLabels,
      concurrency: ts.concurrency,
    },
  );
}

/**
 * The language-model roles a sync (or `recategorize`) under `config` calls:
 * the taxonomy pass always, and the assignment role only when a language
 * model files - Jev calls none. What a preflight must check, and nothing
 * more, so a filing provider no screen shows under Jev can never block it.
 */
export function syncLlmRoles(config: Config): LlmRole[] {
  return config.categorizer === 'typesafe' ? ['taxonomy'] : ['taxonomy', 'assignment'];
}

/**
 * Pass 1's designer, sized against the taxonomy model's context window (issue
 * #109). One constructor for every caller that designs a tree - `run`,
 * `recategorize`, the in-app sync and `eval-categorizers` - so none of them
 * can design with a different notion of how much fits.
 */
export function buildTaxonomyDesigner(config: Config, llm: LlmFactory, log: Log = () => {}): TaxonomyDesigner {
  return new LlmTaxonomyDesigner(toRunner(llm.forRole('taxonomy'), { json: true }), {
    minDepth: config.minCategoryDepth,
    maxDepth: config.maxCategoryDepth,
    contextWindow: taxonomyContextWindow(llm),
    log,
  });
}

/**
 * The taxonomy model's context window, from the catalog the providers already
 * carry - never a second, hand-maintained map. The static entry of a
 * recommended model answers first (no I/O); a model picked from a provider's
 * full catalog is asked of its client, which reads that same local catalog
 * (no request, no spend). Undefined when neither knows, which the designer
 * turns into its safe default.
 */
export function taxonomyContextWindow(llm: LlmFactory): () => Promise<number | undefined> {
  return async () => llm.describe('taxonomy').contextWindow ?? (await llm.forRole('taxonomy').contextWindow?.());
}

/**
 * Say out loud, before any call is made, how each pass is billed.
 *
 * `AGENTS.md`'s hardest constraint is that no code path may silently spend
 * money. Either pass can now run on a metered API - the assignment pass on
 * TypeSafe (issue #61), and either pass on a pi-ai model billed per token to
 * the owner's key (issue #70) - so BOTH passes are announced every run,
 * printed by the CLI and surfaced in the viewer's sync progress, rather than
 * inferred from a config file or a saved setting.
 */
export function reportCategorizerBilling(config: Config, llm: LlmFactory, log: Log): void {
  if (config.categorizer === 'typesafe') {
    log(`Assignment pass: ${jevBillingLine(config)}`);
  } else {
    const assignment = llm.describe('assignment');
    log(`Assignment pass: ${passLine(assignment)}`);
  }
  log(`Taxonomy pass: ${passLine(llm.describe('taxonomy'))}`);
}

/**
 * Jev's billing, as the assignment pass and "Find bookmarks for this
 * category" both announce it.
 */
export function jevBillingLine(config: Config): string {
  const model = config.typesafe.model ?? DEFAULT_TYPESAFE_MODEL;
  return (
    `TypeSafe Jev (${model}) - ${billingLabel('per-token')}. ` +
    'Switch the categorization method back to the language model to stop paying TypeSafe per call.'
  );
}

/**
 * One pass's billing, plus its provider's risk notice when it carries one -
 * the subscription driven through pi is announced as such on every run, not
 * only where it was chosen.
 */
function passLine(pass: RoleDescription): string {
  const line = `${pass.providerId} / ${pass.model} - ${billingLabel(pass.billing)}.`;
  return pass.warning ? `${line} ${pass.warning}` : line;
}

/** The in-app control that chose the model a pass runs on, for a preflight message. */
export interface PassSetting {
  role: LlmRole;
  /** What the owner calls it, e.g. "The phase 2 (filing) language model". */
  label: string;
  /** The Settings field that picks it, and the phase it sits under. */
  field: string;
  phase: string;
}

export const TAXONOMY_SETTING: PassSetting = {
  role: 'taxonomy',
  label: 'The phase 1 (taxonomy) language model',
  field: 'Taxonomy provider',
  phase: 'Phase 1 - Taxonomy',
};

/** The language model that files, when one does (never while Jev is the method). */
export const FILING_SETTING: PassSetting = {
  role: 'assignment',
  label: 'The phase 2 (filing) language model',
  field: 'Filing method',
  phase: 'Phase 2 - Filing',
};

/** Jev as a Settings choice, for a message about why it cannot run. */
export const JEV_SETTING: Pick<PassSetting, 'label' | 'field' | 'phase'> = {
  label: 'Jev (the phase 2 filing method)',
  field: 'Filing method',
  phase: 'Phase 2 - Filing',
};

/** The Settings fields behind {@link syncLlmRoles}, for an app preflight. */
export function syncPassSettings(config: Config): PassSetting[] {
  return config.categorizer === 'typesafe' ? [TAXONOMY_SETTING] : [TAXONOMY_SETTING, FILING_SETTING];
}

/**
 * {@link requireLlm} for the app: the same checks, but a failure names the
 * Settings field that picked the model and how to change it, ahead of the
 * adapter's own actionable detail - so the owner is never left holding a raw
 * provider error about a model they do not know they chose.
 */
export async function requirePassSettings(llm: LlmFactory, settings: PassSetting[]): Promise<void> {
  for (const setting of settings) {
    const health = await llm.check(setting.role);
    if (health.state === 'ok') continue;
    throw new Error(passSettingProblem(setting, health.detail));
  }
}

/** The sentence {@link requirePassSettings} throws, for a caller that reports rather than throws. */
export function passSettingProblem(setting: Pick<PassSetting, 'label' | 'field' | 'phase'>, detail: string): string {
  const reason = /[.!?]$/.test(detail.trim()) ? detail.trim() : `${detail.trim()}.`;
  return (
    `${setting.label} cannot run: ${reason} ` +
    `To use a different one, open Settings and change "${setting.field}" under ${setting.phase}.`
  );
}

/**
 * Assert the provider backing these roles can actually run, with the adapter's
 * own actionable message. Availability is the adapter's business (for
 * `claude-cli`: does the binary resolve), never a hardcoded token check.
 */
export async function requireLlm(llm: LlmFactory, roles: LlmRole[]): Promise<void> {
  for (const role of roles) {
    const health = await llm.check(role);
    // The detail is the adapter's own actionable message (and names the
    // provider when the configured id does not exist at all).
    if (health.state !== 'ok') throw new Error(health.detail);
  }
}
