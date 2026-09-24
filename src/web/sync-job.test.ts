import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { Database } from '../db/database';
import { loadConfig, type Config } from '../config';
import type { CredentialStore, ResolvedCredential } from '../creds/resolve';
import type { BookmarkPage, XClient } from '../x/client';
import type { AssignMode, BatchCategorizer } from '../categorize/llm';
import type { TaxonomyDesigner, TaxonomyNode } from '../categorize/taxonomy';
import type { Assignment, RawBookmark } from '../types';
import { writeSettings } from '../settings/settings';
import type { ModelBrowser } from '../settings/model-browser';
import { createSyncJob, createSyncPreflight, createSyncSpend, NOT_CONNECTED_MESSAGE } from './sync-job';

/**
 * Entirely offline. The X client and both categorization passes are faked, and
 * the provider preflight (`requireLlm`, which spawns `claude --version`) points
 * at a throwaway stub script the same way the adapter's own tests do - so this
 * exercises the REAL job end to end with no network, no credentials and no
 * subscription usage.
 */
let claudeStub: string;

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbo-sync-stub-'));
  claudeStub = path.join(dir, 'claude-ok');
  fs.writeFileSync(
    claudeStub,
    "#!/usr/bin/env node\nif (process.argv[2] === '--version') { console.log('9.9.9 (stub)'); process.exit(0); }\nprocess.exit(1);\n",
    { mode: 0o755 },
  );
});

afterAll(() => {
  fs.rmSync(path.dirname(claudeStub), { recursive: true, force: true });
});

const bm = (postId: string): RawBookmark => ({
  postId,
  authorUsername: 'a',
  authorName: 'A',
  text: `about evals ${postId}`,
  url: `https://x.com/a/status/${postId}`,
  postCreatedAt: '',
});

/** A fake X client - the same seam the ingest tests use; no network, no credentials. */
class FakeXClient implements XClient {
  constructor(private readonly bookmarks: RawBookmark[]) {}
  async fetchBookmarksPage(): Promise<BookmarkPage> {
    return { bookmarks: this.bookmarks };
  }
}

class FakeTaxonomer implements TaxonomyDesigner {
  async designTaxonomy(): Promise<TaxonomyNode[]> {
    return [{ name: 'AI', children: [{ name: 'Evals', children: [] }] }];
  }
}

class FakeCategorizer implements BatchCategorizer {
  modes: AssignMode[] = [];
  async categorizeBatch(batch: RawBookmark[], _tree: string, mode: AssignMode): Promise<Assignment[]> {
    this.modes.push(mode);
    return batch.map((b) => ({ postId: b.postId, categories: [['AI', 'Evals']] }));
  }
}

/** A credential store backed by a plain map - no keychain, no `.env`, no vault. */
function fakeStore(values: Record<string, string>): CredentialStore {
  return {
    get(key: string): ResolvedCredential {
      const value = values[key];
      return value ? { key, value, source: 'env' } : { key, source: 'none' };
    },
  };
}

const X_CREDS = { XBOOKMARKS_CLIENT_ID: 'id', XBOOKMARKS_CLIENT_SECRET: 'secret' };

/** The credential chain the job resolves through, with the stub CLI on it. */
const storeWith = (values: Record<string, string>) =>
  fakeStore({ ...values, XBOOKMARKS_CLAUDE_BIN: claudeStub });

