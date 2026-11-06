/**
 * Browsing a provider's FULL model catalog from the settings selector.
 *
 * The selector's catalog (`./catalog.ts`) ships each provider's short list of
 * recommended models with `/api/setup`. A provider that reaches far more than
 * that - `pi-ai`, whose OpenRouter upstream alone lists hundreds - also
 * declares `sources`, and this is what lists one source's models when the
 * owner picks it (`GET /api/models`), and what checks a saved choice against
 * that list.
 *
 * Every read here goes through `ProviderDefinition.modelCatalog`, whose
 * contract is that it is LOCAL data: no request, no key, no spend. That is
 * what makes it safe to answer for a source the owner has no key for yet -
 * the list shows what a key WOULD unlock, and the selector says it is missing.
 */
import { getProvider } from '../llm/registry';
import '../llm/providers';
import type { ProviderDefinition, ProviderModel } from '../llm/types';
import { catalogProvider, sourceOfModel, type CatalogModel, type SettingsCatalog } from './catalog';
import type { AppSettings } from './settings';

export type ModelListing =
  | { ok: true; models: CatalogModel[] }
  | { ok: false; reason: 'unknown-provider' | 'unknown-source'; error: string };

export interface ModelBrowser {
  /** Every model of one source of one provider, from its local catalog. */
  list(providerId: string, source: string): Promise<ModelListing>;
}

function toCatalogModel(m: ProviderModel): CatalogModel {
  return {
    id: m.id,
    label: m.label,
    description: m.description,
    suggestedFor: m.suggestedFor,
    contextWindow: m.contextWindow,
    maxOutputTokens: m.maxOutputTokens,
    requiresKey: m.requiresKey,
    ...(m.price ? { price: m.price } : {}),
  };
}

/**
 * The browser over the registered providers. A source's list is read once and
 * kept: the catalog is data bundled with the installed SDK, so it cannot
 * change while the process runs. A failed read is not kept.
 */
export function createModelBrowser(
  lookup: (id: string) => ProviderDefinition | undefined = getProvider,
): ModelBrowser {
  const cache = new Map<string, Promise<CatalogModel[]>>();
  return {
    async list(providerId, source) {
      const provider = lookup(providerId);
      if (!provider) {
        return { ok: false, reason: 'unknown-provider', error: `Unknown provider "${providerId}".` };
      }
      const catalog = provider.modelCatalog;
      if (!catalog || !catalog.sources.some((s) => s.id === source)) {
        const sources = catalog?.sources.map((s) => s.id) ?? [];
        return {
          ok: false,
          reason: 'unknown-source',
          error: sources.length
            ? `Provider "${providerId}" has no model source "${source}" (sources: ${sources.join(', ')}).`
            : `Provider "${providerId}" has no model catalog to browse.`,
        };
      }
      const key = `${providerId}\u0000${source}`;
      let models = cache.get(key);
      if (!models) {
        models = catalog.listModels(source).then((list) => list.map(toCatalogModel));
        models.catch(() => cache.delete(key));
        cache.set(key, models);
      }
      return { ok: true, models: await models };
    },
  };
}

/**
 * The save-time half of settings validation: a pinned model of a catalog
 * provider must be one its catalog really lists. `validateSettings` can only
 * check the `<source>/<model>` SHAPE (it is synchronous, and also reads back
 * stored documents); this is the check that catches a typo'd or retired id
 * before a sync fails on it. A `freeform` source (a local server) has no
 * catalog, so any name there stands.
 */
export async function verifyCatalogModels(
  settings: Pick<AppSettings, 'taxonomyProvider' | 'taxonomyModel' | 'assignmentProvider' | 'assignmentModel'>,
  catalog: SettingsCatalog,
  browser: ModelBrowser,
): Promise<string[]> {
  const errors: string[] = [];
  const passes = [
    { label: 'Taxonomy model', providerId: settings.taxonomyProvider, model: settings.taxonomyModel },
    { label: 'Filing model', providerId: settings.assignmentProvider, model: settings.assignmentModel },
  ];
  for (const { label, providerId, model } of passes) {
    const found = await lookupCatalogModel(catalog, browser, providerId, model);
    if (found.state === 'unreadable') {
      errors.push(`${label} "${model}": ${found.error}`);
    } else if (found.state === 'unlisted') {
      errors.push(
        `${label} "${model}" is not in the ${found.sourceLabel} catalog. ` +
          'Pick one from the list, or check the id.',
      );
    }
  }
  return errors;
}

type CatalogLookup =
  | { state: 'listed' | 'not-applicable' }
  | { state: 'unlisted'; sourceLabel: string }
  | { state: 'unreadable'; error: string };

