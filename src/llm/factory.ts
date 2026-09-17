import type { Config } from '../config';
import type { CredentialStore } from '../creds/resolve';
import { getProvider, providerIds } from './registry';
import './providers';
import {
  suggestedModelFor,
  type Billing,
  type Health,
  type LlmClient,
  type LlmConfig,
  type LlmRole,
  type ProviderDefinition,
  type ProviderParams,
  type ResolvedProviderConfig,
} from './types';

/** How a role's provider/model/params were resolved. */
export interface RoleDescription {
  providerId: string;
  model: string;
  billing: Billing;
}

/**
 * Resolves the LLM client a given role should use.
 *
 * Construction is lazy: nothing is spawned or contacted until a call is made,
 * so a viewer can start, report *why* a provider is unavailable, and still
 * serve everything that does not need a model.
 */
export interface LlmFactory {
  /** The client for a role, cached. Throws only when the configured provider id does not exist. */
  forRole(role: LlmRole): LlmClient;
  /** The role's provider health. Cheap by contract: never spends money or quota. */
  check(role: LlmRole): Promise<Health>;
  /** What a role resolved to, for logging and status endpoints. */
  describe(role: LlmRole): RoleDescription;
}

/** The message an unknown `XBOOKMARKS_LLM_PROVIDER` produces, wherever it surfaces. */
export function unknownProviderMessage(id: string): string {
  return (
    `Unknown LLM provider "${id}". Available: ${providerIds().join(', ')}. ` +
    'Set XBOOKMARKS_LLM_PROVIDER to one of these.'
  );
}

function providerIdFor(llm: LlmConfig, role: LlmRole): string {
  return llm.roles[role].provider ?? llm.defaultProvider;
}

/** Per-role override -> global override -> the provider's own suggestion for that role. */
function modelFor(llm: LlmConfig, role: LlmRole, provider: ProviderDefinition): string {
  return llm.roles[role].model ?? llm.defaultModel ?? suggestedModelFor(provider, role);
}

/** Drop params the provider does not support rather than failing - the same env may target several. */
function paramsFor(llm: LlmConfig, role: LlmRole, provider: ProviderDefinition): ProviderParams {
  const requested = llm.roles[role].params ?? {};
  return {
    effort: provider.capabilities.effort ? requested.effort : undefined,
    temperature: provider.capabilities.temperature ? requested.temperature : undefined,
    maxOutputTokens: requested.maxOutputTokens,
  };
}

/**
 * Build the app's LLM factory.
 *
 * `env` is the injected seam that backs {@link ResolvedProviderConfig}: adapters
 * ask for a key by name and never read `process.env` themselves, which is what
 * keeps provider selection and credential sourcing independent (and lets tests
 * run entirely offline). `store` is optional; when omitted, resolution is
 * env-only, byte-identical to before the credential chain existed - every test
 * that passes a fake `env` keeps passing unchanged. When passed, a key resolves
 * through the full chain (env -> .env -> keychain -> config file).
 */
export function createLlmFactory(
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
  store?: CredentialStore,
): LlmFactory {
  const llm = config.llm;
  const cfg: ResolvedProviderConfig = store ? { get: (key) => store.get(key).value } : { get: (key) => env[key] };
  const clients = new Map<LlmRole, LlmClient>();

  const resolveProvider = (role: LlmRole): ProviderDefinition => {
    const id = providerIdFor(llm, role);
    const provider = getProvider(id);
    if (!provider) throw new Error(unknownProviderMessage(id));
    return provider;
  };

  return {
    forRole(role) {
      const cached = clients.get(role);
      if (cached) return cached;
      const provider = resolveProvider(role);
      const client = provider.create(cfg, {
        model: modelFor(llm, role, provider),
        params: paramsFor(llm, role, provider),
      });
      clients.set(role, client);
      return client;
    },

    async check(role) {
      const id = providerIdFor(llm, role);
      const provider = getProvider(id);
      if (!provider) return { state: 'unconfigured', detail: unknownProviderMessage(id) };
      return provider.check(cfg);
    },

    describe(role) {
      const provider = resolveProvider(role);
      return {
        providerId: provider.id,
        model: modelFor(llm, role, provider),
        billing: provider.billing,
      };
    },
  };
}

/** Human-readable billing, for the line printed when the viewer starts. */
export function billingLabel(billing: Billing): string {
  switch (billing) {
    case 'subscription':
      return 'Claude subscription (no per-call charge; consumes your subscription quota)';
    case 'per-token':
      return 'pay-per-token';
    case 'local':
      return 'local model';
  }
}
