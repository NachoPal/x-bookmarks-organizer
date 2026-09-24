import { describe, it, expect, beforeAll } from 'vitest';
import { loadConfig } from '../config';
import { createLlmFactory } from './factory';
import {
  CHAT_OUTPUT_TOKENS,
  SUMMARY_OUTPUT_TOKENS,
  TAXONOMY_OUTPUT_TOKENS,
  outputBudgetFor,
} from './output-budget';
import { registerProvider } from './registry';
import type { LlmRole, ProviderDefinition, ProviderParams } from './types';

/** What `create()` was asked for, so model/param resolution is observable offline. */
interface Recorded {
  model: string;
  params?: ProviderParams;
}

const recorded: Recorded[] = [];

/** A provider that records its resolution inputs and never spawns or calls anything. */
const recorder: ProviderDefinition = {
  id: 'recorder',
  label: 'Recorder',
  billing: 'local',
  configKeys: [],
  models: [
    { id: 'big-model', label: 'Big', suggestedFor: ['taxonomy'] },
    { id: 'small-model', label: 'Small', suggestedFor: ['assignment', 'summary', 'chat'] },
  ],
  capabilities: { jsonMode: false, effort: true, temperature: false, streaming: false },
  async check() {
    return { state: 'ok', detail: 'recorder is always fine' };
  },
  create(_cfg, opts) {
    recorded.push({ model: opts.model, params: opts.params });
    return {
      providerId: 'recorder',
      model: opts.model,
      billing: 'local',
      async complete(req) {
        return { text: `ok:${req.prompt}`, model: opts.model, providerId: 'recorder' };
      },
    };
  },
};

/** A provider with no effort support, to prove unsupported params are dropped, not rejected. */
const plain: ProviderDefinition = {
  ...recorder,
  id: 'plain',
  capabilities: { jsonMode: false, effort: false, temperature: false, streaming: false },
};

function factoryFor(env: NodeJS.ProcessEnv) {
  return createLlmFactory(loadConfig(env), env);
}

function resolutionOf(env: NodeJS.ProcessEnv, role: LlmRole): Recorded {
  recorded.length = 0;
  factoryFor(env).forRole(role);
  const first = recorded[0];
  if (!first) throw new Error('provider.create was never called');
  return first;
}

beforeAll(() => {
  registerProvider(recorder);
  registerProvider(plain);
});