/**
 * Whether a pass's model is one its provider's catalog lists. Not applicable
 * to "Recommended" (no model), to a provider without a catalog, or to a
 * `freeform` source (a local server), whose names no catalog knows.
 */
async function lookupCatalogModel(
  catalog: SettingsCatalog,
  browser: ModelBrowser,
  providerId: string,
  model: string | undefined,
): Promise<CatalogLookup> {
  if (!model) return { state: 'not-applicable' };
  const provider = catalogProvider(catalog, providerId);
  if (!provider) return { state: 'not-applicable' };
  if (provider.models.some((m) => m.id === model)) return { state: 'listed' };
  const source = sourceOfModel(provider, model);
  if (!source || source.freeform) return { state: 'not-applicable' };
  const listing = await browser.list(providerId, source.id);
  if (!listing.ok) return { state: 'unreadable', error: listing.error };
  return listing.models.some((m) => m.id === model)
    ? { state: 'listed' }
    : { state: 'unlisted', sourceLabel: source.label };
}

/** One pass a run would make, as the Settings field that chose its model. */
export interface CatalogPass {
  /** `taxonomy` or `assignment` - the two passes Settings chooses a model for; any other role is skipped. */
  role: string;
  label: string;
  field: string;
  phase: string;
}

/**
 * The run-time half of the same check: a model SAVED before the installed
 * model library was upgraded can name an id the new catalog no longer lists
 * (pi drops retired models between versions). The save-time check above
 * cannot catch that - it ran against the OLD catalog - so a run checks the
 * stored choice again before it starts, and names the Settings field to
 * change instead of running a model the catalog no longer vouches for. The
 * saved choice is never switched for the owner.
 *
 * Answers the owner-facing sentence (`problem` words it, naming the field),
 * or undefined when the model is listed or nothing can be said. A catalog
 * that cannot be read is not a reason to refuse: the provider's own `check()`
 * still decides whether the model can run, so this only ever ADDS a clearer
 * refusal.
 */
export async function retiredModelProblem(
  settings: Pick<AppSettings, 'taxonomyProvider' | 'taxonomyModel' | 'assignmentProvider' | 'assignmentModel'>,
  catalog: SettingsCatalog,
  browser: ModelBrowser,
  pass: CatalogPass,
  problem: (pass: CatalogPass, detail: string) => string,
): Promise<string | undefined> {
  if (pass.role !== 'taxonomy' && pass.role !== 'assignment') return undefined;
  const providerId = pass.role === 'taxonomy' ? settings.taxonomyProvider : settings.assignmentProvider;
  const model = pass.role === 'taxonomy' ? settings.taxonomyModel : settings.assignmentModel;
  try {
    const found = await lookupCatalogModel(catalog, browser, providerId, model);
    return found.state === 'unlisted' ? problem(pass, retiredModelDetail(model!, found.sourceLabel)) : undefined;
  } catch {
    return undefined;
  }
}

/** {@link retiredModelProblem} for each pass a run makes, thrown - for a preflight. */
export async function requireCatalogModels(
  settings: Pick<AppSettings, 'taxonomyProvider' | 'taxonomyModel' | 'assignmentProvider' | 'assignmentModel'>,
  catalog: SettingsCatalog,
  browser: ModelBrowser,
  passes: readonly CatalogPass[],
  problem: (pass: CatalogPass, detail: string) => string,
): Promise<void> {
  for (const pass of passes) {
    const refusal = await retiredModelProblem(settings, catalog, browser, pass, problem);
    if (refusal) throw new Error(refusal);
  }
}

/** Why a saved model cannot be used: the installed catalog no longer lists it. */
export function retiredModelDetail(model: string, sourceLabel: string): string {
  return (
    `the saved model "${model}" is no longer in the ${sourceLabel} model list - ` +
    'the installed model library dropped it'
  );
}

/**
 * One model's catalog entry - its label and, for a paid model, its price - so
 * a point-of-spend notice can say what a call costs (security review 2, #20).
 * The recommended list answers first; a model picked from a source's full
 * catalog is found in that source's listing. Both are local reads: no
 * request, no key, no spend. Undefined for a model no catalog lists (a local
 * server's, or a legacy id).
 */
export async function findCatalogModel(
  catalog: SettingsCatalog,
  browser: ModelBrowser,
  providerId: string,
  model: string,
): Promise<CatalogModel | undefined> {
  const provider = catalogProvider(catalog, providerId);
  if (!provider) return undefined;
  const recommended = provider.models.find((m) => m.id === model);
  if (recommended) return recommended;
  const source = sourceOfModel(provider, model);
  if (!source || source.freeform) return undefined;
  try {
    const listing = await browser.list(providerId, source.id);
    return listing.ok ? listing.models.find((m) => m.id === model) : undefined;
  } catch {
    return undefined;
  }
}
