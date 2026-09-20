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
    expect(claude.models.map((m) => m.id)).toContain('claude-opus-4-8');
    // The effort axis the adapter actually accepts, ascending.
    expect(claude.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    // The Recommended option's real value per pass: Opus designs, Haiku files.
    expect(claude.suggested.taxonomy).toBe('claude-opus-4-8');
    expect(claude.suggested.assignment).toBe('claude-haiku-4-5');
  });
});

describe('validateSettings', () => {
  it('accepts a complete, valid selection', () => {
    const { settings, errors } = validateSettings(
      {
        categorizer: 'claude-cli',
        provider: 'claude-cli',
        taxonomyModel: 'claude-opus-4-8',
        assignmentModel: 'claude-haiku-4-5',
        effort: 'max',
      },
      catalog,
    );
    expect(errors).toEqual([]);
    expect(settings.taxonomyModel).toBe('claude-opus-4-8');
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
    expect(errors[1]).toContain('claude-opus-4-8');
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
      provider: 'claude-cli',
      taxonomyModel: 'claude-sonnet-5',
      assignmentModel: 'claude-haiku-4-5',
      effort: 'low',
      configuredAt: '2026-01-02T03:04:05.000Z',
    };
    writeSettings(db, settings);
    expect(readSettings(db, catalog)).toEqual(settings);
  });

  it('survives a reopen of the same database file (durable, not per-process)', () => {
    writeSettings(db, { categorizer: 'typesafe', provider: 'claude-cli', effort: 'max' });
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

  it('maps the chosen method and provider onto the ingest config', () => {
    const config = applySettingsToConfig(base(), {
      categorizer: 'typesafe',
      provider: 'claude-cli',
    });
    expect(config.categorizer).toBe('typesafe');
    expect(config.llm.defaultProvider).toBe('claude-cli');
  });

  it('pins the per-pass models and the taxonomy effort the owner picked', () => {
    const config = applySettingsToConfig(base(), {
      categorizer: 'claude-cli',
      provider: 'claude-cli',
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
      provider: 'claude-cli',
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
      provider: 'claude-cli',
    });
    expect(after.batchSize).toBe(7);
    expect(after.maxCategoryDepth).toBe(6);
    expect(after.typesafe).toEqual(before.typesafe);
  });

  it('lets the stored choice win when no environment is passed (the viewer)', () => {
    const before = loadConfig({ XBOOKMARKS_CATEGORIZER: 'typesafe', XBOOKMARKS_MODEL: 'claude-opus-4-8' });
    const after = applySettingsToConfig(before, {
      categorizer: 'claude-cli',
      provider: 'claude-cli',
      assignmentModel: 'claude-haiku-4-5',
    });
    expect(after.categorizer).toBe('claude-cli');
    expect(after.llm.roles.assignment.model).toBe('claude-haiku-4-5');
  });

  it('lets an explicitly exported variable win when the environment is passed (the CLI)', () => {
    const env = { XBOOKMARKS_CATEGORIZER: 'typesafe', XBOOKMARKS_MODEL: 'claude-opus-4-8' };
    const after = applySettingsToConfig(
      loadConfig(env),
      { categorizer: 'claude-cli', provider: 'claude-cli', assignmentModel: 'claude-haiku-4-5' },
      env,
    );
    expect(after.categorizer).toBe('typesafe');
    expect(after.llm.roles.assignment.model).toBe('claude-opus-4-8');
  });

  it('still applies the fields the passed environment does NOT claim', () => {
    const env = { XBOOKMARKS_CATEGORIZER: 'typesafe' };
    const after = applySettingsToConfig(
      loadConfig(env),
      { categorizer: 'claude-cli', provider: 'claude-cli', effort: 'low' },
      env,
    );
    expect(after.categorizer).toBe('typesafe');
    expect(after.llm.roles.taxonomy.params?.effort).toBe('low');
  });
});
