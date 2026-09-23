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
import { CLAUDE_CLI_PROVIDER_ID } from './claude-cli';
import { PI_AI_PROVIDER_ID, loadPiRuntime, type PiRuntime } from './pi-ai';
import {
  PI_CLAUDE_SUBSCRIPTION_PROVIDER_ID,
  PI_CLAUDE_SUBSCRIPTION_WARNING,
  createPiClaudeSubscriptionProvider,
  piClaudeSubscriptionProvider,
} from './pi-claude-subscription';

/**
 * Every test here is offline. The provider is driven through a FAKE pi
 * runtime, except one round trip that runs the REAL pi SDK against a local
 * `http` server standing in for api.anthropic.com. No test touches a real
 * subscription or a paid API, and every token below is a made-up string.
 */

const OAUTH_TOKEN = 'sk-ant-oat01-fake-subscription-token-0123456789';
const API_KEY = 'sk-ant-api03-fake-paid-key-0123456789abcdef';

function cfgOf(values: Record<string, string>): ResolvedProviderConfig {
  return { get: (key) => values[key] };
}

interface Call {
  upstream: string;
  model: Model<Api>;
  context: Context;
  options: Parameters<PiRuntime['complete']>[2];
}

function fakeModel(id: string): Model<Api> {
  return {
    id,
    name: id,
    api: 'anthropic-messages',
    provider: 'anthropic',
    baseUrl: 'https://example.invalid',
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 4_096,
  };
}

function reply(text: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'x',
    usage: {
      input: 5,
      output: 3,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 8,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: 0,
  } as AssistantMessage;
}

function fakeRuntime() {
  const calls: Call[] = [];
  const lookups: string[] = [];
  const known = new Set(['claude-opus-4-8', 'claude-haiku-4-5', 'claude-sonnet-5']);
  const runtime: PiRuntime = {
    findModel: (upstream, id) => {
      lookups.push(`${upstream}/${id}`);
      return known.has(id) ? fakeModel(id) : undefined;
    },
    localModel: () => {
      throw new Error('never a local model');
    },
    clampEffort: (_model, level) => level,
    async complete(model, context, options) {
      calls.push({ upstream: model.provider, model, context, options });
      return reply('{"ok":true}');
    },
  };
  return { calls, lookups, provider: createPiClaudeSubscriptionProvider(async () => runtime) };
}

