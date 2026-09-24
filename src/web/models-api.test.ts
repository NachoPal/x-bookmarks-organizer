import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer, MODELS_UNAVAILABLE_MESSAGE } from './server';
import { Database } from '../db/database';
import { buildSettingsCatalog } from '../settings/catalog';
import { createModelBrowser, type ModelBrowser } from '../settings/model-browser';
import { readSettings } from '../settings/settings';
import { createPiAiProvider, type PiRuntime } from '../llm/providers/pi-ai';
import { createClaudeCliProvider } from '../llm/providers/claude-cli';
import type { CredentialStore, ResolvedCredential } from '../creds/resolve';
import type { Api, Model } from '@earendil-works/pi-ai';
import type { ProviderDefinition } from '../llm/types';

/**
 * The model picker's server half: `GET /api/models` lists one source of a
 * provider's catalog, and `PUT /api/settings` checks a pinned model against
 * it. Entirely offline - the pi provider here runs on a FAKE runtime that
 * counts completions, so a test can assert that browsing and saving spend
 * nothing.
 */

function fakeModel(provider: string, id: string, name = id): Model<Api> {
  return {
    id,
    name,
    api: 'openai-completions',
    provider,
    baseUrl: 'https://example.invalid',
    reasoning: true,
    input: ['text'],
    cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 400_000,
    maxTokens: 32_000,
  };
}

function fakePi() {
  let completions = 0;
  const catalog: Record<string, Model<Api>[]> = {
    opencode: [fakeModel('opencode', 'kimi-k2', 'Kimi K2'), fakeModel('opencode', 'claude-fable-5', 'Claude Fable 5')],
    openrouter: [fakeModel('openrouter', 'google/gemini-2.5-flash', 'Google: Gemini 2.5 Flash')],
  };
  const runtime: PiRuntime = {
    findModel: async (upstream, id) => (catalog[upstream] ?? []).find((m) => m.id === id),
    listModels: async (upstream) => catalog[upstream] ?? [],
    localModel: (id) => fakeModel('local', id),
    clampEffort: (_m, level) => level,
    complete: async () => {
      completions += 1;
      throw new Error('no completion may run here');
    },
  };
  const provider = createPiAiProvider(async () => runtime);
  const lookup = (id: string): ProviderDefinition | undefined => (id === provider.id ? provider : undefined);
  return { browser: createModelBrowser(lookup), completions: () => completions };
}

/**
 * A fake Anthropic catalog with more than the old hardcoded three, standing
 * in for pi's real one - `claude-cli` and `pi-claude-subscription` now read
 * their full Claude model list through the same no-spend mechanism `pi-ai`
 * uses (see `src/llm/providers/anthropic-catalog.ts`).
 */
function fakeClaudeCatalog() {
  const models = [
    fakeModel('anthropic', 'claude-opus-4-8', 'Claude Opus 4.8'),
    fakeModel('anthropic', 'claude-haiku-4-5', 'Claude Haiku 4.5'),
    fakeModel('anthropic', 'claude-sonnet-5', 'Claude Sonnet 5'),
    fakeModel('anthropic', 'claude-opus-5', 'Claude Opus 5'),
    fakeModel('anthropic', 'claude-sonnet-4-6', 'Claude Sonnet 4.6'),
  ];
  const runtime: PiRuntime = {
    findModel: async (_upstream, id) => models.find((m) => m.id === id),
    listModels: async () => models,
    localModel: (id) => fakeModel('local', id),
    clampEffort: (_m, level) => level,
    complete: async () => {
      throw new Error('no completion may run here');
    },
  };
  const provider = createClaudeCliProvider(async () => runtime);
  const lookup = (id: string): ProviderDefinition | undefined => (id === provider.id ? provider : undefined);
  return { browser: createModelBrowser(lookup) };
}

function fakeStore(values: Record<string, string>): CredentialStore {
  return {
    get(key: string): ResolvedCredential {
      const value = values[key];
      return value ? { key, value, source: 'env' } : { key, source: 'none' };
    },
  };
}

const catalog = buildSettingsCatalog();

