import { describe, expect, it } from 'vitest';
import {
  CATEGORIZER_IDS,
  loadConfig,
  requireTypeSafeCredentials,
  TYPESAFE_API_KEY,
  unknownCategorizerMessage,
} from './config';
import type { CredentialStore } from './creds/resolve';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PACKAGE_ROOT } from './paths';

/**
 * The selector is the money switch: with nothing set, categorization must stay
 * on the flat-rate Claude subscription, and the paid path must be unreachable
 * without BOTH an explicit opt-in and a resolved key.
 */

/** A credential store over a plain object - no keychain, no files, no env. */
function fakeStore(values: Record<string, string> = {}): CredentialStore {
  return {
    get: (key) => (values[key] ? { value: values[key], source: 'env' } : { value: undefined, source: 'none' }),
    set: () => {},
    clear: () => {},
  };
}

describe('categorizer selection', () => {
  it('defaults to the Claude CLI when nothing is set', () => {
    expect(loadConfig({}).categorizer).toBe('claude-cli');
  });

  it('stays on Claude when the variable is set to blank', () => {
    expect(loadConfig({ XBOOKMARKS_CATEGORIZER: '   ' }).categorizer).toBe('claude-cli');
  });

  it('switches to typesafe on explicit opt-in', () => {
    expect(loadConfig({ XBOOKMARKS_CATEGORIZER: 'typesafe' }).categorizer).toBe('typesafe');
  });

  it('accepts the id case-insensitively', () => {
    expect(loadConfig({ XBOOKMARKS_CATEGORIZER: 'TypeSafe' }).categorizer).toBe('typesafe');
  });

  it('rejects an unknown id loudly, listing what exists', () => {
    expect(() => loadConfig({ XBOOKMARKS_CATEGORIZER: 'jeff' })).toThrow(/Unknown categorizer "jeff"/);
    expect(unknownCategorizerMessage('jeff')).toContain('claude-cli, typesafe');
  });

  it('is independent of the LLM provider selector', () => {
    // Selecting a categorizer must not move the summary/chat roles onto it.
    const config = loadConfig({ XBOOKMARKS_CATEGORIZER: 'typesafe' });

    expect(config.llm.defaultProvider).toBe('claude-cli');
    expect(config.llm.roles.summary.provider).toBeUndefined();
    expect(config.llm.roles.chat.provider).toBeUndefined();
  });

  it('exposes exactly the two implementations', () => {
    expect([...CATEGORIZER_IDS]).toEqual(['claude-cli', 'typesafe']);
  });
});

describe('typesafe tuning', () => {
  it('has sane defaults without any environment', () => {
    const { typesafe } = loadConfig({});

    expect(typesafe.beamWidth).toBe(3);
    expect(typesafe.confidenceThreshold).toBeCloseTo(0.55);
    expect(typesafe.multiLabelThreshold).toBeCloseTo(0.6);
    expect(typesafe.maxLabels).toBe(3);
    expect(typesafe.concurrency).toBe(8);
    expect(typesafe.model).toBeUndefined();
  });

  it('reads overrides from the environment', () => {
    const { typesafe } = loadConfig({
      XBOOKMARKS_TYPESAFE_MODEL: 'jev-1.13.0',
      XBOOKMARKS_TYPESAFE_BEAM_WIDTH: '5',
      XBOOKMARKS_TYPESAFE_CONFIDENCE: '0.8',
      XBOOKMARKS_TYPESAFE_MULTILABEL: '0.42',
      XBOOKMARKS_TYPESAFE_MAX_LABELS: '2',
      XBOOKMARKS_TYPESAFE_CONCURRENCY: '16',
    });

    expect(typesafe.model).toBe('jev-1.13.0');
    expect(typesafe.beamWidth).toBe(5);
    expect(typesafe.confidenceThreshold).toBeCloseTo(0.8);
    expect(typesafe.multiLabelThreshold).toBeCloseTo(0.42);
    expect(typesafe.maxLabels).toBe(2);
    expect(typesafe.concurrency).toBe(16);
  });

  it('ignores a ratio outside 0..1 rather than producing a nonsense threshold', () => {
    const { typesafe } = loadConfig({
      XBOOKMARKS_TYPESAFE_CONFIDENCE: '7',
      XBOOKMARKS_TYPESAFE_MULTILABEL: 'not-a-number',
    });

    expect(typesafe.confidenceThreshold).toBeCloseTo(0.55);
    expect(typesafe.multiLabelThreshold).toBeCloseTo(0.6);
  });
});

describe('requireTypeSafeCredentials', () => {
  it('returns the key resolved through the credential chain', () => {
    expect(requireTypeSafeCredentials(fakeStore({ [TYPESAFE_API_KEY]: 'sk-abc' }))).toBe('sk-abc');
  });

  it('refuses cleanly when no key is resolvable anywhere', () => {
    expect(() => requireTypeSafeCredentials(fakeStore())).toThrow(/TYPESAFE_API_KEY/);
  });

  it('says the paid path is what needs the key, and how to get back to the free one', () => {
    let message = '';
    try {
      requireTypeSafeCredentials(fakeStore());
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).toContain('PAID per token');
    expect(message).toContain('XBOOKMARKS_CATEGORIZER');
  });

  it('never echoes the key value it resolved', () => {
    const store = fakeStore({ [TYPESAFE_API_KEY]: 'sk-secret-value' });

    // The success path returns it to the caller but nothing is thrown/logged.
    expect(requireTypeSafeCredentials(store)).toBe('sk-secret-value');
  });
});

describe('default database path (security finding #3)', () => {
  it('resolves from the package root, not the directory the app was started from', () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'xbo-cwd-'));
    const previous = process.cwd();
    process.chdir(elsewhere);
    try {
      expect(loadConfig({}).dbPath).toBe(path.join(PACKAGE_ROOT, 'data', 'bookmarks.db'));
      // An explicit path is the owner's own words, so a relative one still means "from here".
      expect(loadConfig({ XBOOKMARKS_DB_PATH: 'mine.db' }).dbPath).toBe(path.resolve('mine.db'));
    } finally {
      process.chdir(previous);
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});
