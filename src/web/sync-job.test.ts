import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { Database } from '../db/database';
import { loadConfig, type Config } from '../config';
import type { CredentialStore, ResolvedCredential } from '../creds/resolve';
import type { BookmarkPage, XClient } from '../x/client';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { BatchCategorizer } from '../categorize/llm';
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
  batches: string[][] = [];
  async categorizeBatch(batch: RawBookmark[]): Promise<Assignment[]> {
    this.batches.push(batch.map((b) => b.postId));
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

  it('files only the NEW bookmarks on a second run', async () => {
    const run = job();
    await run(() => {});
    expect(categorizer.batches).toEqual([['1', '2']]);

    const summary = await createSyncJob({
      db,
      store: storeWith(X_CREDS),
      config: loadConfig({ ...X_CREDS }),
      connect: async () => new FakeXClient([bm('3'), bm('2'), bm('1')]),
      buildCategorizers: () => ({ taxonomer: new FakeTaxonomer(), categorizer }),
    })(() => {});

    expect(summary.newBookmarks).toBe(1);
    expect(categorizer.batches).toEqual([['1', '2'], ['3']]);
    expect(db.getBookmarkCount()).toBe(3);
  });
});

/**
 * Regression for the owner's report: Claude Code subscription for phase 1, Jev
 * for phase 2, no ANTHROPIC_API_KEY - and every sync died on
 * `pi-ai model "anthropic/claude-haiku-4-5" ... needs ANTHROPIC_API_KEY`,
 * because a pi-ai filing provider left over from before Jev was picked was
 * still checked. Jev calls no language model now, so nothing but phase 1's
 * model may ever be required of a Jev sync.
 */
describe('a Jev sync requires only the phase-1 language model', () => {
  const OWNER_DOC = {
    categorizer: 'typesafe',
    taxonomyProvider: 'claude-cli',
    assignmentProvider: 'pi-ai',
    fallbackProvider: 'pi-ai',
    configuredAt: '2026-09-21T10:28:55.227Z',
  };
  /** Everything the owner's `av inject` resolves - and no ANTHROPIC_API_KEY. */
  const OWNER_KEYS = { ...X_CREDS, TYPESAFE_API_KEY: 'ts', OPENROUTER_API_KEY: 'or' };
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

  beforeEach(() => {
    db = new Database(':memory:');
    db.setRefreshToken('stored-refresh-token');
    seen = [];
  });
  afterEach(() => db.close());

  it('starts a first and a later sync with a stale pi-ai filer and an old fallback stored', async () => {
    db.setState('app_settings', JSON.stringify(OWNER_DOC));
    await run();
    await run();
    expect(seen).toHaveLength(2);
    for (const config of seen) expect(config.categorizer).toBe('typesafe');
    await expect(
      createSyncPreflight({ db, store: storeWith(OWNER_KEYS), config: loadConfig({ ...X_CREDS }) })(),
    ).resolves.toBeDefined();
  });

  it('refuses a sync whose phase-1 model lacks its key, naming the Settings field to change', async () => {
    writeSettings(db, { categorizer: 'typesafe', taxonomyProvider: 'pi-ai', taxonomyModel: 'anthropic/claude-opus-4-8' } as never);
    const failure = createSyncPreflight({ db, store: storeWith(OWNER_KEYS), config: loadConfig({ ...X_CREDS }) })();
    await expect(failure).rejects.toThrow(/^The phase 1 \(taxonomy\) language model cannot run: .*ANTHROPIC_API_KEY/);
    await expect(failure).rejects.toThrow(/open Settings and change "Taxonomy provider" under Phase 1 - Taxonomy\./);
    await expect(run()).rejects.toThrow(/Taxonomy provider/);
    expect(seen).toEqual([]);
  });
});

/**
 * The whole in-app sync with the REAL categorizer builder: the real
 * `claude-cli` adapter spawning a stub `claude` that records every prompt it
 * is given, and the real TypeSafe SDK against a local stand-in for the API.
 * Only the X client is faked. Proves the design end to end: phase 1 runs on
 * every sync (designing, then growing the tree for a novel topic), and Jev
 * files - into the category phase 1 just added - without a single filing
 * call to a language model.
 */
