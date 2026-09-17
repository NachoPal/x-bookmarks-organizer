import type { ProviderDefinition } from './types';

/**
 * The provider registry.
 *
 * Static registration (see `./providers/index.ts`), not filesystem scanning: it
 * survives `tsc` output, it is greppable, and it lets an unknown
 * `XBOOKMARKS_LLM_PROVIDER` fail with the list of ids that do exist.
 */
const providers = new Map<string, ProviderDefinition>();

export function registerProvider(def: ProviderDefinition): void {
  providers.set(def.id, def);
}

export function getProvider(id: string): ProviderDefinition | undefined {
  return providers.get(id);
}

export function listProviders(): ProviderDefinition[] {
  return [...providers.values()];
}

/** Ids of every registered provider, for error messages and docs. */
export function providerIds(): string[] {
  return [...providers.keys()];
}
