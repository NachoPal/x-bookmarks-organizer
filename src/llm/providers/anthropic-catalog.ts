import type { ModelSource, ProviderModel, ProviderModelCatalog } from '../types';
import { CURATED_PI_MODELS, type PiRuntime } from './pi-ai';

/**
 * The Claude model list shared by `claude-cli` and `pi-claude-subscription`
 * (issue: dynamic Claude models, following #118).
 *
 * Neither provider is a pi-ai upstream - one shells out to the local `claude`
 * CLI, the other drives pi's Anthropic adapter over OAuth - but both run
 * Claude models under Anthropic's own ids, and pi already ships a maintained
 * Anthropic model catalog (`@earendil-works/pi-ai/providers/anthropic`) that
 * #118 taught this app to read as static, local, no-spend data. Investigation
 * for the local CLI: `claude --help` documents no model-listing subcommand or
 * flag (`--model` just takes an alias or a full snapshot name), and the
 * installed binary is a single compiled executable with no bundled model
 * manifest to read - so there is no reliable, offline-safe way to ask the CLI
 * for its own model list. pi's catalog is therefore the source for BOTH
 * providers, exactly as the brief calls for when no direct method exists.
 *
 * A model id here is `anthropic/<pi model id>` - the same `<source>/<model>`
 * shape every other catalog-backed provider uses (`sourceOfModel` in
 * `src/settings/catalog.ts` requires it) - so the searchable picker, its
 * "Recommended" highlighting and `validateSettings` all treat these two
 * providers exactly like `pi-ai`'s own upstreams. `parseAnthropicModelId`
 * strips that prefix back off before a call is actually made, and tolerates
 * an unprefixed legacy id too: a document saved before this change, or an
 * `XBOOKMARKS_MODEL`-style env var (never validated against the catalog),
 * still names a model the adapter can run.
 *
 * pi's catalog is a maintained snapshot, not a live registry: a brand-new
 * model release lags until the installed `@earendil-works/pi-ai` is bumped,
 * exactly like every other pi upstream already accepts.
 */

export const ANTHROPIC_SOURCE_ID = 'anthropic';

export interface CuratedAnthropicModel {
  /** pi's own (unprefixed) Anthropic model id. */
  id: string;
  label: string;
  role: string;
  suggestedFor: ProviderModel['suggestedFor'];
}

/**
 * The RECOMMENDED quick picks - a maintained shortlist, not the whole
 * catalog - shared by both providers so "Opus designs, Haiku files, Sonnet
 * summarizes" reads the same on either route. A pick with an empty
 * `suggestedFor` is surfaced first but is never a pass's default; append such
 * a pick, since `suggestedModelFor` falls back to the FIRST entry. The full
 * catalog beyond these is reached through {@link buildAnthropicModelCatalog}.
 */
export const CURATED_ANTHROPIC_MODELS: readonly CuratedAnthropicModel[] = [
  {
    id: 'claude-opus-5-5',
    label: 'Claude Opus 5.5',
    role: 'Newest Opus - the pick for designing the tree',
    suggestedFor: ['taxonomy'],
  },
  {
    id: 'claude-haiku-4-5',
    label: 'Claude Haiku 4.5',
    role: 'Fast - the pick for filing each bookmark, to conserve quota',
    suggestedFor: ['assignment', 'chat'],
  },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', role: 'Balanced - the pick for summaries', suggestedFor: ['summary'] },
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', role: 'Previous Opus', suggestedFor: [] },
];

export function anthropicModelId(bareId: string): string {
  return `${ANTHROPIC_SOURCE_ID}/${bareId}`;
}

/**
 * The raw Anthropic model id a provider actually runs with. Tolerant of a
 * legacy, unprefixed id (a document saved before this catalog existed, or an
 * `XBOOKMARKS_*_MODEL` env var, which is never validated against a catalog)
 * so it keeps working unchanged.
 */
export function parseAnthropicModelId(ref: string): string {
  const prefix = `${ANTHROPIC_SOURCE_ID}/`;
  return ref.startsWith(prefix) ? ref.slice(prefix.length) : ref;
}

function compactTokens(n: number): string {
  return n >= 1_000_000 ? `${Number((n / 1_000_000).toFixed(2))}M` : `${Math.round(n / 1000)}k`;
}

/** pi's own catalog entry for a bare Anthropic model id, for its context window. */
function piCatalogEntry(bareId: string) {
  return CURATED_PI_MODELS.find((c) => c.ref === anthropicModelId(bareId));
}

export interface AnthropicModelOptions {
  /** The credential the model needs to run, named - absent for the local CLI, which needs none. */
  requiresKey?: string;
  /** How this route bills/reaches the model, e.g. "Runs on your Claude subscription - no per-call charge." */
  billingNote: string;
}

/** The provider's short, recommended list - not the whole catalog. */
export function curatedAnthropicModels(opts: AnthropicModelOptions): ProviderModel[] {
  return CURATED_ANTHROPIC_MODELS.map((m) => {
    const catalog = piCatalogEntry(m.id);
    return {
      id: anthropicModelId(m.id),
      label: m.label,
      suggestedFor: m.suggestedFor,
      description:
        `${m.role}` + (catalog ? `, ${compactTokens(catalog.contextWindow)} context` : '') + `. ${opts.billingNote}`,
      contextWindow: catalog?.contextWindow,
      maxOutputTokens: catalog?.maxOutputTokens,
      ...(opts.requiresKey ? { requiresKey: opts.requiresKey } : {}),
    };
  });
}

function anthropicModelSource(opts: AnthropicModelOptions): ModelSource {
  return {
    id: ANTHROPIC_SOURCE_ID,
    label: 'Claude models (Anthropic)',
    kind: 'direct',
    billing: 'subscription',
    ...(opts.requiresKey ? { requiresKey: opts.requiresKey } : {}),
  };
}

/**
 * The full, browsable Claude catalog - pi's own Anthropic model list, read
 * locally with no request and no spend, exactly like `pi-ai`'s own
 * `modelCatalog` (see `src/llm/providers/pi-ai.ts`). `getRuntime` is the
 * CALLER's own lazily-loaded runtime (so a provider with test injection keeps
 * using the one fake it was built with, rather than this module loading a
 * second one).
 */
export function buildAnthropicModelCatalog(
  getRuntime: () => Promise<PiRuntime>,
  opts: AnthropicModelOptions,
): ProviderModelCatalog {
  return {
    sources: [anthropicModelSource(opts)],
    async listModels(source) {
      if (source !== ANTHROPIC_SOURCE_ID) {
        throw new Error(`This provider has no model source "${source}" (only "${ANTHROPIC_SOURCE_ID}").`);
      }
      const rt = await getRuntime();
      const models = await rt.listModels('anthropic');
      return models
        .map((model): ProviderModel => {
          const curated = CURATED_ANTHROPIC_MODELS.find((c) => c.id === model.id);
          return {
            id: anthropicModelId(model.id),
            label: model.name || model.id,
            suggestedFor: curated ? curated.suggestedFor : [],
            description:
              (curated ? `${curated.role}, ` : '') + `${compactTokens(model.contextWindow)} context. ${opts.billingNote}`,
            contextWindow: model.contextWindow,
            maxOutputTokens: model.maxTokens,
            ...(opts.requiresKey ? { requiresKey: opts.requiresKey } : {}),
          };
        })
        .sort((a, b) => a.label.localeCompare(b.label, 'en', { sensitivity: 'base' }));
    },
  };
}