describe('Jev syncs end to end: phase 1 every sync, no language model in phase 2', () => {
  let dir: string;
  let claude: string;
  let promptLog: string;
  let typesafe: http.Server;
  let typesafeUrl: string;
  const jevStates: string[] = [];

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbo-e2e-'));
    promptLog = path.join(dir, 'prompts.log');
    claude = path.join(dir, 'claude');
    const design = { tree: [{ name: 'AI', description: 'Artificial intelligence.', children: [{ name: 'Evals', children: [] }] }] };
    const grow = { tree: [{ name: 'Gardening', description: 'Growing plants.', children: [] }] };
    fs.writeFileSync(
      claude,
      `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv[2] === '--version') { console.log('9.9.9 (stub)'); process.exit(0); }
let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  const first = input.split('\\n')[0];
  fs.appendFileSync(${JSON.stringify(promptLog)}, first + '\\n');
  const tree = first.startsWith('You are growing') ? ${JSON.stringify(JSON.stringify(grow))} : first.startsWith('You are designing') ? ${JSON.stringify(JSON.stringify(design))} : '{"assignments":[]}';
  process.stdout.write(JSON.stringify({ result: tree }));
});
`,
      { mode: 0o755 },
    );
    // A stand-in TypeSafe API: "tomato" posts are Gardening, the rest AI > Evals.
    typesafe = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const text = JSON.stringify(body.state);
        jevStates.push(text);
        const want = /tomato/.test(text) ? ['Gardening'] : ['AI', 'Evals'];
        const answers: Record<string, unknown> = {};
        for (const [key, q] of Object.entries(body.questions as Record<string, { criteria: Record<string, unknown> }>)) {
          const labels = Object.keys(q.criteria);
          const hit = labels.find((l) => want.includes(l));
          answers[key] = {
            type: 'choice',
            choice: hit ?? labels[0],
            confidence: hit ? 0.95 : 0.05,
            probabilities: Object.fromEntries(labels.map((l) => [l, l === hit ? 0.95 : 0.02])),
          };
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ model: 'jev-stub', answers, usage: { input_tokens: 1, output_tokens: 0 } }));
      });
    });
    await new Promise<void>((resolve) => typesafe.listen(0, '127.0.0.1', resolve));
    typesafeUrl = `http://127.0.0.1:${(typesafe.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => typesafe.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('designs, then grows the tree for a novel topic, and Jev files both syncs with no LLM filing call', async () => {
    const db = new Database(':memory:');
    try {
      db.setRefreshToken('stored-refresh-token');
      writeSettings(db, { categorizer: 'typesafe', taxonomyProvider: 'claude-cli', assignmentProvider: 'claude-cli' });
      const sync = (bookmarks: RawBookmark[]) =>
        createSyncJob({
          db,
          store: fakeStore({ ...X_CREDS, TYPESAFE_API_KEY: 'not-a-real-key', XBOOKMARKS_CLAUDE_BIN: claude }),
          config: loadConfig({ ...X_CREDS, XBOOKMARKS_TYPESAFE_BASE_URL: typesafeUrl }),
          connect: async () => new FakeXClient(bookmarks),
        })(() => {});
      const post = (postId: string, text: string): RawBookmark => ({ ...bm(postId), text });

      await sync([post('2', 'an eval harness'), post('1', 'llm evals')]);
      await sync([post('3', 'growing tomatoes'), post('2', 'an eval harness'), post('1', 'llm evals')]);

      const prompts = fs.readFileSync(promptLog, 'utf8').trim().split('\n');
      expect(prompts).toEqual([
        expect.stringMatching(/^You are designing a category taxonomy/),
        expect.stringMatching(/^You are growing the category taxonomy/),
      ]);
      expect(jevStates.length).toBeGreaterThan(0);

      const gardening = db.findCategory('Gardening', null)!;
      const evals = db.findCategory('Evals', db.findCategory('AI', null)!.id)!;
      expect(db.getBookmarksForCategory(gardening.id).map((b) => b.postId)).toEqual(['3']);
      expect(db.getBookmarksForCategory(evals.id).map((b) => b.postId).sort()).toEqual(['1', '2']);
      expect(db.getAllCategories().some((c) => c.name === 'Uncategorized')).toBe(false);
    } finally {
      db.close();
    }
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

  it('keeps the taxonomy pass once a tree exists, since every sync runs it', async () => {
    writeSettings(db, { categorizer: 'claude-cli', taxonomyProvider: 'pi-ai', assignmentProvider: 'claude-cli' });
    expect((await spend()).map((p) => p.pass)).toEqual(['taxonomy']);
    db.getOrCreateCategory('AI', null, new Date().toISOString());
    expect((await spend()).map((p) => p.pass)).toEqual(['taxonomy']);
  });

  it('names Jev filing, and never a language model behind it', async () => {
    // A stored document from when Jev had a fallback language model.
    db.setState(
      'app_settings',
      JSON.stringify({ categorizer: 'typesafe', taxonomyProvider: 'claude-cli', assignmentProvider: 'pi-ai', fallbackProvider: 'pi-ai' }),
    );
    expect((await spend()).map((p) => [p.pass, p.providerId])).toEqual([['filing', 'typesafe']]);
    db.getOrCreateCategory('AI', null, new Date().toISOString());
    expect((await spend()).map((p) => [p.pass, p.providerId])).toEqual([['filing', 'typesafe']]);
  });

  it('names a paid taxonomy pass beside Jev on every sync', async () => {
    writeSettings(db, { categorizer: 'typesafe', taxonomyProvider: 'pi-ai', assignmentProvider: 'claude-cli' });
    db.getOrCreateCategory('AI', null, new Date().toISOString());
    expect((await spend()).map((p) => [p.pass, p.providerId])).toEqual([
      ['taxonomy', 'pi-ai'],
      ['filing', 'typesafe'],
    ]);
  });
});
