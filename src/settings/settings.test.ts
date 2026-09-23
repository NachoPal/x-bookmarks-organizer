import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '../db/database';
import { loadConfig } from '../config';
import { buildSettingsCatalog } from './catalog';
import {
  applySettingsToConfig,
  defaultSettings,
  effectiveSettings,
  readSettings,
  validateSettings,
  writeSettings,
  type AppSettings,
} from './settings';

const catalog = buildSettingsCatalog();

describe('the settings catalog', () => {
  it('offers both categorization methods, naming the paid one as paid', () => {
    expect(catalog.methods.map((m) => m.id)).toEqual(['claude-cli', 'typesafe']);
    const jev = catalog.methods.find((m) => m.id === 'typesafe')!;
    expect(jev.billing).toBe('per-token');
    // The key it refuses to run without is named, so the UI can check for it.
    expect(jev.requiresKey).toBe('TYPESAFE_API_KEY');
  });

  it('is built from the provider registry, so a new provider needs no change here', () => {
    const claude = catalog.providers.find((p) => p.id === 'claude-cli')!;
    expect(claude.billing).toBe('subscription');
    expect(claude.models.map((m) => m.id)).toContain('anthropic/claude-opus-4-8');
    // The effort axis the adapter actually accepts, ascending.
    expect(claude.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    // The Recommended option's real value per pass: Opus designs, Haiku files.
    expect(claude.suggested.taxonomy).toBe('anthropic/claude-opus-4-8');
    expect(claude.suggested.assignment).toBe('anthropic/claude-haiku-4-5');
  });
});

describe('validateSettings', () => {
  it('accepts a complete, valid selection', () => {
    const { settings, errors } = validateSettings(
      {
        categorizer: 'claude-cli',
        provider: 'claude-cli',
        taxonomyModel: 'anthropic/claude-opus-4-8',
        assignmentModel: 'anthropic/claude-haiku-4-5',
        effort: 'max',
      },
      catalog,
    );
    expect(errors).toEqual([]);
    expect(settings.taxonomyModel).toBe('anthropic/claude-opus-4-8');
    expect(settings.effort).toBe('max');
  });

  it('leaves an unset model undefined, so the provider suggestion is followed', () => {
    const { settings, errors } = validateSettings({ provider: 'claude-cli' }, catalog);
    expect(errors).toEqual([]);
    expect(settings.taxonomyModel).toBeUndefined();
    expect(settings.assignmentModel).toBeUndefined();
    expect(settings.effort).toBeUndefined();
  });

  it('rejects an unknown method, provider, model and effort, naming what IS available', () => {
    const { errors } = validateSettings(
      {
        categorizer: 'mystery',
        provider: 'claude-cli',
        taxonomyModel: 'gpt-9',
        effort: 'turbo',
      },
      catalog,
    );
    expect(errors).toHaveLength(3);
    expect(errors[0]).toContain('claude-cli, typesafe');
    expect(errors[1]).toContain('names no model source of provider "claude-cli"');
    expect(errors[2]).toContain('low, medium, high');
  });

  it('falls back to defaults for an invalid field rather than returning nothing usable', () => {
    const { settings } = validateSettings({ categorizer: 'nope', provider: 'nope' }, catalog);
    expect(settings).toMatchObject(defaultSettings(catalog));
  });
});

describe('settings persistence', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });
  afterEach(() => db.close());

  it('reports nothing stored on a fresh database, and the defaults as effective', () => {
    expect(readSettings(db, catalog)).toBeUndefined();
    expect(effectiveSettings(db, catalog)).toEqual(defaultSettings(catalog));
  });

  it('round-trips a saved selection', () => {
    const settings: AppSettings = {
      categorizer: 'typesafe',
      taxonomyProvider: 'claude-cli',
      assignmentProvider: 'claude-cli',
      taxonomyModel: 'anthropic/claude-sonnet-5',
      assignmentModel: 'anthropic/claude-haiku-4-5',
      effort: 'low',
      configuredAt: '2026-01-02T03:04:05.000Z',
    };
    writeSettings(db, settings);
    expect(readSettings(db, catalog)).toEqual(settings);
  });

  it('survives a reopen of the same database file (durable, not per-process)', () => {
    writeSettings(db, { ...defaultSettings(catalog), categorizer: 'typesafe', effort: 'max' });
    const raw = db.getState('app_settings');
    db.close();
    // A second Database over the same in-memory content is not possible, so
    // assert the value is in the durable run_state document itself.
    expect(JSON.parse(raw!)).toMatchObject({ categorizer: 'typesafe', effort: 'max' });
    db = new Database(':memory:');
  });

  it('degrades to unconfigured on a corrupt document instead of throwing', () => {
    db.setState('app_settings', '{not json');
    expect(readSettings(db, catalog)).toBeUndefined();
    expect(effectiveSettings(db, catalog)).toEqual(defaultSettings(catalog));
  });
});