describe('GET /api/models', () => {
  let db: Database;
  let app: FastifyInstance;

  beforeEach(() => {
    db = new Database(':memory:');
  });
  afterEach(async () => {
    await app?.close();
    db.close();
  });

  it("returns one source's models from the provider's catalog - and spends nothing", async () => {
    const pi = fakePi();
    app = buildServer(db, { modelBrowser: pi.browser });
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/api/models?provider=pi-ai&source=opencode' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ provider: 'pi-ai', source: 'opencode' });
    expect(body.models.map((m: { id: string }) => m.id)).toEqual(['opencode/claude-fable-5', 'opencode/kimi-k2']);
    expect(body.models[0]).toMatchObject({
      label: 'Claude Fable 5',
      contextWindow: 400_000,
      maxOutputTokens: 32_000,
      price: { input: 3, output: 15 },
      requiresKey: 'OPENCODE_API_KEY',
    });
    expect(pi.completions()).toBe(0);
  });

  it('lists a source whose key is missing - browsing is free, the key is only for a run', async () => {
    const pi = fakePi();
    app = buildServer(db, { modelBrowser: pi.browser, credentials: fakeStore({}) });
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/api/models?provider=pi-ai&source=openrouter' });
    expect(res.statusCode).toBe(200);
    expect(res.json().models).toHaveLength(1);
  });

  it('degrades to 503 on a viewer built without a model browser', async () => {
    app = buildServer(db);
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/api/models?provider=pi-ai&source=opencode' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe(MODELS_UNAVAILABLE_MESSAGE);
  });

  it('answers 400 for a missing parameter and 404 for an unknown provider or source', async () => {
    app = buildServer(db, { modelBrowser: fakePi().browser });
    await app.ready();
    expect((await app.inject({ method: 'GET', url: '/api/models?provider=pi-ai' })).statusCode).toBe(400);
    const unknownSource = await app.inject({ method: 'GET', url: '/api/models?provider=pi-ai&source=bedrock' });
    expect(unknownSource.statusCode).toBe(404);
    expect(unknownSource.json().error).toContain('opencode');
    const noProvider = await app.inject({ method: 'GET', url: '/api/models?provider=nope&source=x' });
    expect(noProvider.statusCode).toBe(404);
  });

  it("lists claude-cli's own dynamic Claude catalog - more than the old hardcoded three, with context windows", async () => {
    const claude = fakeClaudeCatalog();
    app = buildServer(db, { modelBrowser: claude.browser });
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/api/models?provider=claude-cli&source=anthropic' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ provider: 'claude-cli', source: 'anthropic' });
    expect(body.models.length).toBeGreaterThan(3);
    expect(body.models.map((m: { id: string }) => m.id)).toContain('anthropic/claude-opus-5');
    expect(body.models.every((m: { contextWindow?: number }) => typeof m.contextWindow === 'number')).toBe(true);
  });

  it('answers 500 with the reason when the catalog cannot be read', async () => {
    const failing: ModelBrowser = {
      list: async () => {
        throw new Error('module not found');
      },
    };
    app = buildServer(db, { modelBrowser: failing });
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/api/models?provider=pi-ai&source=opencode' });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toContain('module not found');
  });
});