describe('createSyncJob', () => {
  let db: Database;
  let categorizer: FakeCategorizer;
  let seenConfigs: Config[];

  /** The job with every outward-facing collaborator faked. */
  const job = (opts: { config?: Config; store?: CredentialStore } = {}) =>
    createSyncJob({
      db,
      store: opts.store ?? storeWith(X_CREDS),
      config: opts.config ?? loadConfig({ ...X_CREDS }),
      connect: async () => new FakeXClient([bm('2'), bm('1')]),
      buildCategorizers: (config) => {
        seenConfigs.push(config);
        return { taxonomer: new FakeTaxonomer(), categorizer };
      },
    });

  beforeEach(() => {
    db = new Database(':memory:');
    db.setRefreshToken('stored-refresh-token');
    categorizer = new FakeCategorizer();
    seenConfigs = [];
  });
  afterEach(() => db.close());

  it('runs a real ingest: new bookmarks are stored, categorized and counted', async () => {
    const messages: string[] = [];
    const summary = await job()((m) => messages.push(m));

    expect(summary.newBookmarks).toBe(2);
    expect(db.getBookmarkCount()).toBe(2);
    expect(db.getAllCategories().map((c) => c.name).sort()).toEqual(['AI', 'Evals']);
    expect(db.getLastSyncedAt()).toBeTruthy();
    // The owner watches the ingest's own progress, not a parallel vocabulary.
    expect(messages).toContain('Found 2 new bookmark(s).');
  });

  it('announces how the run is billed before doing any work', async () => {
    const messages: string[] = [];
    await job()((m) => messages.push(m));
    const billing = messages.findIndex((m) => m.startsWith('Assignment pass:'));
    expect(billing).toBe(0);
    expect(messages[billing]).toContain('claude-cli');
  });

  it('maps the SAVED categorization choice onto the ingest config, with no env vars set', async () => {
    writeSettings(db, {
      categorizer: 'typesafe',
      provider: 'claude-cli',
      taxonomyModel: 'anthropic/claude-sonnet-5',
      fallbackProvider: 'claude-cli',
      fallbackModel: 'anthropic/claude-opus-4-8',
      effort: 'max',
      configuredAt: '2026-01-01T00:00:00.000Z',
    });

    const messages: string[] = [];
    await job()((m) => messages.push(m));

    const config = seenConfigs[0]!;
    expect(config.categorizer).toBe('typesafe');
    expect(config.llm.defaultProvider).toBe('claude-cli');
    expect(config.llm.roles.taxonomy.model).toBe('anthropic/claude-sonnet-5');
    expect(config.llm.roles.taxonomy.params?.effort).toBe('max');
    expect(config.llm.roles.assignment.model).toBe('anthropic/claude-opus-4-8');
    // The paid path announces itself every run - never silently.
    expect(messages[0]).toContain('TypeSafe Jev');
    expect(messages[0]).toContain('pay-per-token');
  });

  it('re-reads the settings on every run, so a change needs no restart', async () => {
    const run = job();
    await run(() => {});
    expect(seenConfigs[0]!.categorizer).toBe('claude-cli');

    writeSettings(db, { categorizer: 'typesafe', provider: 'claude-cli' });
    await run(() => {});
    expect(seenConfigs[1]!.categorizer).toBe('typesafe');
  });

  it('lets the saved choice override a variable in the shell that launched the viewer', async () => {
    writeSettings(db, { categorizer: 'claude-cli', provider: 'claude-cli' });
    await job({ config: loadConfig({ ...X_CREDS, XBOOKMARKS_CATEGORIZER: 'typesafe' }) })(() => {});
    expect(seenConfigs[0]!.categorizer).toBe('claude-cli');
  });

  it('refuses with the credential chain message when the X app credentials are missing', async () => {
    await expect(job({ config: loadConfig({}), store: storeWith({}) })(() => {})).rejects.toThrow(
      /XBOOKMARKS_CLIENT_ID/,
    );
  });

  it('refuses with an in-app message, not a CLI instruction, when X was never authorized', async () => {
    const fresh = new Database(':memory:');
    try {
      const run = createSyncJob({
        db: fresh,
        store: storeWith(X_CREDS),
        config: loadConfig({ ...X_CREDS }),
        connect: async () => new FakeXClient([]),
        buildCategorizers: () => ({ taxonomer: new FakeTaxonomer(), categorizer }),
      });
      await expect(run(() => {})).rejects.toThrow(NOT_CONNECTED_MESSAGE);
    } finally {
      fresh.close();
    }
  });

  it('files only the NEW bookmarks on a second run, extending the existing tree', async () => {
    const run = job();
    await run(() => {});
    expect(categorizer.modes).toEqual(['strict']);

    const summary = await createSyncJob({
      db,
      store: storeWith(X_CREDS),
      config: loadConfig({ ...X_CREDS }),
      connect: async () => new FakeXClient([bm('3'), bm('2'), bm('1')]),
      buildCategorizers: () => ({ taxonomer: new FakeTaxonomer(), categorizer }),
    })(() => {});

    expect(summary.newBookmarks).toBe(1);
    expect(categorizer.modes).toEqual(['strict', 'extend']);
    expect(db.getBookmarkCount()).toBe(3);
  });
});

