import { describe, it, expect } from 'vitest';
import { loadConfig } from '../config';
import { applySettingsToConfig, defaultSettings, type AppSettings } from '../settings/settings';
import { buildSettingsCatalog } from '../settings/catalog';
import { createCredentialStore } from '../creds/resolve';
import { createLlmFactory } from '../llm/factory';
import { Database } from '../db/database';
import { buildCategorizers, taxonomyContextWindow } from './build';
import { DEFAULT_TAXONOMY_CONTEXT_WINDOW, effectiveContextWindow } from './taxonomy-budget';
import { Categorizer } from './llm';
import { TypeSafeCategorizer } from './typesafe/categorizer';

/**
 * Regression coverage for the phase-2 provider-wiring bug: choosing an LLM
 * provider (e.g. OpenAI via pi-ai) for the assignment pass silently ran Jev
 * instead. `buildCategorizers` decides the method FIRST
 * (`config.categorizer === 'typesafe'`) and, when it is, ignores the
 * assignment provider/model entirely - so these pin that a settings document
 * naming an LLM provider for phase 2 actually builds the LLM `Categorizer` on
 * that provider, never `TypeSafeCategorizer`, and that Jev is reached ONLY
 * when the owner explicitly chose it as the method.
 *
 * Entirely offline: `pi-ai`/`claude-cli` client construction is lazy (no
 * network, no spawn) until a call is made, and this suite never calls one.
 */
const catalog = buildSettingsCatalog();

function buildWith(settings: AppSettings, env: NodeJS.ProcessEnv = {}) {
  const config = applySettingsToConfig(loadConfig(env), settings);
  const store = createCredentialStore({ env });
  const llm = createLlmFactory(config, env, store);
  const db = new Database(':memory:');
  try {
    return { built: buildCategorizers(config, llm, db, store), config, llm };
  } finally {
    db.close();
  }
}

describe('buildCategorizers: phase-2 filing method vs. assignment provider', () => {
  it('an LLM provider chosen for phase 2 (pi-ai/openai) builds the LLM Categorizer on it - never TypeSafe', () => {
    const settings: AppSettings = {
      ...defaultSettings(catalog),
      categorizer: 'claude-cli',
      assignmentProvider: 'pi-ai',
      assignmentModel: 'openai/gpt-4o-mini',
    };
    const { built, llm } = buildWith(settings, { OPENAI_API_KEY: 'sk-test' });
    expect(built.categorizer).toBeInstanceOf(Categorizer);
    expect(built.categorizer).not.toBeInstanceOf(TypeSafeCategorizer);
    expect(llm.forRole('assignment').providerId).toBe('pi-ai');
    expect(llm.describe('assignment').model).toBe('openai/gpt-4o-mini');
  });

  it('Jev explicitly chosen as the method builds TypeSafeCategorizer, regardless of the LLM provider set', () => {
    const settings: AppSettings = {
      ...defaultSettings(catalog),
      categorizer: 'typesafe',
      // Left over from a prior LLM choice - Jev's `extend` fallback provider,
      // but it must not make the filing pass run on the LLM instead.
      assignmentProvider: 'pi-ai',
      assignmentModel: 'openai/gpt-4o-mini',
    };
    const { built } = buildWith(settings, { OPENAI_API_KEY: 'sk-test', TYPESAFE_API_KEY: 'ts-test' });
    expect(built.categorizer).toBeInstanceOf(TypeSafeCategorizer);
    expect(built.categorizer).not.toBeInstanceOf(Categorizer);
  });

  it('the default claude-cli provider for phase 2 also builds the LLM Categorizer, not TypeSafe', () => {
    const { built } = buildWith(defaultSettings(catalog));
    expect(built.categorizer).toBeInstanceOf(Categorizer);
    expect(built.categorizer).not.toBeInstanceOf(TypeSafeCategorizer);
  });
});

describe('taxonomyContextWindow: the pass-1 window comes from the provider catalog (issue #109)', () => {
  const windowFor = async (env: NodeJS.ProcessEnv) => {
    const llm = createLlmFactory(loadConfig(env), env, createCredentialStore({ env }));
    return { window: await taxonomyContextWindow(llm)(), described: llm.describe('taxonomy').contextWindow };
  };

  it("reads a recommended model's window from its static catalog entry", async () => {
    const { window, described } = await windowFor({});
    expect(described).toBeGreaterThan(0);
    expect(window).toBe(described);
  });

  it('asks the client for a model picked from the full catalog, which has no static entry', async () => {
    // Not one of the recommended picks, so `describe` cannot say; pi's local
    // Anthropic catalog (no request, no spend) can.
    const { window, described } = await windowFor({ XBOOKMARKS_TAXONOMY_MODEL: 'anthropic/claude-opus-4-5' });
    expect(described).toBeUndefined();
    expect(window).toBe(200_000);
  });

  it('answers undefined for a model no catalog knows, so the designer applies its safe default', async () => {
    const { window } = await windowFor({ XBOOKMARKS_TAXONOMY_MODEL: 'opus' });
    expect(window).toBeUndefined();
    expect(effectiveContextWindow(window)).toBe(DEFAULT_TAXONOMY_CONTEXT_WINDOW);
  });
});
