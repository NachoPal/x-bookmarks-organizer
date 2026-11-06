import { describe, it, expect } from 'vitest';
import type { ProviderDefinition, ProviderModel } from '../llm/types';
import { buildSettingsCatalog } from './catalog';
import {
  createModelBrowser,
  requireCatalogModels,
  retiredModelProblem,
  verifyCatalogModels,
  type CatalogPass,
} from './model-browser';

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

describe('a saved model the installed catalog no longer lists (run-time check)', () => {
  const catalog = buildSettingsCatalog();
  const TAXONOMY: CatalogPass = { role: 'taxonomy', label: 'The taxonomy model', field: 'Taxonomy provider', phase: 'Phase 1' };
  const FILING: CatalogPass = { role: 'assignment', label: 'The filing model', field: 'Filing method', phase: 'Phase 2' };
  const problem = (pass: CatalogPass, detail: string) => `${pass.label} cannot run: ${detail}. Change "${pass.field}".`;

  it('names the saved model and the Settings field, and never swaps the model', async () => {
    const browser = createModelBrowser(catalogProvider().lookup);
    const settings = {
      taxonomyProvider: 'pi-ai',
      taxonomyModel: 'opencode/kimi-k1-retired',
      assignmentProvider: 'pi-ai',
      assignmentModel: 'opencode/kimi-k2',
    };
    expect(await retiredModelProblem(settings, catalog, browser, TAXONOMY, problem)).toBe(
      'The taxonomy model cannot run: the saved model "opencode/kimi-k1-retired" is no longer in the OpenCode Zen ' +
        'model list - the installed model library dropped it. Change "Taxonomy provider".',
    );
    expect(await retiredModelProblem(settings, catalog, browser, FILING, problem)).toBeUndefined();
    await expect(requireCatalogModels(settings, catalog, browser, [FILING, TAXONOMY], problem)).rejects.toThrow(
      '"opencode/kimi-k1-retired" is no longer in the OpenCode Zen model list',
    );
    expect(settings.taxonomyModel).toBe('opencode/kimi-k1-retired');
  });

  it("checks claude-cli's Claude catalog too, against the real installed pi catalog", async () => {
    const browser = createModelBrowser();
    const settings = { taxonomyProvider: 'claude-cli', taxonomyModel: 'anthropic/claude-sonnet-3-retired', assignmentProvider: 'claude-cli' };
    expect(await retiredModelProblem(settings, catalog, browser, TAXONOMY, problem)).toContain(
      '"anthropic/claude-sonnet-3-retired" is no longer in the Claude models (Anthropic) model list',
    );
    // A new 1.5.0 model is listed, so it runs.
    await expect(
      requireCatalogModels({ ...settings, taxonomyModel: 'anthropic/claude-sonnet-5-5' }, catalog, browser, [TAXONOMY], problem),
    ).resolves.toBeUndefined();
  });

  it('says nothing for Recommended, a local name, a legacy unprefixed id, an unread catalog or another role', async () => {
    const browser = createModelBrowser(catalogProvider().lookup);
    const cases = [
      { taxonomyProvider: 'pi-ai', assignmentProvider: 'pi-ai' },
      { taxonomyProvider: 'pi-ai', taxonomyModel: 'local/qwen3', assignmentProvider: 'pi-ai' },
      { taxonomyProvider: 'claude-cli', taxonomyModel: 'claude-sonnet-5', assignmentProvider: 'pi-ai' },
      // openrouter's first read throws: the provider's own check() decides instead.
      { taxonomyProvider: 'pi-ai', taxonomyModel: 'openrouter/x/y', assignmentProvider: 'pi-ai' },
    ];
    for (const settings of cases) {
      expect(await retiredModelProblem(settings, catalog, browser, TAXONOMY, problem), JSON.stringify(settings)).toBeUndefined();
    }
    expect(
      await retiredModelProblem(
        { taxonomyProvider: 'pi-ai', taxonomyModel: 'opencode/gone', assignmentProvider: 'pi-ai' },
        catalog,
        browser,
        { ...TAXONOMY, role: 'summary' },
        problem,
      ),
    ).toBeUndefined();
  });
});