/**
 * Regression for the owner's report: Claude Code subscription for phase 1, Jev
 * for phase 2, no ANTHROPIC_API_KEY - and every sync died on
 * `pi-ai model "anthropic/claude-haiku-4-5" ... needs ANTHROPIC_API_KEY`.
 *
 * The landing view let a pi-ai filing choice survive a switch to Jev (the
 * combined selector keeps the filing provider as Jev's fallback, and hides it),
 * so the stored document was exactly OWNER_DOC below. The sync preflight then
 * required the assignment role - that hidden pi-ai - even on a FIRST run, where
 * Jev files strictly and never calls a language model.
 */
describe("Jev's fallback language model (the hidden pi-ai filing provider)", () => {
  const OWNER_DOC = {
    categorizer: 'typesafe',
    taxonomyProvider: 'claude-cli',
    assignmentProvider: 'pi-ai',
    configuredAt: '2026-09-21T10:28:55.227Z',
  };
  /** Everything the owner's `av inject` resolves - and no ANTHROPIC_API_KEY. */
  const OWNER_KEYS = {
    ...X_CREDS,
    OPENROUTER_API_KEY: 'or',
    TYPESAFE_API_KEY: 'ts',
    OPENCODE_API_KEY: 'oc',
    OPENAI_API_KEY: 'oa',
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
  };
  let db: Database;
  let seen: Config[];

  const run = () =>
    createSyncJob({
      db,
      store: storeWith(OWNER_KEYS),
      config: loadConfig({ ...X_CREDS }),
      connect: async () => new FakeXClient([bm(String(Date.now()))]),
      buildCategorizers: (config) => {
        seen.push(config);
        return { taxonomer: new FakeTaxonomer(), categorizer: new FakeCategorizer() };
      },
    })(() => {});
  const preflight = () =>
    createSyncPreflight({ db, store: storeWith(OWNER_KEYS), config: loadConfig({ ...X_CREDS }) })();

  beforeEach(() => {
    db = new Database(':memory:');
    db.setRefreshToken('stored-refresh-token');
    seen = [];
  });
  afterEach(() => db.close());

  it("runs the owner's saved settings: the unseen pi-ai filing provider is never Jev's fallback", async () => {
    db.setState('app_settings', JSON.stringify(OWNER_DOC));
    // First run (no tree yet), then an extending run - both must start.
    await run();
    db.getOrCreateCategory('AI', null, new Date().toISOString());
    await run();
    expect(seen).toHaveLength(2);
    for (const config of seen) {
      expect(config.categorizer).toBe('typesafe');
      // Unset fallback = the phase-1 provider (the subscription), with its own filing suggestion.
      expect(config.llm.roles.assignment.provider).toBe('claude-cli');
      expect(config.llm.roles.assignment.model).toBeUndefined();
    }
  });

  it("does not require Jev's fallback on a first run, which never calls it", async () => {
    writeSettings(db, { ...OWNER_DOC, fallbackProvider: 'pi-ai' } as never);
    await expect(preflight()).resolves.toBeDefined();
  });

  it("refuses an extending sync whose chosen fallback lacks its key, naming the setting to change", async () => {
    writeSettings(db, { ...OWNER_DOC, fallbackProvider: 'pi-ai' } as never);
    db.getOrCreateCategory('AI', null, new Date().toISOString());
    const failure = preflight();
    await expect(failure).rejects.toThrow(/^Jev's fallback language model cannot run: .*ANTHROPIC_API_KEY/);
    await expect(failure).rejects.toThrow(/open Settings and change "Jev's fallback provider" under Phase 2 - Filing\./);
    // ...and the job itself refuses the same way, before reading X.
    await expect(run()).rejects.toThrow(/Jev's fallback provider/);
    expect(seen).toEqual([]);
  });
});

describe('createSyncSpend (security review 2, #20)', () => {
  let db: Database;
  const config = loadConfig({ ...X_CREDS });
  const store = fakeStore({});
  /** A catalog read that knows one model beyond the recommended list. */
  const browser: ModelBrowser = {
    async list(providerId, source) {
      return {
        ok: true,
        models:
          providerId === 'pi-ai' && source === 'openrouter'
            ? [{ id: 'openrouter/acme/wordy-1', label: 'Wordy 1', suggestedFor: [], price: { input: 0.5, output: 1.5 } }]
            : [],
      };
    },
  };
  const spend = () => createSyncSpend({ db, store, config, browser })();

  beforeEach(() => {
    db = new Database(':memory:');
  });
  afterEach(() => db.close());

  it('reports nothing paid for the default, subscription-backed passes', async () => {
    expect(await spend()).toEqual([]);
  });

  it('names both pi-ai passes, with their catalog prices, before the first sync', async () => {
    writeSettings(db, {
      categorizer: 'claude-cli',
      taxonomyProvider: 'pi-ai',
      taxonomyModel: 'anthropic/claude-opus-4-8',
      assignmentProvider: 'pi-ai',
      assignmentModel: 'openrouter/acme/wordy-1',
    });
    expect(await spend()).toEqual([
      expect.objectContaining({
        pass: 'taxonomy',
        providerId: 'pi-ai',
        model: 'anthropic/claude-opus-4-8',
        modelLabel: 'Claude Opus 4.8 (Anthropic API)',
        price: { input: 5, output: 25 },
      }),
      expect.objectContaining({
        pass: 'filing',
        model: 'openrouter/acme/wordy-1',
        modelLabel: 'Wordy 1',
        price: { input: 0.5, output: 1.5 },
      }),
    ]);
  });

  it('drops the taxonomy pass once a tree exists, since an incremental sync never runs it', async () => {
    writeSettings(db, { categorizer: 'claude-cli', taxonomyProvider: 'pi-ai', assignmentProvider: 'claude-cli' });
    expect((await spend()).map((p) => p.pass)).toEqual(['taxonomy']);
    db.getOrCreateCategory('AI', null, new Date().toISOString());
    expect(await spend()).toEqual([]);
  });

  it("names Jev filing, and its paid LLM fallback when a tree is being extended", async () => {
    writeSettings(db, {
      categorizer: 'typesafe',
      taxonomyProvider: 'claude-cli',
      assignmentProvider: 'claude-cli',
      fallbackProvider: 'pi-ai',
    });
    expect((await spend()).map((p) => [p.pass, p.providerId])).toEqual([['filing', 'typesafe']]);
    db.getOrCreateCategory('AI', null, new Date().toISOString());
    expect((await spend()).map((p) => [p.pass, p.providerId])).toEqual([
      ['filing', 'typesafe'],
      ['filing-fallback', 'pi-ai'],
    ]);
  });

  it('never bills a fallback the owner could not see: an unset one follows the phase-1 provider', async () => {
    // The owner's stored document: a pi-ai filing provider left over from before Jev was picked.
    db.setState('app_settings', JSON.stringify({ categorizer: 'typesafe', taxonomyProvider: 'claude-cli', assignmentProvider: 'pi-ai' }));
    db.getOrCreateCategory('AI', null, new Date().toISOString());
    expect((await spend()).map((p) => [p.pass, p.providerId])).toEqual([['filing', 'typesafe']]);
  });
});
