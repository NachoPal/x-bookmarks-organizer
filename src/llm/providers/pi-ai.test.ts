import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Api, AssistantMessage, Context, Model } from '@earendil-works/pi-ai';
import { loadConfig } from '../../config';
import { buildCategorizers, reportCategorizerBilling } from '../../categorize/build';
import { Database } from '../../db/database';
import { createCredentialStore } from '../../creds/resolve';
import { createLlmFactory } from '../factory';
import type { ResolvedProviderConfig } from '../types';
import {
  CURATED_PI_MODELS,
  PI_AI_PROVIDER_ID,
  createPiAiProvider,
  REASONING_ALLOWANCE,
  loadPiRuntime,
  outputCeiling,
  parseModelRef,
  type PiRuntime,
} from './pi-ai';

/**
 * Every test here is offline. The adapter is driven through a FAKE pi runtime
 * (no SDK, no provider, no network); the two places the REAL SDK is loaded
 * read only its bundled catalog, or talk to a local `http` server standing in
 * for an OpenAI-compatible endpoint. No test can reach a paid API.
 */

function cfgOf(values: Record<string, string>): ResolvedProviderConfig {
  return { get: (key) => values[key] };
}

interface Call {
  model: Model<Api>;
  context: Context;
  options: Parameters<PiRuntime['complete']>[2];
}

function fakeModel(provider: string, id: string, extra: Partial<Model<Api>> = {}): Model<Api> {
  return {
    id,
    name: id,
    api: 'openai-completions',
    provider,
    baseUrl: 'https://example.invalid',
    reasoning: true,
    input: ['text'],
    cost: { input: 1, output: 5, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 123_456,
    maxTokens: 4_096,
    ...extra,
  };
}

function reply(text: string, extra: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text }],
    api: 'openai-completions',
    provider: 'x',
    model: 'x',
    usage: {
      input: 11,
      output: 7,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 18,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: 0,
    ...extra,
  } as AssistantMessage;
}

/** A pi runtime that knows a couple of models and records every call. */
function fakeRuntime(next: () => AssistantMessage = () => reply('{"ok":true}')) {
  const calls: Call[] = [];
  const known = new Set([
    'anthropic/claude-haiku-4-5',
    'openrouter/google/gemini-2.5-flash',
    'openai/gpt-5-mini',
    'opencode/claude-fable-5',
    'opencode/big-pickle',
  ]);
  const listed: string[] = [];
  const runtime: PiRuntime = {
    findModel: async (upstream, id) => (known.has(`${upstream}/${id}`) ? fakeModel(upstream, id) : undefined),
    listModels: async (upstream) => {
      listed.push(upstream);
      return [...known]
        .filter((ref) => ref.startsWith(`${upstream}/`))
        .map((ref) => fakeModel(upstream, ref.slice(upstream.length + 1)));
    },
    localModel: (id, endpoint) => fakeModel('local', id, { reasoning: false, contextWindow: endpoint.contextWindow }),
    clampEffort: (_model, level) => (level === 'max' ? 'high' : level),
    async complete(model, context, options) {
      calls.push({ model, context, options });
      return next();
    },
  };
  let loads = 0;
  return {
    calls,
    listed,
    loads: () => loads,
    provider: createPiAiProvider(async () => {
      loads += 1;
      return runtime;
    }),
  };
}

describe('parseModelRef', () => {
  it('splits the upstream off the FIRST slash, so OpenRouter ids keep theirs', () => {
    expect(parseModelRef('openrouter/google/gemini-2.5-flash')).toEqual({
      upstream: 'openrouter',
      modelId: 'google/gemini-2.5-flash',
    });
    expect(parseModelRef('local/llama3.1:8b')).toEqual({ upstream: 'local', modelId: 'llama3.1:8b' });
  });

  it('refuses a bare id or an upstream this app does not offer', () => {
    expect(parseModelRef('claude-haiku-4-5')).toBeUndefined();
    expect(parseModelRef('bedrock/whatever')).toBeUndefined();
    expect(parseModelRef('anthropic/')).toBeUndefined();
  });
});

