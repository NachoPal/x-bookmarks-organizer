import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from './server';
import { createFindWiring, type FindModel, type FindWiring } from './find-job';
import type { SyncJob } from './sync';
import { Database } from '../db/database';
import { loadConfig } from '../config';
import type { CredentialStore, ResolvedCredential } from '../creds/resolve';
import type { LlmFactory } from '../llm/factory';
import type { Billing } from '../llm/types';
import type { FindSummary } from '../categorize/find';
import type { RawBookmark } from '../types';

/**
 * The owner-category surface: the editor's "this one is mine" toggle, and
 * "Find bookmarks for this category" - its preview, its paid confirmation
 * (the same rule a paid sync follows), its single run slot, and its undo.
 * Offline end to end: the filing model is a fake function.
 */

const WHEN = '2026-09-24T00:00:00.000Z';
const bm = (postId: string, text = `t-${postId}`): RawBookmark => ({
  postId,
  authorUsername: 'a',
  authorName: 'A',
  text,
  url: `https://x.com/a/status/${postId}`,
  postCreatedAt: '',
});

const store: CredentialStore = {
  get(key: string): ResolvedCredential {
    return { key, source: 'none' };
  },
};

/** A provider factory whose assignment role answers with `answer(prompt)`. */
function fakeLlm(answer: (prompt: string) => string, billing: Billing = 'subscription'): LlmFactory {
  return {
    forRole: () => ({
      providerId: 'claude-cli',
      model: 'anthropic/claude-haiku-4-5',
      billing,
      complete: async ({ prompt }) => ({ text: answer(prompt) }),
    }),
    check: async () => ({ state: 'ok', detail: 'ok' }),
    describe: () => ({ providerId: 'claude-cli', model: 'anthropic/claude-haiku-4-5', billing }),
  };
}

const noFetch = { fetch: async () => ({ status: 'failed' as const, reason: 'offline' }) };