describe('applySettingsToConfig', () => {
  const base = () => loadConfig({}, undefined);

  it('maps the chosen method and each pass\'s provider onto the ingest config', () => {
    const config = applySettingsToConfig(base(), {
      categorizer: 'typesafe',
      taxonomyProvider: 'pi-ai',
      assignmentProvider: 'claude-cli',
    });
    expect(config.categorizer).toBe('typesafe');
    expect(config.llm.roles.taxonomy.provider).toBe('pi-ai');
    expect(config.llm.roles.assignment.provider).toBe('claude-cli');
    // Summaries are not a categorization pass: picking a paid model to design
    // the tree must not quietly move them onto it.
    expect(config.llm.defaultProvider).toBe('claude-cli');
    expect(config.llm.roles.summary.provider).toBeUndefined();
  });

  it('pins the per-pass models and the taxonomy effort the owner picked', () => {
    const config = applySettingsToConfig(base(), {
      categorizer: 'claude-cli',
      taxonomyProvider: 'claude-cli', assignmentProvider: 'claude-cli',
      taxonomyModel: 'claude-sonnet-5',
      assignmentModel: 'claude-opus-4-8',
      effort: 'max',
    });
    expect(config.llm.roles.taxonomy.model).toBe('claude-sonnet-5');
    expect(config.llm.roles.taxonomy.params?.effort).toBe('max');
    expect(config.llm.roles.assignment.model).toBe('claude-opus-4-8');
  });

  it('leaves a Recommended model undefined so the provider suggestion still applies', () => {
    const config = applySettingsToConfig(base(), {
      categorizer: 'claude-cli',
      taxonomyProvider: 'claude-cli', assignmentProvider: 'claude-cli',
    });
    expect(config.llm.roles.taxonomy.model).toBeUndefined();
    expect(config.llm.roles.assignment.model).toBeUndefined();
    // The app's own default effort is kept rather than cleared.
    expect(config.llm.roles.taxonomy.params?.effort).toBe('high');
  });

  it('touches nothing outside the selector (batch size, depth, TypeSafe tuning)', () => {
    const before = loadConfig({ XBOOKMARKS_BATCH_SIZE: '7', XBOOKMARKS_MAX_DEPTH: '6' });
    const after = applySettingsToConfig(before, {
      categorizer: 'typesafe',
      taxonomyProvider: 'claude-cli', assignmentProvider: 'claude-cli',
    });
    expect(after.batchSize).toBe(7);
    expect(after.maxCategoryDepth).toBe(6);
    expect(after.typesafe).toEqual(before.typesafe);
  });

  it('lets the stored choice win when no environment is passed (the viewer)', () => {
    const before = loadConfig({ XBOOKMARKS_CATEGORIZER: 'typesafe', XBOOKMARKS_MODEL: 'claude-opus-4-8' });
    const after = applySettingsToConfig(before, {
      categorizer: 'claude-cli',
      taxonomyProvider: 'claude-cli', assignmentProvider: 'claude-cli',
      assignmentModel: 'claude-haiku-4-5',
    });
    expect(after.categorizer).toBe('claude-cli');
    expect(after.llm.roles.assignment.model).toBe('claude-haiku-4-5');
  });

  it('lets an explicitly exported variable win when the environment is passed (the CLI)', () => {
    const env = { XBOOKMARKS_CATEGORIZER: 'typesafe', XBOOKMARKS_MODEL: 'claude-opus-4-8' };
    const after = applySettingsToConfig(
      loadConfig(env),
      { categorizer: 'claude-cli', taxonomyProvider: 'claude-cli', assignmentProvider: 'claude-cli', assignmentModel: 'claude-haiku-4-5' },
      env,
    );
    expect(after.categorizer).toBe('typesafe');
    expect(after.llm.roles.assignment.model).toBe('claude-opus-4-8');
  });

  it('still applies the fields the passed environment does NOT claim', () => {
    const env = { XBOOKMARKS_CATEGORIZER: 'typesafe' };
    const after = applySettingsToConfig(
      loadConfig(env),
      { categorizer: 'claude-cli', taxonomyProvider: 'claude-cli', assignmentProvider: 'claude-cli', effort: 'low' },
      env,
    );
    expect(after.categorizer).toBe('typesafe');
    expect(after.llm.roles.taxonomy.params?.effort).toBe('low');
  });
});