describe('the pi-claude-subscription provider (opt-in, fake runtime)', () => {
  it("passes the resolved CLAUDE_CODE_OAUTH_TOKEN to pi's Anthropic model - never ANTHROPIC_API_KEY", async () => {
    const { provider, calls, lookups } = fakeRuntime();
    // A paid key sitting beside the token must never be the one used.
    const cfg = cfgOf({ CLAUDE_CODE_OAUTH_TOKEN: OAUTH_TOKEN, ANTHROPIC_API_KEY: API_KEY });
    const client = provider.create(cfg, { model: 'claude-haiku-4-5', params: { effort: 'low' } });
    expect(client.providerId).toBe(PI_CLAUDE_SUBSCRIPTION_PROVIDER_ID);
    expect(client.billing).toBe('subscription');

    const result = await client.complete({ prompt: 'file these', system: 'be terse' });
    expect(result).toEqual({
      text: '{"ok":true}',
      model: 'claude-haiku-4-5',
      providerId: PI_CLAUDE_SUBSCRIPTION_PROVIDER_ID,
      usage: { inputTokens: 5, outputTokens: 3 },
    });
    expect(lookups).toContain('anthropic/claude-haiku-4-5');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.upstream).toBe('anthropic');
    expect(calls[0]!.options.apiKey).toBe(OAUTH_TOKEN);
    expect(calls[0]!.options.reasoning).toBe('low');
    expect(calls[0]!.context.systemPrompt).toBe('be terse');
  });

  it('resolves the token through the layered credential chain, not just the environment', async () => {
    const { provider, calls } = fakeRuntime();
    const store = createCredentialStore({
      env: {},
      projectRoot: '/nonexistent-project',
      configDir: '/nonexistent-config',
      platform: 'darwin',
      exec: (_cmd, args) => {
        if (args.includes('CLAUDE_CODE_OAUTH_TOKEN')) return `${OAUTH_TOKEN}\n`;
        throw new Error('not found');
      },
    });
    const cfg: ResolvedProviderConfig = { get: (key) => store.get(key).value };
    await provider.create(cfg, { model: 'claude-opus-4-8' }).complete({ prompt: 'p' });
    expect(calls[0]!.options.apiKey).toBe(OAUTH_TOKEN);
  });

  it('is not ready without the token, names it, and makes no call', async () => {
    const { provider, calls } = fakeRuntime();
    // An API key alone is NOT a way into this route.
    const cfg = cfgOf({ ANTHROPIC_API_KEY: API_KEY });
    const health = await provider.check(cfg, { model: 'claude-haiku-4-5' });
    expect(health.state).toBe('unconfigured');
    expect(health.detail).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    await expect(provider.create(cfg, { model: 'claude-haiku-4-5' }).complete({ prompt: 'p' })).rejects.toThrow(
      /CLAUDE_CODE_OAUTH_TOKEN/,
    );
    expect(calls).toHaveLength(0);
  });

  it('refuses a token that is not a subscription token, since pi would bill it per token', async () => {
    const { provider, calls } = fakeRuntime();
    const cfg = cfgOf({ CLAUDE_CODE_OAUTH_TOKEN: API_KEY });
    const health = await provider.check(cfg, { model: 'claude-haiku-4-5' });
    expect(health.state).toBe('unconfigured');
    expect(health.detail).toContain('sk-ant-oat');
    expect(health.detail).not.toContain('fake-paid-key');
    await expect(provider.create(cfg, { model: 'claude-haiku-4-5' }).complete({ prompt: 'p' })).rejects.toThrow(
      /per token/,
    );
    expect(calls).toHaveLength(0);
  });

  it('is ready once the token resolves, and the check itself makes no call', async () => {
    const { provider, calls } = fakeRuntime();
    const cfg = cfgOf({ CLAUDE_CODE_OAUTH_TOKEN: OAUTH_TOKEN });
    expect((await provider.check(cfg, { model: 'claude-opus-4-8' })).state).toBe('ok');
    expect((await provider.check(cfg, { model: 'claude-nope' })).detail).toContain('does not know');
    expect(calls).toHaveLength(0);
  });

  it('never lets the token reach a failure message', async () => {
    const runtime: PiRuntime = {
      findModel: (_u, id) => fakeModel(id),
      localModel: () => fakeModel('x'),
      clampEffort: (_m, l) => l,
      complete: async () => {
        throw new Error(`401 invalid bearer ${OAUTH_TOKEN}`);
      },
    };
    const provider = createPiClaudeSubscriptionProvider(async () => runtime);
    const failure = provider
      .create(cfgOf({ CLAUDE_CODE_OAUTH_TOKEN: OAUTH_TOKEN }), { model: 'claude-haiku-4-5' })
      .complete({ prompt: 'p' });
    await expect(failure).rejects.toThrow(/Claude subscription via pi/);
    await expect(failure).rejects.not.toThrow(/fake-subscription-token/);
  });

  it('declares itself a subscription route that carries the risk warning', () => {
    const p = piClaudeSubscriptionProvider;
    expect(p.billing).toBe('subscription');
    expect(p.warning).toBe(PI_CLAUDE_SUBSCRIPTION_WARNING);
    expect(p.warning).toMatch(/Account risk/);
    expect(p.warning).toMatch(/terms prohibit/);
    expect(p.warning).toContain('claude-cli');
    expect(p.label).toMatch(/against Anthropic's terms/);
    expect(p.models.map((m) => m.id)).toEqual(['claude-opus-4-8', 'claude-haiku-4-5', 'claude-sonnet-5']);
    expect(p.models.every((m) => m.requiresKey === 'CLAUDE_CODE_OAUTH_TOKEN')).toBe(true);
    expect(p.models.every((m) => typeof m.contextWindow === 'number')).toBe(true);
  });
});