async function waitForFind(app: FastifyInstance): Promise<{ state: string; summary: FindSummary | null; error: string | null; messages: string[] }> {
  for (let i = 0; i < 100; i++) {
    const status = (await app.inject({ method: 'GET', url: '/api/find-bookmarks' })).json().status;
    if (status.state !== 'running') return status;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('find never finished');
}

describe('owner category API', () => {
  let db: Database;
  let app: FastifyInstance;

  beforeEach(async () => {
    db = new Database(':memory:');
    app = buildServer(db);
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    db.close();
  });

  it('creates categories as the owner’s, and serves origin on the tree', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/categories', payload: { name: 'Rust' } });
    expect(res.json().category.origin).toBe('user');
    db.getOrCreateCategory('AI', null, WHEN);
    const tree = (await app.inject({ method: 'GET', url: '/api/tree' })).json().tree;
    expect(tree.map((n: { name: string; origin: string }) => [n.name, n.origin])).toEqual([
      ['AI', 'generated'],
      ['Rust', 'user'],
    ]);
  });

  it('marks and unmarks a category as the owner’s', async () => {
    const ai = db.getOrCreateCategory('AI', null, WHEN);
    const put = (origin: unknown) =>
      app.inject({ method: 'PUT', url: `/api/categories/${ai.id}/origin`, payload: { origin } });
    const mine = await put('user');
    expect(mine.statusCode).toBe(200);
    expect(mine.json().category.origin).toBe('user');
    expect(mine.json().tree[0].origin).toBe('user');
    expect((await put('generated')).json().category.origin).toBe('generated');
    expect((await put('bogus')).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/api/categories/999/origin', payload: { origin: 'user' } })).statusCode).toBe(404);
  });

  it('answers the find routes as unavailable on a viewer without the wiring', async () => {
    const rust = db.createCategory('Rust', null, WHEN)!;
    const preview = (await app.inject({ method: 'GET', url: `/api/categories/${rust.id}/find-bookmarks` })).json();
    expect(preview).toMatchObject({ available: false, candidates: 0 });
    expect((await app.inject({ method: 'POST', url: `/api/categories/${rust.id}/find-bookmarks` })).statusCode).toBe(503);
  });
});

describe('find bookmarks for a category', () => {
  let db: Database;
  let app: FastifyInstance;
  let model: FindModel;
  let rust: number;
  let ai: number;

  /** A wiring whose job is the REAL one over a fake filing model. */
  function wiring(answer: (prompt: string) => string, billing: Billing = 'subscription'): FindWiring {
    const real = createFindWiring({
      db,
      store,
      config: loadConfig({}),
      createLlm: () => fakeLlm(answer, billing),
      articleFetcher: noFetch,
      browser: { list: async () => ({ ok: true, models: [] }) as never },
    });
    return { describe: async () => model, job: (id) => real.job(id) };
  }

  async function start(opts: { findBookmarks: FindWiring; syncJob?: SyncJob }): Promise<void> {
    app = buildServer(db, opts);
    await app.ready();
  }

  beforeEach(() => {
    db = new Database(':memory:');
    ai = db.getOrCreateCategory('AI', null, WHEN).id;
    rust = db.createCategory('Rust', null, WHEN)!.id;
    db.storeCategorizedBatch([bm('1', 'rust ownership'), bm('2', 'gpt evals'), bm('3', 'rust async')], () => [ai], WHEN);
    model = { available: true, spend: { providerId: 'claude-cli', providerLabel: 'Claude', model: 'm', modelLabel: 'M', billing: 'subscription' } };
  });
  afterEach(async () => {
    await app?.close();
    db.close();
  });

  const rustMatches = (prompt: string) =>
    JSON.stringify({ matches: [...prompt.matchAll(/post_id: (\d+)\n\s+author: @a\n\s+text: rust/g)].map((m) => m[1]) });

  it('previews how many bookmarks it would check, and with which model', async () => {
    await start({ findBookmarks: wiring(rustMatches) });
    const preview = (await app.inject({ method: 'GET', url: `/api/categories/${rust}/find-bookmarks` })).json();
    expect(preview).toMatchObject({ available: true, candidates: 3, spend: { billing: 'subscription' } });
    expect((await app.inject({ method: 'GET', url: '/api/categories/999/find-bookmarks' })).statusCode).toBe(404);
  });

  it('runs without a confirmation on a subscription model and adds the matches', async () => {
    await start({ findBookmarks: wiring(rustMatches) });
    const res = await app.inject({ method: 'POST', url: `/api/categories/${rust}/find-bookmarks` });
    expect(res.statusCode).toBe(202);
    const done = await waitForFind(app);
    expect(done.state).toBe('done');
    expect(done.summary).toMatchObject({ categoryId: rust, categoryName: 'Rust', checked: 3, added: 2 });
    expect(done.messages[0]).toContain('Filing model: claude-cli');
    const ids = ['1', '3'].map((p) => db.getBookmarkByPostId(p)!.id);
    for (const id of ids) {
      expect(db.getCategoryIdsForBookmarks([id]).get(id)!.sort()).toEqual([ai, rust].sort());
    }
    // The owner's category itself is untouched.
    expect(db.getCategoryById(rust)).toMatchObject({ name: 'Rust', origin: 'user', description: null });

    // Undo removes exactly those links again.
    const undo = await app.inject({
      method: 'POST',
      url: `/api/categories/${rust}/find-bookmarks/undo`,
      payload: { bookmarkIds: done.summary!.addedBookmarkIds },
    });
    expect(undo.json().removed).toBe(2);
    for (const id of ids) expect(db.getCategoryIdsForBookmarks([id]).get(id)).toEqual([ai]);
  });

  it('demands an explicit confirmation when the filing model is billed per token', async () => {
    model = { available: true, spend: { providerId: 'pi-ai', providerLabel: 'pi', model: 'x/y', modelLabel: 'Y', billing: 'per-token', price: { input: 1, output: 5 } } };
    let calls = 0;
    await start({
      findBookmarks: wiring((p) => {
        calls++;
        return rustMatches(p);
      }, 'per-token'),
    });
    const refused = await app.inject({ method: 'POST', url: `/api/categories/${rust}/find-bookmarks` });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ confirmRequired: true, spend: { billing: 'per-token' } });
    expect(calls).toBe(0);

    const ok = await app.inject({ method: 'POST', url: `/api/categories/${rust}/find-bookmarks`, payload: { confirm: true } });
    expect(ok.statusCode).toBe(202);
    expect((await waitForFind(app)).summary!.added).toBe(2);
    expect(calls).toBe(1);
  });

  it('refuses while the filing model cannot run', async () => {
    model = { available: false, reason: 'The claude CLI was not found.' };
    await start({ findBookmarks: wiring(rustMatches) });
    const res = await app.inject({ method: 'POST', url: `/api/categories/${rust}/find-bookmarks`, payload: { confirm: true } });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toContain('claude CLI');
  });

  it('never races a sync, and holds category edits and a sync back while it runs', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const syncJob: SyncJob = async () => {
      await gate;
      return { newBookmarks: 0, batches: 0, nodesCreated: 0 };
    };
    let answer!: () => void;
    const answered = new Promise<void>((r) => (answer = r));
    const slow = wiring(rustMatches);
    const findBookmarks: FindWiring = {
      describe: slow.describe,
      job: (id) => async (log) => {
        await answered;
        return slow.job(id)(log);
      },
    };
    await start({ findBookmarks, syncJob });

    expect((await app.inject({ method: 'POST', url: '/api/sync' })).statusCode).toBe(202);
    expect((await app.inject({ method: 'POST', url: `/api/categories/${rust}/find-bookmarks` })).statusCode).toBe(409);
    release();
    await new Promise((r) => setTimeout(r, 10));

    expect((await app.inject({ method: 'POST', url: `/api/categories/${rust}/find-bookmarks` })).statusCode).toBe(202);
    expect((await app.inject({ method: 'POST', url: '/api/sync' })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: `/api/categories/${rust}/find-bookmarks` })).statusCode).toBe(409);
    expect((await app.inject({ method: 'DELETE', url: `/api/categories/${rust}` })).statusCode).toBe(409);
    expect(
      (await app.inject({ method: 'PUT', url: `/api/categories/${ai}/origin`, payload: { origin: 'user' } })).statusCode,
    ).toBe(409);
    const setup = (await app.inject({ method: 'GET', url: '/api/setup' })).json();
    expect(setup.find).toMatchObject({ available: true, status: { state: 'running' } });
    answer();
    expect((await waitForFind(app)).state).toBe('done');
  });
});

