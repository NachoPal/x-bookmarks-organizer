import { describe, it, expect } from 'vitest';
import type { ProviderDefinition, ProviderModel } from '../llm/types';
import { buildSettingsCatalog } from './catalog';
import { createModelBrowser, verifyCatalogModels } from './model-browser';

/** A provider with a catalog of two sources, counting how often each is read. */
function catalogProvider() {
  const reads: string[] = [];
  const models: Record<string, ProviderModel[]> = {
    opencode: [{ id: 'opencode/kimi-k2', label: 'Kimi K2', suggestedFor: [], contextWindow: 262_144, price: { input: 1, output: 4 } }],
    openrouter: [],
  };
  const provider = {
    id: 'pi-ai',
    modelCatalog: {
      sources: [
        { id: 'opencode', label: 'OpenCode Zen', kind: 'gateway', billing: 'per-token', requiresKey: 'OPENCODE_API_KEY' },
        { id: 'openrouter', label: 'OpenRouter', kind: 'gateway', billing: 'per-token' },
        { id: 'local', label: 'Local', kind: 'local', billing: 'local', freeform: true },
      ],
      async listModels(source: string) {
        reads.push(source);
        if (source === 'openrouter' && reads.filter((r) => r === 'openrouter').length === 1) {
          throw new Error('transient');
        }
        return models[source] ?? [];
      },
    },
  } as unknown as ProviderDefinition;
  return { provider, reads, lookup: (id: string) => (id === 'pi-ai' ? provider : undefined) };
}

describe('createModelBrowser', () => {
  it('lists one source, and reads it once - the catalog is static data', async () => {
    const { lookup, reads } = catalogProvider();
    const browser = createModelBrowser(lookup);
    const first = await browser.list('pi-ai', 'opencode');
    await browser.list('pi-ai', 'opencode');
    expect(first).toEqual({
      ok: true,
      models: [{ id: 'opencode/kimi-k2', label: 'Kimi K2', description: undefined, suggestedFor: [], contextWindow: 262_144, maxOutputTokens: undefined, requiresKey: undefined, price: { input: 1, output: 4 } }],
    });
    expect(reads).toEqual(['opencode']);
  });

  it('does not keep a failed read, so a retry really retries', async () => {
    const { lookup, reads } = catalogProvider();
    const browser = createModelBrowser(lookup);
    await expect(browser.list('pi-ai', 'openrouter')).rejects.toThrow('transient');
    expect(await browser.list('pi-ai', 'openrouter')).toEqual({ ok: true, models: [] });
    expect(reads).toEqual(['openrouter', 'openrouter']);
  });

  it('names what exists for an unknown provider, source, or a provider with no catalog', async () => {
    const browser = createModelBrowser(catalogProvider().lookup);
    expect(await browser.list('nope', 'x')).toMatchObject({ ok: false, reason: 'unknown-provider' });
    const source = await browser.list('pi-ai', 'bedrock');
    expect(source).toMatchObject({ ok: false, reason: 'unknown-source' });
    expect(!source.ok && source.error).toContain('opencode, openrouter, local');
    // claude-cli now has ONE source of its own (its Claude catalog); a
    // provider with genuinely no catalog is what still answers this way.
    const real = createModelBrowser();
    expect(await real.list('claude-cli', 'bedrock')).toMatchObject({
      ok: false,
      reason: 'unknown-source',
      error: 'Provider "claude-cli" has no model source "bedrock" (sources: anthropic).',
    });
  });

  it("reads claude-cli's own Claude catalog - a real, local, no-spend read", async () => {
    const real = createModelBrowser();
    const listing = await real.list('claude-cli', 'anthropic');
    expect(listing.ok).toBe(true);
    if (listing.ok) {
      expect(listing.models.length).toBeGreaterThan(3);
      expect(listing.models.every((m) => typeof m.contextWindow === 'number')).toBe(true);
    }
  });
});

describe('verifyCatalogModels', () => {
  const catalog = buildSettingsCatalog();

  it('passes a listed model, a recommended pick, a local name and an unpinned pass', async () => {
    const browser = createModelBrowser(catalogProvider().lookup);
    expect(
      await verifyCatalogModels(
        { taxonomyProvider: 'pi-ai', taxonomyModel: 'opencode/kimi-k2', assignmentProvider: 'pi-ai', assignmentModel: 'local/qwen3' },
        catalog,
        browser,
      ),
    ).toEqual([]);
    expect(
      await verifyCatalogModels(
        { taxonomyProvider: 'pi-ai', taxonomyModel: 'anthropic/claude-opus-4-8', assignmentProvider: 'claude-cli' },
        catalog,
        browser,
      ),
    ).toEqual([]);
  });

  it('refuses an id its source does not list, per pass, naming the source', async () => {
    const browser = createModelBrowser(catalogProvider().lookup);
    const errors = await verifyCatalogModels(
      { taxonomyProvider: 'claude-cli', assignmentProvider: 'pi-ai', assignmentModel: 'opencode/kimi-k9' },
      catalog,
      browser,
    );
    expect(errors).toEqual([
      'Filing model "opencode/kimi-k9" is not in the OpenCode Zen catalog. Pick one from the list, or check the id.',
    ]);
  });
});
