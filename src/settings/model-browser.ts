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
  settings: Pick<
    AppSettings,
    'taxonomyProvider' | 'taxonomyModel' | 'assignmentProvider' | 'assignmentModel' | 'fallbackProvider' | 'fallbackModel'
  >,
  catalog: SettingsCatalog,
  browser: ModelBrowser,
): Promise<string[]> {
  const errors: string[] = [];
  const passes = [
    { label: 'Taxonomy model', providerId: settings.taxonomyProvider, model: settings.taxonomyModel },
    { label: 'Filing model', providerId: settings.assignmentProvider, model: settings.assignmentModel },
    { label: "Jev's fallback model", providerId: settings.fallbackProvider ?? '', model: settings.fallbackModel },
  ];
  for (const { label, providerId, model } of passes) {
    if (!model) continue;
    const provider = catalogProvider(catalog, providerId);
    if (!provider || provider.models.some((m) => m.id === model)) continue;
    const source = sourceOfModel(provider, model);
    if (!source || source.freeform) continue;
    const listing = await browser.list(providerId, source.id);
    if (!listing.ok) {
      errors.push(`${label} "${model}": ${listing.error}`);
    } else if (!listing.models.some((m) => m.id === model)) {
      errors.push(
        `${label} "${model}" is not in the ${source.label} catalog. ` +
          'Pick one from the list, or check the id.',
      );
    }
  }
  return errors;
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