describe("find bookmarks while Jev files: it runs on Jev's fallback language model", () => {
  let db: Database;
  let dir: string;

  beforeEach(() => {
    db = new Database(':memory:');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbo-find-stub-'));
  });
  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** The REAL provider factory, over a credential store with no ANTHROPIC_API_KEY and a stub `claude`. */
  function realWiring(): FindWiring {
    const claude = path.join(dir, 'claude');
    fs.writeFileSync(claude, "#!/usr/bin/env node\nconsole.log('9.9.9 (stub)');\n", { mode: 0o755 });
    const values: Record<string, string> = { XBOOKMARKS_CLAUDE_BIN: claude, TYPESAFE_API_KEY: 'ts', OPENROUTER_API_KEY: 'or' };
    const keys: CredentialStore = {
      get: (key) => (values[key] ? { key, value: values[key], source: 'env' } : { key, source: 'none' }),
    };
    return createFindWiring({
      db,
      store: keys,
      config: loadConfig({}),
      articleFetcher: noFetch,
      browser: { list: async () => ({ ok: true, models: [] }) as never },
    });
  }

  it("uses the phase-1 provider when no fallback was ever chosen - not a hidden pi-ai filing provider", async () => {
    db.setState(
      'app_settings',
      JSON.stringify({ categorizer: 'typesafe', taxonomyProvider: 'claude-cli', assignmentProvider: 'pi-ai' }),
    );
    const model = await realWiring().describe();
    expect(model).toMatchObject({ available: true, spend: { providerId: 'claude-cli', billing: 'subscription' } });
  });

  it('names the Settings field to change when the chosen fallback cannot run', async () => {
    db.setState(
      'app_settings',
      JSON.stringify({ categorizer: 'typesafe', taxonomyProvider: 'claude-cli', fallbackProvider: 'pi-ai' }),
    );
    const model = await realWiring().describe();
    expect(model.available).toBe(false);
    expect(model.reason).toMatch(/^Jev's fallback language model cannot run: .*ANTHROPIC_API_KEY/);
    expect(model.reason).toContain('open Settings and change "Jev\'s fallback provider" under Phase 2 - Filing.');
  });
});