describe('PUT /api/settings against the full catalog', () => {
  let db: Database;
  let app: FastifyInstance;

  beforeEach(() => {
    db = new Database(':memory:');
  });
  afterEach(async () => {
    await app?.close();
    db.close();
  });

  it('persists a model picked from the catalog, per pass, and serves it back', async () => {
    const pi = fakePi();
    app = buildServer(db, { modelBrowser: pi.browser });
    await app.ready();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: {
        categorizer: 'claude-cli',
        taxonomyProvider: 'pi-ai',
        taxonomyModel: 'opencode/claude-fable-5',
        assignmentProvider: 'pi-ai',
        assignmentModel: 'openrouter/google/gemini-2.5-flash',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(readSettings(db, catalog)).toMatchObject({
      taxonomyProvider: 'pi-ai',
      taxonomyModel: 'opencode/claude-fable-5',
      assignmentProvider: 'pi-ai',
      assignmentModel: 'openrouter/google/gemini-2.5-flash',
    });
    const setup = (await app.inject({ method: 'GET', url: '/api/setup' })).json();
    expect(setup.settings.taxonomyModel).toBe('opencode/claude-fable-5');
    expect(pi.completions()).toBe(0);
  });

  it("refuses a well-formed id the source's catalog does not list, naming the source", async () => {
    app = buildServer(db, { modelBrowser: fakePi().browser });
    await app.ready();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { taxonomyProvider: 'pi-ai', taxonomyModel: 'opencode/claude-nope', assignmentProvider: 'claude-cli' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('is not in the OpenCode Zen catalog');
    expect(readSettings(db, catalog)).toBeUndefined();
  });

  it('accepts any name on the local (freeform) source - no catalog knows it', async () => {
    app = buildServer(db, { modelBrowser: fakePi().browser });
    await app.ready();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { taxonomyProvider: 'pi-ai', taxonomyModel: 'local/llama3.1:8b', assignmentProvider: 'claude-cli' },
    });
    expect(res.statusCode).toBe(200);
  });

  it("refuses a pi-ai source id for claude-cli, which only ever browses its OWN (Anthropic) catalog", async () => {
    app = buildServer(db, { modelBrowser: fakePi().browser });
    await app.ready();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { taxonomyProvider: 'claude-cli', taxonomyModel: 'opencode/claude-fable-5', assignmentProvider: 'claude-cli' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('names no model source of provider "claude-cli"');
    const cli = catalog.providers.find((p) => p.id === 'claude-cli')!;
    expect(cli.sources!.map((s) => s.id)).toEqual(['anthropic']);
  });
});

describe('GET /api/setup - per-upstream key presence', () => {
  it("reports each pi upstream key's presence and source by name, never its value", async () => {
    const db = new Database(':memory:');
    const app = buildServer(db, { credentials: fakeStore({ OPENCODE_API_KEY: 'oc-secret-value-123' }) });
    try {
      await app.ready();
      const res = await app.inject({ method: 'GET', url: '/api/setup' });
      const keys = res.json().credentials.providerKeys;
      expect(keys.OPENCODE_API_KEY).toEqual({ present: true, source: 'env' });
      expect(keys.OPENROUTER_API_KEY).toEqual({ present: false });
      expect(keys.GEMINI_API_KEY).toEqual({ present: false });
      expect(res.body).not.toContain('oc-secret-value-123');
    } finally {
      await app.close();
      db.close();
    }
  });
});

/**
 * The models `@earendil-works/pi-ai` 0.87.1 added, read through the REAL
 * provider registry and the REAL installed catalog - static JSON in the
 * package, so still no request and no spend. A later pi bump that drops one
 * fails here instead of silently shrinking the picker.
 */
describe('the pi-ai 0.87.1 models, through the real installed catalog', () => {
  let db: Database;
  let app: FastifyInstance;
  let realFetch: typeof fetch;
  let requests = 0;

  beforeEach(async () => {
    db = new Database(':memory:');
    realFetch = globalThis.fetch;
    requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      throw new Error('browsing the catalog must never reach the network');
    }) as typeof fetch;
    app = buildServer(db, { modelBrowser: createModelBrowser() });
    await app.ready();
  });
  afterEach(async () => {
    await app?.close();
    db.close();
    globalThis.fetch = realFetch;
    expect(requests).toBe(0);
  });

  async function listed(provider: string, source: string) {
    const res = await app.inject({ method: 'GET', url: `/api/models?provider=${provider}&source=${source}` });
    expect(res.statusCode).toBe(200);
    const models = res.json().models as Array<{ id: string; label: string; contextWindow: number; maxOutputTokens: number }>;
    return new Map(models.map((m) => [m.id, m]));
  }

  it('lists Claude Opus 5.5 on every Claude route: claude-cli, pi-claude-subscription and pi-ai', async () => {
    for (const provider of ['claude-cli', 'pi-claude-subscription', 'pi-ai']) {
      const opus = (await listed(provider, 'anthropic')).get('anthropic/claude-opus-5-5');
      expect(opus, provider).toMatchObject({ label: 'Claude Opus 5.5', contextWindow: 1_000_000, maxOutputTokens: 128_000 });
    }
  });

  it("lists GPT-6 Sol and GPT-6 Luna in pi-ai's OpenAI source", async () => {
    const openai = await listed('pi-ai', 'openai');
    expect(openai.get('openai/gpt-6-sol')).toMatchObject({ label: 'GPT-6 Sol', contextWindow: 272_000, maxOutputTokens: 128_000 });
    expect(openai.get('openai/gpt-6-luna')).toMatchObject({ label: 'GPT-6 Luna', contextWindow: 272_000, maxOutputTokens: 128_000 });
  });

  it('saves the new models as per-pass picks, with Opus 5.5 the taxonomy suggestion on every Claude route', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: {
        categorizer: 'claude-cli',
        taxonomyProvider: 'claude-cli',
        taxonomyModel: 'anthropic/claude-opus-5-5',
        assignmentProvider: 'pi-ai',
        assignmentModel: 'openai/gpt-6-luna',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(readSettings(db, catalog)).toMatchObject({
      taxonomyModel: 'anthropic/claude-opus-5-5',
      assignmentModel: 'openai/gpt-6-luna',
    });
    for (const id of ['claude-cli', 'pi-claude-subscription', 'pi-ai']) {
      const provider = catalog.providers.find((p) => p.id === id)!;
      expect(provider.suggested, id).toMatchObject({
        taxonomy: 'anthropic/claude-opus-5-5',
        assignment: 'anthropic/claude-haiku-4-5',
      });
    }
  });
});