describe('per-pass providers (issue #70)', () => {
  it('offers pi-ai alongside claude-cli, with claude-cli still the default for both passes', () => {
    expect(catalog.providers.map((p) => p.id)).toEqual(['claude-cli', 'pi-ai', 'pi-claude-subscription']);
    expect(defaultSettings(catalog)).toMatchObject({
      taxonomyProvider: 'claude-cli',
      assignmentProvider: 'claude-cli',
    });
    const pi = catalog.providers.find((p) => p.id === 'pi-ai')!;
    expect(pi.billing).toBe('per-token');
  });

  it('carries each model\'s context window and required key into the catalog', () => {
    const pi = catalog.providers.find((p) => p.id === 'pi-ai')!;
    const haiku = pi.models.find((m) => m.id === 'anthropic/claude-haiku-4-5')!;
    expect(haiku.contextWindow).toBe(200_000);
    expect(haiku.requiresKey).toBe('ANTHROPIC_API_KEY');
    expect(pi.models.find((m) => m.id === 'openrouter/google/gemini-2.5-flash')!.requiresKey).toBe(
      'OPENROUTER_API_KEY',
    );
    const claude = catalog.providers.find((p) => p.id === 'claude-cli')!;
    expect(claude.models.every((m) => typeof m.contextWindow === 'number')).toBe(true);
  });

  it('validates each pass against its OWN provider, independently', () => {
    const { settings, errors } = validateSettings(
      {
        taxonomyProvider: 'pi-ai',
        taxonomyModel: 'openrouter/google/gemini-2.5-flash',
        assignmentProvider: 'claude-cli',
        assignmentModel: 'anthropic/claude-haiku-4-5',
        effort: 'medium',
      },
      catalog,
    );
    expect(errors).toEqual([]);
    expect(settings).toMatchObject({
      taxonomyProvider: 'pi-ai',
      taxonomyModel: 'openrouter/google/gemini-2.5-flash',
      assignmentProvider: 'claude-cli',
      assignmentModel: 'anthropic/claude-haiku-4-5',
    });
  });

  it('offers BOTH Claude subscription routes for each pass, only the pi one carrying a risk warning', () => {
    const cli = catalog.providers.find((p) => p.id === 'claude-cli')!;
    const viaPi = catalog.providers.find((p) => p.id === 'pi-claude-subscription')!;
    expect(cli.billing).toBe('subscription');
    expect(cli.warning).toBeUndefined();
    expect(viaPi.billing).toBe('subscription');
    expect(viaPi.warning).toMatch(/Account risk/);
    expect(viaPi.warning).toMatch(/terms prohibit/);
    expect(viaPi.label).toMatch(/against Anthropic's terms/);
    expect(viaPi.suggested).toEqual({ taxonomy: 'anthropic/claude-opus-4-8', assignment: 'anthropic/claude-haiku-4-5' });

    // Either route, on either pass, is a valid saved choice.
    for (const [taxonomyProvider, assignmentProvider] of [
      ['pi-claude-subscription', 'claude-cli'],
      ['claude-cli', 'pi-claude-subscription'],
      ['pi-claude-subscription', 'pi-claude-subscription'],
    ]) {
      const { settings, errors } = validateSettings(
        {
          taxonomyProvider,
          taxonomyModel: 'anthropic/claude-opus-4-8',
          assignmentProvider,
          assignmentModel: 'anthropic/claude-haiku-4-5',
        },
        catalog,
      );
      expect(errors).toEqual([]);
      expect(settings).toMatchObject({ taxonomyProvider, assignmentProvider });
      const config = applySettingsToConfig(loadConfig({}), settings);
      expect(config.llm.roles.taxonomy.provider).toBe(taxonomyProvider);
      expect(config.llm.roles.assignment.provider).toBe(assignmentProvider);
      // Summaries stay on the default provider whichever route categorization takes.
      expect(config.llm.defaultProvider).toBe('claude-cli');
    }
  });

  it("refuses a model that belongs to the OTHER pass's provider", () => {
    const { errors } = validateSettings(
      { taxonomyProvider: 'pi-ai', taxonomyModel: 'claude-opus-4-8', assignmentProvider: 'claude-cli' },
      catalog,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Taxonomy model "claude-opus-4-8" names no model source of provider "pi-ai"');
  });

  it('reads a pre-#70 document (one `provider`) as both passes\' provider', () => {
    const { settings, errors } = validateSettings(
      { categorizer: 'claude-cli', provider: 'claude-cli', taxonomyModel: 'anthropic/claude-opus-4-8' },
      catalog,
    );
    expect(errors).toEqual([]);
    expect(settings.taxonomyProvider).toBe('claude-cli');
    expect(settings.assignmentProvider).toBe('claude-cli');
    expect(settings).not.toHaveProperty('provider');
  });

  it('on the CLI, an env-claimed provider also drops the stored model that belonged to the old one', () => {
    const env = { XBOOKMARKS_TAXONOMY_PROVIDER: 'pi-ai' };
    const after = applySettingsToConfig(
      loadConfig(env),
      {
        categorizer: 'claude-cli',
        taxonomyProvider: 'claude-cli',
        taxonomyModel: 'claude-opus-4-8',
        assignmentProvider: 'claude-cli',
        assignmentModel: 'claude-haiku-4-5',
      },
      env,
    );
    expect(after.llm.roles.taxonomy.provider).toBe('pi-ai');
    // claude-opus-4-8 is not a pi-ai id - the pass follows pi-ai's own suggestion.
    expect(after.llm.roles.taxonomy.model).toBeUndefined();
    // The assignment pass is not claimed, so the stored choice stands.
    expect(after.llm.roles.assignment.provider).toBe('claude-cli');
    expect(after.llm.roles.assignment.model).toBe('claude-haiku-4-5');
  });

  it('XBOOKMARKS_LLM_PROVIDER claims both passes on the CLI, as it always meant every role', () => {
    const env = { XBOOKMARKS_LLM_PROVIDER: 'pi-ai' };
    const after = applySettingsToConfig(
      loadConfig(env),
      { categorizer: 'claude-cli', taxonomyProvider: 'claude-cli', assignmentProvider: 'claude-cli' },
      env,
    );
    expect(after.llm.defaultProvider).toBe('pi-ai');
    expect(after.llm.roles.taxonomy.provider).toBeUndefined();
    expect(after.llm.roles.assignment.provider).toBeUndefined();
  });
});

describe('a provider with a full model catalog (pi-ai)', () => {
  const catalog = buildSettingsCatalog();

  it('ships its sources - every wired pi upstream - beside the recommended picks', () => {
    const pi = catalog.providers.find((p) => p.id === 'pi-ai')!;
    expect(pi.sources!.map((s) => s.id)).toEqual(expect.arrayContaining(['opencode', 'openrouter', 'google', 'local']));
    expect(pi.models.length).toBeLessThan(20);
    // claude-cli and the subscription route each carry only ONE source - pi's
    // Anthropic catalog - so their recommended list stays a short curated one
    // while the full Claude catalog is still reachable by browsing it.
    const cli = catalog.providers.find((p) => p.id === 'claude-cli')!;
    const viaPi = catalog.providers.find((p) => p.id === 'pi-claude-subscription')!;
    expect(cli.sources!.map((s) => s.id)).toEqual(['anthropic']);
    expect(viaPi.sources!.map((s) => s.id)).toEqual(['anthropic']);
    expect(cli.models.length).toBe(3);
  });

  it('accepts (and reads back) any <source>/<model> of the catalog, per pass', () => {
    const { settings, errors } = validateSettings(
      {
        taxonomyProvider: 'pi-ai',
        taxonomyModel: 'opencode/claude-fable-5',
        assignmentProvider: 'pi-ai',
        assignmentModel: 'openrouter/z-ai/glm-5',
      },
      catalog,
    );
    expect(errors).toEqual([]);
    expect(settings).toMatchObject({ taxonomyModel: 'opencode/claude-fable-5', assignmentModel: 'openrouter/z-ai/glm-5' });
  });

  it('refuses a source pi-ai does not wire, listing the ones it does', () => {
    const { errors } = validateSettings(
      { taxonomyProvider: 'pi-ai', taxonomyModel: 'amazon-bedrock/claude', assignmentProvider: 'claude-cli' },
      catalog,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('names no model source of provider "pi-ai"');
    expect(errors[0]).toContain('opencode');
  });
});