describe('createLlmFactory - role resolution', () => {
  it('defaults to the claude-cli provider when nothing is configured', () => {
    const { providerId, model, billing } = factoryFor({}).describe('assignment');
    expect(providerId).toBe('claude-cli');
    expect(model).toBe('anthropic/claude-haiku-4-5');
    expect(billing).toBe('subscription');
  });

  it('keeps the historical Opus-pass-1 / Haiku-pass-2 defaults, with summary on Sonnet 5', () => {
    const llm = factoryFor({});
    expect(llm.describe('taxonomy').model).toBe('anthropic/claude-opus-4-8');
    expect(llm.describe('assignment').model).toBe('anthropic/claude-haiku-4-5');
    expect(llm.describe('summary').model).toBe('anthropic/claude-sonnet-5');
  });

  it('honors XBOOKMARKS_SUMMARY_MODEL as a summary-role override', () => {
    const llm = factoryFor({ XBOOKMARKS_SUMMARY_MODEL: 'claude-opus-4-8' });
    expect(llm.describe('summary').model).toBe('claude-opus-4-8');
  });

  it("uses the provider's suggestion for a role when no model is configured", () => {
    const env = { XBOOKMARKS_LLM_PROVIDER: 'recorder' };
    expect(resolutionOf(env, 'taxonomy').model).toBe('big-model');
    expect(resolutionOf(env, 'assignment').model).toBe('small-model');
    expect(resolutionOf(env, 'summary').model).toBe('small-model');
  });

  it('passes the taxonomy effort through, defaulting to high', () => {
    const env = { XBOOKMARKS_LLM_PROVIDER: 'recorder' };
    expect(resolutionOf(env, 'taxonomy').params?.effort).toBe('high');
    expect(
      resolutionOf({ ...env, XBOOKMARKS_TAXONOMY_EFFORT: 'max' }, 'taxonomy').params?.effort,
    ).toBe('max');
    // The assignment pass has never sent an effort level.
    expect(resolutionOf(env, 'assignment').params?.effort).toBeUndefined();
  });

  it('gives every role an explicit output cap, never the model maximum (security review 2, #19)', () => {
    const env = { XBOOKMARKS_LLM_PROVIDER: 'recorder' };
    expect(resolutionOf(env, 'summary').params?.maxOutputTokens).toBe(SUMMARY_OUTPUT_TOKENS);
    expect(resolutionOf(env, 'chat').params?.maxOutputTokens).toBe(CHAT_OUTPUT_TOKENS);
    expect(resolutionOf(env, 'taxonomy').params?.maxOutputTokens).toBe(TAXONOMY_OUTPUT_TOKENS);
    // The assignment budget follows the batch it has to answer for.
    expect(resolutionOf(env, 'assignment').params?.maxOutputTokens).toBe(
      outputBudgetFor('assignment', { batchSize: 15 }),
    );
    expect(
      resolutionOf({ ...env, XBOOKMARKS_BATCH_SIZE: '40' }, 'assignment').params?.maxOutputTokens,
    ).toBe(outputBudgetFor('assignment', { batchSize: 40 }));
  });

  it('drops params a provider does not support instead of failing', () => {
    const resolved = resolutionOf(
      { XBOOKMARKS_LLM_PROVIDER: 'plain', XBOOKMARKS_TAXONOMY_EFFORT: 'max' },
      'taxonomy',
    );
    expect(resolved.params?.effort).toBeUndefined();
  });

  it('honors per-role, then global, model overrides', () => {
    const env = { XBOOKMARKS_LLM_PROVIDER: 'recorder', XBOOKMARKS_LLM_MODEL: 'global-model' };
    expect(resolutionOf(env, 'taxonomy').model).toBe('global-model');
    expect(
      resolutionOf({ ...env, XBOOKMARKS_TAXONOMY_MODEL: 'role-model' }, 'taxonomy').model,
    ).toBe('role-model');
  });

  it('keeps XBOOKMARKS_MODEL meaning the assignment *and* summary model', () => {
    const env = { XBOOKMARKS_LLM_PROVIDER: 'recorder', XBOOKMARKS_MODEL: 'chosen' };
    expect(resolutionOf(env, 'assignment').model).toBe('chosen');
    expect(resolutionOf(env, 'summary').model).toBe('chosen');
    // ...unless the summary role overrides it on its own.
    expect(resolutionOf({ ...env, XBOOKMARKS_SUMMARY_MODEL: 'other' }, 'summary').model).toBe(
      'other',
    );
  });

  it('caches one client per role', () => {
    const llm = factoryFor({ XBOOKMARKS_LLM_PROVIDER: 'recorder' });
    expect(llm.forRole('summary')).toBe(llm.forRole('summary'));
  });

  it('resolves a per-role provider override', () => {
    const llm = factoryFor({ XBOOKMARKS_TAXONOMY_PROVIDER: 'recorder' });
    expect(llm.describe('taxonomy').providerId).toBe('recorder');
    expect(llm.describe('assignment').providerId).toBe('claude-cli');
  });
});

describe('createLlmFactory - unknown provider', () => {
  const env = { XBOOKMARKS_LLM_PROVIDER: 'gpt-fantasy' };

  it('fails clearly, naming the id and the ones that exist', async () => {
    const health = await factoryFor(env).check('assignment');
    expect(health.state).toBe('unconfigured');
    expect(health.detail).toContain('gpt-fantasy');
    expect(health.detail).toContain('claude-cli');
    expect(health.detail).toContain('XBOOKMARKS_LLM_PROVIDER');
  });

  it('throws with the same message when a client is actually requested', () => {
    expect(() => factoryFor(env).forRole('assignment')).toThrow(/gpt-fantasy/);
  });

  it('does not throw at construction time, so the viewer can still start', () => {
    expect(() => factoryFor(env)).not.toThrow();
  });
});