describe('opting in is a per-pass choice, and never the default', () => {
  it('leaves claude-cli the default for every role when nothing is selected', () => {
    const env = { CLAUDE_CODE_OAUTH_TOKEN: OAUTH_TOKEN };
    const llm = createLlmFactory(loadConfig(env), env);
    for (const role of ['taxonomy', 'assignment', 'summary', 'chat'] as const) {
      expect(llm.describe(role).providerId).toBe(CLAUDE_CLI_PROVIDER_ID);
      expect(llm.describe(role).warning).toBeUndefined();
    }
  });

  it('runs exactly the pass the owner put on it, with the warning on its billing line', () => {
    const env = {
      CLAUDE_CODE_OAUTH_TOKEN: OAUTH_TOKEN,
      XBOOKMARKS_TAXONOMY_PROVIDER: PI_CLAUDE_SUBSCRIPTION_PROVIDER_ID,
    };
    const config = loadConfig(env);
    const llm = createLlmFactory(config, env);
    expect(llm.describe('taxonomy')).toMatchObject({
      providerId: PI_CLAUDE_SUBSCRIPTION_PROVIDER_ID,
      model: 'claude-opus-4-8',
      billing: 'subscription',
      warning: PI_CLAUDE_SUBSCRIPTION_WARNING,
    });
    expect(llm.describe('assignment').providerId).toBe(CLAUDE_CLI_PROVIDER_ID);
    expect(llm.describe('summary').providerId).toBe(CLAUDE_CLI_PROVIDER_ID);

    const lines: string[] = [];
    reportCategorizerBilling(config, llm, (m) => lines.push(m));
    expect(lines[0]).toBe(
      'Assignment pass: claude-cli / claude-haiku-4-5 - Claude subscription (no per-call charge; consumes your subscription quota).',
    );
    expect(lines[1]).toContain('Taxonomy pass: pi-claude-subscription / claude-opus-4-8 - Claude subscription');
    expect(lines[1]).toContain(PI_CLAUDE_SUBSCRIPTION_WARNING);
  });

  it('builds both categorization passes on it when both are selected', () => {
    const env = {
      CLAUDE_CODE_OAUTH_TOKEN: OAUTH_TOKEN,
      XBOOKMARKS_TAXONOMY_PROVIDER: PI_CLAUDE_SUBSCRIPTION_PROVIDER_ID,
      XBOOKMARKS_ASSIGNMENT_PROVIDER: PI_CLAUDE_SUBSCRIPTION_PROVIDER_ID,
    };
    const config = loadConfig(env);
    const llm = createLlmFactory(config, env);
    const db = new Database(':memory:');
    try {
      buildCategorizers(config, llm, db, createCredentialStore({ env }));
      expect(llm.forRole('taxonomy').providerId).toBe(PI_CLAUDE_SUBSCRIPTION_PROVIDER_ID);
      expect(llm.forRole('assignment').providerId).toBe(PI_CLAUDE_SUBSCRIPTION_PROVIDER_ID);
      expect(llm.describe('assignment').model).toBe('claude-haiku-4-5');
    } finally {
      db.close();
    }
  });

  it("keeps #116's pi-ai guard when NOT opted in: a subscription token is refused, pointing at claude-cli", async () => {
    // The token is present and the subscription route is registered, but the
    // owner picked pi-ai - which must neither read the token nor accept it.
    const tokenOnly = { CLAUDE_CODE_OAUTH_TOKEN: OAUTH_TOKEN, XBOOKMARKS_LLM_PROVIDER: PI_AI_PROVIDER_ID };
    const onPi = createLlmFactory(loadConfig(tokenOnly), tokenOnly);
    expect((await onPi.check('taxonomy')).detail).toContain('ANTHROPIC_API_KEY');

    const inApiKey = { ANTHROPIC_API_KEY: OAUTH_TOKEN, XBOOKMARKS_LLM_PROVIDER: PI_AI_PROVIDER_ID };
    const refused = await createLlmFactory(loadConfig(inApiKey), inApiKey).check('taxonomy');
    expect(refused.state).toBe('unconfigured');
    expect(refused.detail).toContain('claude-cli');
    expect(refused.detail).not.toContain('fake-subscription-token');
  });
});

/**
 * The REAL pi SDK, end to end, against a local stand-in for api.anthropic.com:
 * proves the token takes pi's OAuth (Claude Pro/Max) path - Bearer auth and
 * the Claude Code betas - rather than being sent as an `x-api-key`.
 */
describe("the real pi SDK's Anthropic OAuth path (localhost stub, no network)", () => {
  let server: http.Server;
  let baseUrl = '';
  const seen: { url?: string; headers: http.IncomingHttpHeaders; body: unknown }[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        seen.push({ url: req.url, headers: req.headers, body: JSON.parse(raw || '{}') });
        const events: [string, unknown][] = [
          [
            'message_start',
            {
              type: 'message_start',
              message: {
                id: 'msg_1',
                type: 'message',
                role: 'assistant',
                model: 'claude-haiku-4-5',
                content: [],
                stop_reason: null,
                usage: { input_tokens: 9, output_tokens: 1 },
              },
            },
          ],
          ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
          [
            'content_block_delta',
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '{"categories":[]}' } },
          ],
          ['content_block_stop', { type: 'content_block_stop', index: 0 }],
          [
            'message_delta',
            { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 6 } },
          ],
          ['message_stop', { type: 'message_stop' }],
        ];
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('sends the subscription token as Bearer OAuth with the Claude Code identity', async () => {
    // The real runtime, with only the Anthropic base URL pointed at the stub.
    const provider = createPiClaudeSubscriptionProvider(async () => {
      const real = await loadPiRuntime();
      return {
        ...real,
        findModel: (upstream, id) => {
          const model = real.findModel(upstream, id);
          return model ? { ...model, baseUrl } : undefined;
        },
      };
    });
    const client = provider.create(cfgOf({ CLAUDE_CODE_OAUTH_TOKEN: OAUTH_TOKEN, ANTHROPIC_API_KEY: API_KEY }), {
      model: 'claude-haiku-4-5',
    });
    const result = await client.complete({ prompt: 'file this bookmark', system: 'answer in JSON' });

    expect(result.text).toBe('{"categories":[]}');
    expect(seen).toHaveLength(1);
    const { headers, body } = seen[0]!;
    expect(headers.authorization).toBe(`Bearer ${OAUTH_TOKEN}`);
    expect(headers['x-api-key']).toBeUndefined();
    expect(String(headers['anthropic-beta'])).toContain('oauth-2025-04-20');
    const system = (body as { system: { text: string }[] }).system.map((b) => b.text);
    expect(system[0]).toMatch(/Claude Code/);
    expect(system).toContain('answer in JSON');
  });
});
