/**
 * The catalog of categorization choices the in-app settings selector offers.
 *
 * Shape and role mirror fixowl's `AGENT_MODEL_CATALOG`: there is no API to ask
 * a CLI agent what models and effort levels it accepts, so the provider adapter
 * that will pass the values on is the single source of truth. Here that source
 * is the provider registry itself (`src/llm/registry.ts`) rather than a second
 * hand-maintained table - a provider declares its own `models`/`efforts`
 * (`src/llm/types.ts`), so registering one (as `pi-ai` was, issue #70) makes it
 * appear in the dropdowns with no change to this file or to the viewer.
 *
 * Nothing here is a secret: it is a pure description of what CAN be chosen,
 * safe to ship to the browser. Whether a choice can actually RUN (a binary, a
 * key) is availability, answered separately by the provider's `check()` and the
 * credential chain.
 */
import { CATEGORIZER_IDS, TYPESAFE_API_KEY, type CategorizerId } from '../config';
import { listProviders } from '../llm/registry';
import '../llm/providers';
import { suggestedModelFor, type Billing, type LlmRole } from '../llm/types';

export interface CatalogModel {
  id: string;
  label: string;
  /** One-line hint shown next to the option, as fixowl's picker does. */
  description?: string;
  /** Roles this model is the provider's own suggestion for. */
  suggestedFor: LlmRole[];
  /**
   * Tokens the model accepts per request, as its provider declares it - the
   * figure a context-aware taxonomy pass (issue #109) sizes itself against.
   */
  contextWindow?: number;
  /** Most tokens it generates per response. */
  maxOutputTokens?: number;
  /** The credential this model needs, by NAME (never a value). */
  requiresKey?: string;
}

export interface CatalogProvider {
  id: string;
  label: string;
  billing: Billing;
  /** A risk the selector must show at the point of choice (`ProviderDefinition.warning`). */
  warning?: string;
  models: CatalogModel[];
  /** Ascending effort levels, empty when the provider has no effort axis. */
  efforts: string[];
  /** The model this provider suggests per role - the "Recommended" option's real value. */
  suggested: Record<'taxonomy' | 'assignment', string>;
}

/**
 * A categorization METHOD: which implementation files a bookmark into the tree.
 * Deliberately not the same axis as the provider (see `AGENTS.md`): Jev takes
 * no prompt and returns no text, so it is not an LLM provider at all.
 */
export interface CatalogMethod {
  id: CategorizerId;
  label: string;
  description: string;
  /** Absent when the cost is the chosen PROVIDER's, not the method's own. */
  billing?: Billing;
  /** Credential the method refuses to run without, when it has one. */
  requiresKey?: string;
}

export interface SettingsCatalog {
  methods: CatalogMethod[];
  providers: CatalogProvider[];
}

const METHOD_COPY: Record<CategorizerId, Omit<CatalogMethod, 'id'>> = {
  // The id predates issue #70 and is kept because it is persisted and is an
  // `XBOOKMARKS_CATEGORIZER` value; it means "a language model files each
  // bookmark", on whichever provider the filing pass names.
  'claude-cli': {
    label: 'Language model',
    description:
      'A model reads each bookmark and files it into the tree, on the provider and model ' +
      'chosen below - what it costs is that provider\'s billing.',
  },
  typesafe: {
    label: 'Jev (TypeSafe)',
    description:
      'A classifier walks the tree level by level instead of prompting a model. ' +
      'PAID per token and needs a TypeSafe API key.',
    billing: 'per-token',
    requiresKey: TYPESAFE_API_KEY,
  },
};

function toCatalogProvider(id: string): CatalogProvider | undefined {
  const provider = listProviders().find((p) => p.id === id);
  if (!provider) return undefined;
  return {
    id: provider.id,
    label: provider.label,
    billing: provider.billing,
    ...(provider.warning ? { warning: provider.warning } : {}),
    models: provider.models.map((m) => ({
      id: m.id,
      label: m.label,
      description: m.description,
      suggestedFor: m.suggestedFor,
      contextWindow: m.contextWindow,
      maxOutputTokens: m.maxOutputTokens,
      requiresKey: m.requiresKey,
    })),
    efforts: provider.capabilities.effort ? [...(provider.efforts ?? [])] : [],
    suggested: {
      taxonomy: suggestedModelFor(provider, 'taxonomy'),
      assignment: suggestedModelFor(provider, 'assignment'),
    },
  };
}

/** Every method and provider the owner can pick between, built from the registry. */
export function buildSettingsCatalog(): SettingsCatalog {
  return {
    methods: CATEGORIZER_IDS.map((id) => ({ id, ...METHOD_COPY[id] })),
    providers: listProviders()
      .map((p) => toCatalogProvider(p.id))
      .filter((p): p is CatalogProvider => p !== undefined),
  };
}

export function catalogProvider(
  catalog: SettingsCatalog,
  id: string,
): CatalogProvider | undefined {
  return catalog.providers.find((p) => p.id === id);
}