describe('the pi-ai provider (fake runtime)', () => {
  it('implements the LlmClient contract: prompt + system in, text out, usage reported', async () => {
    const { provider, calls } = fakeRuntime(() => reply('{"categories":[]}'));
    const client = provider.create(cfgOf({ ANTHROPIC_API_KEY: 'sk-ant-api03-test' }), {
      model: 'anthropic/claude-haiku-4-5',
      params: { effort: 'medium' },
    });
    expect(client.providerId).toBe(PI_AI_PROVIDER_ID);
    expect(client.billing).toBe('per-token');

    const result = await client.complete({ prompt: 'file these', system: 'be terse' });
    expect(result).toEqual({
      text: '{"categories":[]}', // thinking blocks are not part of the answer
      model: 'anthropic/claude-haiku-4-5',
      providerId: PI_AI_PROVIDER_ID,
      usage: { inputTokens: 11, outputTokens: 7 },
    });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.model.provider).toBe('anthropic');
    expect(call.model.id).toBe('claude-haiku-4-5');
    expect(call.context.systemPrompt).toBe('be terse');
    expect(call.context.messages).toEqual([expect.objectContaining({ role: 'user', content: 'file these' })]);
    expect(call.options.apiKey).toBe('sk-ant-api03-test');
    expect(call.options.reasoning).toBe('medium');
  });

  it("clamps the effort to what the model supports, and sends none to a model that can't reason", async () => {
    const { provider, calls } = fakeRuntime();
    const cfg = cfgOf({ ANTHROPIC_API_KEY: 'sk-ant-api03-test', XBOOKMARKS_PIAI_BASE_URL: 'http://127.0.0.1:1/v1' });
    await provider.create(cfg, { model: 'anthropic/claude-haiku-4-5', params: { effort: 'max' } }).complete({ prompt: 'p' });
    await provider.create(cfg, { model: 'local/llama', params: { effort: 'high' } }).complete({ prompt: 'p' });
    expect(calls[0]!.options.reasoning).toBe('high');
    expect(calls[1]!.options.reasoning).toBeUndefined();
  });

  it("passes the key for THIS model's upstream, never another's", async () => {
    const { provider, calls } = fakeRuntime();
    const cfg = cfgOf({
      ANTHROPIC_API_KEY: 'sk-ant-api03-anthropic',
      OPENROUTER_API_KEY: 'sk-or-v1-openrouter',
      OPENAI_API_KEY: 'sk-proj-openai',
    });
    await provider.create(cfg, { model: 'openrouter/google/gemini-2.5-flash' }).complete({ prompt: 'p' });
    await provider.create(cfg, { model: 'openai/gpt-5-mini' }).complete({ prompt: 'p' });
    expect(calls.map((c) => c.options.apiKey)).toEqual(['sk-or-v1-openrouter', 'sk-proj-openai']);
  });

  it('resolves keys through the layered credential chain, not just the environment', async () => {
    const { provider, calls } = fakeRuntime();
    const store = createCredentialStore({
      env: {},
      projectRoot: '/nonexistent-project',
      configDir: '/nonexistent-config',
      platform: 'darwin',
      exec: (_cmd, args) => {
        // The OS keychain answers for exactly one key.
        if (args.includes('OPENROUTER_API_KEY')) return 'sk-or-v1-from-keychain\n';
        throw new Error('not found');
      },
    });
    const config = loadConfig({
      XBOOKMARKS_ASSIGNMENT_PROVIDER: 'pi-ai',
      XBOOKMARKS_MODEL: 'openrouter/google/gemini-2.5-flash',
    });
    // The same store-backed view `createLlmFactory(config, env, store)` hands
    // every adapter.
    const cfg: ResolvedProviderConfig = { get: (key) => store.get(key).value };
    const client = provider.create(cfg, { model: config.llm.roles.assignment.model! });
    await client.complete({ prompt: 'p' });
    expect(calls[0]!.options.apiKey).toBe('sk-or-v1-from-keychain');
  });

  it('is not ready without the upstream key, names it, and makes no call', async () => {
    const { provider, calls } = fakeRuntime();
    const cfg = cfgOf({ ANTHROPIC_API_KEY: 'sk-ant-api03-test' });
    const health = await provider.check(cfg, { model: 'openrouter/google/gemini-2.5-flash' });
    expect(health.state).toBe('unconfigured');
    expect(health.detail).toContain('OPENROUTER_API_KEY');
    expect(health.detail).toContain('PAID per token');
    await expect(
      provider.create(cfg, { model: 'openrouter/google/gemini-2.5-flash' }).complete({ prompt: 'p' }),
    ).rejects.toThrow(/OPENROUTER_API_KEY/);
    expect(calls).toHaveLength(0);
  });

  it('is ready when the key resolves, and the check itself spends nothing', async () => {
    const { provider, calls } = fakeRuntime();
    const health = await provider.check(cfgOf({ OPENAI_API_KEY: 'sk-proj-x' }), { model: 'openai/gpt-5-mini' });
    expect(health).toEqual({ state: 'ok', detail: expect.stringContaining('PAID per token') });
    expect(calls).toHaveLength(0);
  });

  it('refuses a Claude SUBSCRIPTION token, pointing at claude-cli, and never reads CLAUDE_CODE_OAUTH_TOKEN', async () => {
    const { provider, calls } = fakeRuntime();
    const subscription = cfgOf({ ANTHROPIC_API_KEY: 'sk-ant-oat01-abcdefghijklmnopqrstuvwxyz' });
    const health = await provider.check(subscription, { model: 'anthropic/claude-haiku-4-5' });
    expect(health.state).toBe('unconfigured');
    expect(health.detail).toContain('claude-cli');
    expect(health.detail).not.toContain('abcdefghijklmnop');
    await expect(
      provider.create(subscription, { model: 'anthropic/claude-haiku-4-5' }).complete({ prompt: 'p' }),
    ).rejects.toThrow(/claude-cli/);

    const tokenOnly = cfgOf({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-abcdefghijklmnopqrstuvwxyz' });
    expect((await provider.check(tokenOnly, { model: 'anthropic/claude-haiku-4-5' })).detail).toContain(
      'ANTHROPIC_API_KEY',
    );
    expect(calls).toHaveLength(0);
  });

  it('explains a malformed reference and an id pi does not know', async () => {
    const { provider } = fakeRuntime();
    const cfg = cfgOf({ ANTHROPIC_API_KEY: 'sk-ant-api03-test' });
    expect((await provider.check(cfg, { model: 'claude-haiku-4-5' })).detail).toContain('<upstream>/<model>');
    expect((await provider.check(cfg, { model: 'anthropic/claude-nope' })).detail).toContain('does not know');
    expect((await provider.check(cfg, {})).state).toBe('unconfigured');
  });

  it('needs a base URL for a local model, and bills it as local', async () => {
    const { provider } = fakeRuntime();
    expect((await provider.check(cfgOf({}), { model: 'local/llama' })).detail).toContain('XBOOKMARKS_PIAI_BASE_URL');
    const cfg = cfgOf({ XBOOKMARKS_PIAI_BASE_URL: 'http://127.0.0.1:11434/v1', XBOOKMARKS_PIAI_CONTEXT_WINDOW: '65536' });
    expect((await provider.check(cfg, { model: 'local/llama' })).state).toBe('ok');
    const client = provider.create(cfg, { model: 'local/llama' });
    expect(client.billing).toBe('local');
    expect(await client.contextWindow?.()).toBe(65_536);
    expect(provider.billingFor?.('local/llama')).toBe('local');
    expect(provider.billingFor?.('xai/grok-4.6')).toBe('per-token');
  });

  it("reports a model's context window at runtime, even for one outside the curated list", async () => {
    const { provider } = fakeRuntime();
    const client = provider.create(cfgOf({}), { model: 'openai/gpt-5-mini' });
    expect(await client.contextWindow?.()).toBe(123_456);
  });

  it('turns a failed request (reported as a message, not a throw) into a redacted error', async () => {
    const { provider } = fakeRuntime(() =>
      reply('', { stopReason: 'error', errorMessage: '401 invalid x-api-key sk-ant-api03-SECRETSECRETSECRET' }),
    );
    const client = provider.create(cfgOf({ ANTHROPIC_API_KEY: 'sk-ant-api03-test' }), {
      model: 'anthropic/claude-haiku-4-5',
    });
    const err = await client.complete({ prompt: 'p' }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('401 invalid x-api-key');
    expect((err as Error).message).not.toContain('SECRETSECRET');
  });

  it('refuses a response cut off at the output limit rather than handing back truncated JSON', async () => {
    const { provider } = fakeRuntime(() => reply('{"categories": [', { stopReason: 'length' }));
    const client = provider.create(cfgOf({ ANTHROPIC_API_KEY: 'sk-ant-api03-test' }), {
      model: 'anthropic/claude-haiku-4-5',
    });
    await expect(client.complete({ prompt: 'p' })).rejects.toThrow(/output limit/);
  });

  it('sends the role budget as maxTokens, plus the thinking allowance of the effort in force (#19)', async () => {
    const { provider, calls } = fakeRuntime();
    const cfg = cfgOf({ ANTHROPIC_API_KEY: 'sk-ant-api03-test' });
    // fakeModel's own maximum is 4,096, so use a budget below it.
    await provider
      .create(cfg, { model: 'anthropic/claude-haiku-4-5', params: { maxOutputTokens: 1_000 } })
      .complete({ prompt: 'p' });
    expect(calls[0]!.options.maxTokens).toBe(1_000);
    expect(calls[0]!.options.reasoning).toBeUndefined();

    // With an effort, the thinking allowance rides on top - still clamped to the model maximum.
    await provider
      .create(cfg, { model: 'anthropic/claude-haiku-4-5', params: { maxOutputTokens: 1_000, effort: 'low' } })
      .complete({ prompt: 'p' });
    expect(calls[1]!.options.reasoning).toBe('low');
    expect(calls[1]!.options.maxTokens).toBe(4_096);
  });

  it('names the cap that was actually hit, not the model maximum', async () => {
    const { provider } = fakeRuntime(() => reply('{"categories": [', { stopReason: 'length' }));
    const client = provider.create(cfgOf({ ANTHROPIC_API_KEY: 'sk-ant-api03-test' }), {
      model: 'anthropic/claude-haiku-4-5',
      params: { maxOutputTokens: 512 },
    });
    await expect(client.complete({ prompt: 'p' })).rejects.toThrow(/output limit \(512 tokens\)/);
  });

  it('loads the SDK once and reuses it', async () => {
    const { provider, loads } = fakeRuntime();
    const cfg = cfgOf({ ANTHROPIC_API_KEY: 'sk-ant-api03-test' });
    const client = provider.create(cfg, { model: 'anthropic/claude-haiku-4-5' });
    await client.complete({ prompt: 'a' });
    await client.complete({ prompt: 'b' });
    await provider.check(cfg, { model: 'anthropic/claude-haiku-4-5' });
    expect(loads()).toBe(1);
  });
});

describe('per-role selection through the factory', () => {
  const env = {
    XBOOKMARKS_TAXONOMY_PROVIDER: 'pi-ai',
    XBOOKMARKS_TAXONOMY_MODEL: 'openrouter/google/gemini-2.5-flash',
    XBOOKMARKS_ASSIGNMENT_PROVIDER: 'pi-ai',
    OPENROUTER_API_KEY: 'sk-or-v1-test',
    ANTHROPIC_API_KEY: 'sk-ant-api03-test',
  };

  it('resolves pi-ai for the taxonomy and assignment passes independently, leaving summaries alone', () => {
    const llm = createLlmFactory(loadConfig(env), env);
    expect(llm.describe('taxonomy')).toEqual({
      providerId: 'pi-ai',
      model: 'openrouter/google/gemini-2.5-flash',
      billing: 'per-token',
      contextWindow: 1_048_576,
    });
    // No model pinned for pass 2: pi-ai's own suggestion (Haiku-class) applies.
    expect(llm.describe('assignment')).toMatchObject({
      providerId: 'pi-ai',
      model: 'anthropic/claude-haiku-4-5',
      contextWindow: 200_000,
    });
    expect(llm.describe('summary').providerId).toBe('claude-cli');
  });

  it('builds both categorization passes on pi-ai clients', () => {
    const config = loadConfig(env);
    const llm = createLlmFactory(config, env);
    const db = new Database(':memory:');
    try {
      const built = buildCategorizers(config, llm, db, createCredentialStore({ env }));
      expect(built.taxonomer).toBeDefined();
      expect(llm.forRole('taxonomy').providerId).toBe('pi-ai');
      expect(llm.forRole('assignment').providerId).toBe('pi-ai');
    } finally {
      db.close();
    }
  });

  it('announces the per-token billing of BOTH passes before a run', () => {
    const config = loadConfig(env);
    const lines: string[] = [];
    reportCategorizerBilling(config, createLlmFactory(config, env), (m) => lines.push(m));
    expect(lines).toEqual([
      'Assignment pass: pi-ai / anthropic/claude-haiku-4-5 - pay-per-token.',
      'Taxonomy pass: pi-ai / openrouter/google/gemini-2.5-flash - pay-per-token.',
    ]);
  });

  it('is ready per pass only when THAT pass\'s upstream key resolves (real SDK catalog, no request)', async () => {
    const partial = { ...env, OPENROUTER_API_KEY: '' };
    const llm = createLlmFactory(loadConfig(partial), partial);
    expect((await llm.check('taxonomy')).detail).toContain('OPENROUTER_API_KEY');
    expect((await llm.check('assignment')).state).toBe('ok');
  });
});

describe('the curated model table vs the installed pi catalog', () => {
  it('restates pi\'s own context window, output limit and prices for every curated model', async () => {
    const runtime = await loadPiRuntime();
    for (const curated of CURATED_PI_MODELS) {
      const ref = parseModelRef(curated.ref);
      expect(ref, curated.ref).toBeDefined();
      if (!ref || ref.upstream === 'local') continue;
      const model = await runtime.findModel(ref.upstream, ref.modelId);
      expect(model, `${curated.ref} is not in the installed pi catalog`).toBeDefined();
      expect({ ref: curated.ref, contextWindow: curated.contextWindow, maxOutputTokens: curated.maxOutputTokens }).toEqual({
        ref: curated.ref,
        contextWindow: model!.contextWindow,
        maxOutputTokens: model!.maxTokens,
      });
      expect(curated.price).toEqual({ input: model!.cost.input, output: model!.cost.output });
    }
  });
});

describe('the REAL pi SDK against a local OpenAI-compatible endpoint', () => {
  let server: http.Server;
  let baseUrl: string;
  const requests: Array<{ url: string; auth: string | undefined; body: Record<string, unknown> }> = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        requests.push({ url: req.url ?? '', auth: req.headers.authorization, body: JSON.parse(raw || '{}') });
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const chunk = (payload: object) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
        const base = { id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'stub' };
        chunk({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '{"tree":' }, finish_reason: null }] });
        chunk({ ...base, choices: [{ index: 0, delta: { content: '[]}' }, finish_reason: null }] });
        chunk({
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
        });
        res.end('data: [DONE]\n\n');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('completes through pi end to end, with the prompt, system and key it was given', async () => {
    const provider = createPiAiProvider();
    const cfg = cfgOf({ XBOOKMARKS_PIAI_BASE_URL: baseUrl, XBOOKMARKS_PIAI_API_KEY: 'local-secret' });
    expect((await provider.check(cfg, { model: 'local/stub-model' })).state).toBe('ok');
    const result = await provider
      .create(cfg, { model: 'local/stub-model', params: { effort: 'high' } })
      .complete({ prompt: 'design a tree', system: 'you design taxonomies' });

    expect(result.text).toBe('{"tree":[]}');
    expect(result.usage).toEqual({ inputTokens: 9, outputTokens: 4 });
    const request = requests.at(-1)!;
    expect(request.url).toBe('/v1/chat/completions');
    expect(request.auth).toBe('Bearer local-secret');
    expect(request.body.model).toBe('stub-model');
    const messages = request.body.messages as Array<{ role: string; content: unknown }>;
    // A local server gets a plain `system` role, not OpenAI's `developer`.
    expect(messages[0]).toMatchObject({ role: 'system', content: 'you design taxonomies' });
    expect(JSON.stringify(messages.at(-1))).toContain('design a tree');
    expect(request.body).not.toHaveProperty('reasoning_effort');
  });
});

describe('the full pi model catalog (issue: auto-load the selector)', () => {
  it('offers every wired upstream as a source, with its key and per-token billing', () => {
    const catalog = createPiAiProvider(async () => {
      throw new Error('listing sources must not load the SDK');
    }).modelCatalog!;
    const ids = catalog.sources.map((s) => s.id);
    // The #70 four, OpenCode's two plans, the other gateways and the direct APIs, then local.
    for (const id of ['anthropic', 'openai', 'xai', 'openrouter', 'opencode', 'opencode-go', 'google', 'groq',
      'deepseek', 'mistral', 'together', 'cerebras', 'fireworks', 'moonshotai', 'vercel-ai-gateway']) {
      expect(ids, id).toContain(id);
    }
    expect(ids.at(-1)).toBe('local');
    expect(catalog.sources.find((s) => s.id === 'opencode')).toEqual({
      id: 'opencode',
      label: 'OpenCode Zen',
      kind: 'gateway',
      billing: 'per-token',
      requiresKey: 'OPENCODE_API_KEY',
    });
    expect(catalog.sources.find((s) => s.id === 'local')).toMatchObject({ billing: 'local', freeform: true });
    expect(catalog.sources.every((s) => s.id === 'local' || s.billing === 'per-token')).toBe(true);
  });

  it('lists one upstream on demand, sorted, with price and context from the catalog', async () => {
    const { provider, listed, loads } = fakeRuntime();
    expect(loads()).toBe(0);
    const models = await provider.modelCatalog!.listModels('opencode');
    expect(listed).toEqual(['opencode']);
    expect(models.map((m) => m.id)).toEqual(['opencode/big-pickle', 'opencode/claude-fable-5']);
    expect(models[1]).toMatchObject({
      contextWindow: 123_456,
      maxOutputTokens: 4_096,
      price: { input: 1, output: 5 },
      requiresKey: 'OPENCODE_API_KEY',
      suggestedFor: [],
    });
    expect(models[1]!.description).toContain('PAID');
    await expect(provider.modelCatalog!.listModels('bedrock')).rejects.toThrow(/no upstream "bedrock"/);
    expect(await provider.modelCatalog!.listModels('local')).toEqual([]);
  });

  it('keeps a recommended pick\'s role and suggestion when it is found in the full list', async () => {
    const { provider } = fakeRuntime();
    const [haiku] = await provider.modelCatalog!.listModels('anthropic');
    expect(haiku).toMatchObject({ id: 'anthropic/claude-haiku-4-5', suggestedFor: ['assignment', 'chat'] });
    expect(haiku!.description).toMatch(/^Fast and cheap/);
  });

  it('runs an OpenCode model on OPENCODE_API_KEY, billed per token - never on another upstream\'s key', async () => {
    const { provider, calls } = fakeRuntime();
    const ref = 'opencode/claude-fable-5';
    const withoutKey = cfgOf({ ANTHROPIC_API_KEY: 'sk-ant-api03-other', OPENROUTER_API_KEY: 'sk-or-other' });
    const missing = await provider.check(withoutKey, { model: ref });
    expect(missing.state).toBe('unconfigured');
    expect(missing.detail).toContain('OPENCODE_API_KEY');
    expect(missing.detail).toContain('PAID per token');

    const cfg = cfgOf({ OPENCODE_API_KEY: 'oc-live-key-123456' });
    expect(await provider.check(cfg, { model: ref })).toEqual({
      state: 'ok',
      detail: `pi-ai / ${ref} is configured (PAID per token).`,
    });
    const client = provider.create(cfg, { model: ref });
    expect(client.billing).toBe('per-token');
    expect(provider.billingFor!(ref)).toBe('per-token');
    await client.complete({ prompt: 'p' });
    expect(calls[0]!.options.apiKey).toBe('oc-live-key-123456');
    expect(calls[0]!.model.provider).toBe('opencode');
  });

  it('declares each upstream key once, OpenCode\'s two plans sharing one', () => {
    const keys = createPiAiProvider().configKeys.map((k) => k.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(expect.arrayContaining(['OPENCODE_API_KEY', 'GEMINI_API_KEY', 'GROQ_API_KEY', 'HF_TOKEN']));
    const opencode = createPiAiProvider().configKeys.find((k) => k.key === 'OPENCODE_API_KEY')!;
    expect(opencode.description).toContain('OpenCode Zen / OpenCode Go');
  });

  it('scrubs the literal key a call sent from its failure, whatever its format', async () => {
    const { provider } = fakeRuntime(() => reply('', { stopReason: 'error', errorMessage: 'bad key oc-live-key-123456 rejected' }));
    const failure = provider
      .create(cfgOf({ OPENCODE_API_KEY: 'oc-live-key-123456' }), { model: 'opencode/claude-fable-5' })
      .complete({ prompt: 'p' });
    await expect(failure).rejects.toThrow(/bad key \[redacted\] rejected/);
  });

  it('reads the REAL installed catalog locally - every upstream loads and lists, with no network at all', async () => {
    const realFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      throw new Error('the catalog browse must never reach the network');
    }) as typeof fetch;
    try {
      const provider = createPiAiProvider();
      for (const source of provider.modelCatalog!.sources) {
        const models = await provider.modelCatalog!.listModels(source.id);
        if (source.freeform) continue;
        expect(models.length, `${source.id} lists no models`).toBeGreaterThan(0);
        for (const m of models) {
          expect(m.id.startsWith(`${source.id}/`)).toBe(true);
          expect(m.contextWindow).toBeGreaterThan(0);
          expect(m.price).toBeDefined();
        }
      }
      // The big gateways are the reason the picker is searchable.
      expect((await provider.modelCatalog!.listModels('openrouter')).length).toBeGreaterThan(100);
      expect((await provider.modelCatalog!.listModels('opencode')).length).toBeGreaterThan(20);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(requests).toBe(0);
  });
});

describe('outputCeiling (security review 2, #19)', () => {
  it('adds the thinking allowance for the effort in force, bounded by the model maximum', () => {
    expect(outputCeiling({ maxTokens: 128_000 }, 8_192, 'off')).toBe(8_192);
    expect(outputCeiling({ maxTokens: 128_000 }, 32_768, 'high')).toBe(32_768 + REASONING_ALLOWANCE.high);
    expect(outputCeiling({ maxTokens: 20_000 }, 32_768, 'high')).toBe(20_000);
  });

  it('leaves the call uncapped only when no budget was given at all', () => {
    expect(outputCeiling({ maxTokens: 128_000 }, undefined, 'off')).toBeUndefined();
    expect(outputCeiling({ maxTokens: 128_000 }, 0, 'off')).toBeUndefined();
  });

  it('keeps every level well under the 128k maximum that made #19 costly', () => {
    for (const allowance of Object.values(REASONING_ALLOWANCE)) {
      expect(allowance).toBeLessThanOrEqual(65_536);
    }
  });
});
