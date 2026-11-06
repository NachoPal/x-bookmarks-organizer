import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from './server';
import { createRecategorizeWiring, type RecategorizeWiring } from './recategorize-job';
import type { SyncJob } from './sync';
import { createRefreshWiring } from './refresh-job';
import type { XClient } from '../x/client';
import { Database } from '../db/database';
import { loadConfig } from '../config';
import type { CredentialStore, ResolvedCredential } from '../creds/resolve';
import type { LlmFactory } from '../llm/factory';
import type { Billing } from '../llm/types';
import type { BatchCategorizer } from '../categorize/llm';
import type { TaxonomyDesigner } from '../categorize/taxonomy';
import type { RawBookmark, TaxonomyNode } from '../types';

/**
 * The in-app Recategorize, end to end through the routes: a proposal job that
 * changes no data, the draft editor's save/cancel, the paid-safety confirm,
 * the accept job (tree written, every post re-filed), and the job lock
 * against syncs, ranking runs and category edits. Offline: phase 1 and
 * phase 2 are fakes behind the wiring's own seams, or a fake LLM factory
 * behind the REAL designer.
 */

const WHEN = '2026-11-01T00:00:00.000Z';
const bm = (postId: string, text = `t-${postId}`): RawBookmark => ({
  postId,
  authorUsername: 'a',
  authorName: 'A',
  text,
  url: `https://x.com/a/status/${postId}`,
  postCreatedAt: '',
});
const node = (name: string, children: TaxonomyNode[] = []): TaxonomyNode => ({ name, children });
const noFetch = { fetch: async () => ({ status: 'failed' as const, reason: 'offline' }) };
const store: CredentialStore = {
  get(key: string): ResolvedCredential {
    return { key, source: 'none' };
  },
};

function fakeLlm(answer: (prompt: string) => string, billing: Billing = 'subscription'): LlmFactory {
  return {
    forRole: () => ({
      providerId: 'claude-cli',
      model: 'anthropic/claude-opus-5-5',
      billing,
      complete: async ({ prompt }) => ({ text: answer(prompt) }),
    }),
    check: async () => ({ state: 'ok', detail: 'ok' }),
    describe: () => ({ providerId: 'claude-cli', model: 'anthropic/claude-opus-5-5', billing }),
  };
}

/** Files every post whose text names a category (case-insensitive) under it; the rest fit nothing. */
const nameFiler = (names: string[][]): BatchCategorizer => ({
  async categorizeBatch(batch) {
    return batch.map((b) => ({
      postId: b.postId,
      categories: names.filter((path) => b.text.toLowerCase().includes(path[path.length - 1]!.toLowerCase())),
    }));
  },
});

type Status = { state: string; step: string | null; error: string | null; summary: Record<string, unknown> | null; messages: string[] };

async function waitFor(app: FastifyInstance): Promise<Status> {
  for (let i = 0; i < 200; i++) {
    const status = (await app.inject({ method: 'GET', url: '/api/recategorize' })).json().status as Status;
    if (status.state !== 'running') return status;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('recategorize never finished');
}

describe('recategorize API', () => {
  let db: Database;
  let app: FastifyInstance | undefined;
  let ai: number;
  let rust: number;
  let designed: TaxonomyNode[];
  let filer: BatchCategorizer;

  function wiring(over: Partial<Parameters<typeof createRecategorizeWiring>[0]> = {}): RecategorizeWiring {
    return createRecategorizeWiring({
      db,
      store,
      config: loadConfig({}),
      createLlm: () => fakeLlm(() => '{"tree":[]}'),
      buildTaxonomer: (): TaxonomyDesigner => ({ designTaxonomy: async () => designed }),
      buildFiler: () => filer,
      articleFetcher: noFetch,
      browser: { list: async () => ({ ok: true, models: [] }) as never },
      ...over,
    });
  }

  async function start(opts: Parameters<typeof buildServer>[1] = {}): Promise<FastifyInstance> {
    app = buildServer(db, { recategorize: wiring(), ...opts });
    await app.ready();
    return app;
  }

  function snapshot(): string {
    return JSON.stringify([db.getAllCategories(), [...db.getDirectMembership()], db.getAllBookmarks()]);
  }

  beforeEach(() => {
    db = new Database(':memory:');
    ai = db.getOrCreateCategory('AI', null, WHEN).id;
    rust = db.createCategory('Rust', null, WHEN)!.id;
    db.storeCategorizedBatch([bm('1', 'gpt evals'), bm('2', 'rust async'), bm('3', 'cooking pasta')], () => [ai], WHEN);
    designed = [node('Tech', [node('Rust'), node('Evals')]), node('Cooking')];
    filer = nameFiler([['Tech', 'Rust'], ['Tech', 'Evals'], ['Cooking']]);
  });
  afterEach(async () => {
    await app?.close();
    app = undefined;
    db.close();
  });

  it('serves the draft routes on a viewer without the wiring, and refuses the jobs', async () => {
    app = buildServer(db);
    await app.ready();
    const state = (await app.inject({ method: 'GET', url: '/api/recategorize' })).json();
    expect(state).toMatchObject({ available: false, draft: null, status: null, cost: null, bookmarkCount: 3 });
    const post = await app.inject({ method: 'POST', url: '/api/recategorize/proposal', payload: { mode: 'redesign', confirm: true } });
    expect(post.statusCode).toBe(503);
  });

  it('needs an explicit confirmation and a known mode before a proposal runs', async () => {
    await start();
    const bad = await app!.inject({ method: 'POST', url: '/api/recategorize/proposal', payload: { mode: 'nope', confirm: true } });
    expect(bad.statusCode).toBe(400);
    const unconfirmed = await app!.inject({ method: 'POST', url: '/api/recategorize/proposal', payload: { mode: 'redesign' } });
    expect(unconfirmed.statusCode).toBe(400);
    expect(unconfirmed.json().confirmRequired).toBe(true);
    expect((await app!.inject({ method: 'GET', url: '/api/recategorize' })).json().status.state).toBe('idle');
  });

  it('describes both passes, and Jev as per-token filing', async () => {
    app = buildServer(db, {
      recategorize: wiring({
        config: { ...loadConfig({}), categorizer: 'typesafe' },
        store: { get: (key) => (key === 'TYPESAFE_API_KEY' ? { key, value: 'k', source: 'env' } : { key, source: 'none' }) },
      }),
    });
    await app.ready();
    const cost = (await app.inject({ method: 'GET', url: '/api/recategorize' })).json().cost;
    expect(cost.taxonomy).toMatchObject({ available: true, spend: { billing: 'subscription' } });
    // The stored settings decide the method; with none stored the default (the LLM) files.
    expect(cost.filing.available).toBe(true);
  });

  it('names a saved model the installed catalog dropped, before any pass runs, and refuses the run', async () => {
    db.setState(
      'app_settings',
      JSON.stringify({
        categorizer: 'claude-cli',
        taxonomyProvider: 'pi-ai',
        taxonomyModel: 'openai/gpt-5.2-chat-latest',
        assignmentProvider: 'claude-cli',
      }),
    );
    // A catalog that has moved on: it lists the OpenAI models, minus the retired one.
    const browser = {
      list: async () => ({ ok: true, models: [{ id: 'openai/gpt-6.1-sol', label: 'GPT-6.1 Sol', suggestedFor: [] }] }),
    } as never;
    const recat = wiring({ browser });
    const cost = await recat.describe();
    expect(cost.taxonomy.available).toBe(false);
    expect(cost.taxonomy.reason).toBe(
      'The phase 1 (taxonomy) language model cannot run: the saved model "openai/gpt-5.2-chat-latest" is no ' +
        'longer in the OpenAI API model list - the installed model library dropped it. ' +
        'To use a different one, open Settings and change "Taxonomy provider" under Phase 1 - Taxonomy.',
    );
    await expect(recat.proposalJob('redesign')(() => {})).rejects.toThrow('no longer in the OpenAI API model list');
  });

  it('runs a proposal without changing data, then cancel leaves everything as it was', async () => {
    await start();
    const before = snapshot();
    const res = await app!.inject({ method: 'POST', url: '/api/recategorize/proposal', payload: { mode: 'redesign', confirm: true } });
    expect(res.statusCode).toBe(202);
    const status = await waitFor(app!);
    expect(status).toMatchObject({ state: 'done', step: 'proposal', summary: { kind: 'proposal', added: 3 } });
    expect(status.messages[0]).toMatch(/^Taxonomy pass: claude-cli/);
    expect(snapshot()).toBe(before);

    const state = (await app!.inject({ method: 'GET', url: '/api/recategorize' })).json();
    expect(state.draft.mode).toBe('redesign');
    expect(state.draft.diff).toMatchObject({ added: 3, removed: 1, renamed: 0, moved: 1, removedPaths: [['AI']] });
    expect(state.draft.tree[0].children[0]).toMatchObject({ name: 'Rust', sourceId: rust, origin: 'user', change: { movedFrom: ['Rust'] } });
    expect((await app!.inject({ method: 'GET', url: '/api/setup' })).json().recategorize).toMatchObject({ hasDraft: true });

    // A second proposal waits for this one to be decided.
    const again = await app!.inject({ method: 'POST', url: '/api/recategorize/proposal', payload: { mode: 'extend', confirm: true } });
    expect(again.statusCode).toBe(409);

    const cancel = await app!.inject({ method: 'DELETE', url: '/api/recategorize/draft' });
    expect(cancel.json()).toEqual({ cleared: true });
    expect(snapshot()).toBe(before);
    expect((await app!.inject({ method: 'GET', url: '/api/recategorize' })).json().draft).toBeNull();
  });

  it('saves edits to the draft, refusing invalid ones, and accepts the edited tree', async () => {
    await start();
    await app!.inject({ method: 'POST', url: '/api/recategorize/proposal', payload: { mode: 'redesign', confirm: true } });
    await waitFor(app!);
    const tree = (await app!.inject({ method: 'GET', url: '/api/recategorize' })).json().draft.tree;
    const [tech, cooking] = tree;

    const clash = await app!.inject({
      method: 'PUT',
      url: '/api/recategorize/draft',
      payload: { tree: [{ ...tech, name: 'Same' }, { ...cooking, name: 'same' }] },
    });
    expect(clash.statusCode).toBe(400);
    expect(clash.json().error).toMatch(/two top-level categories called “same”/);

    // Rename Cooking to Food (the owner's now), drop Evals, add Recipes inside Food.
    const edited = [
      { ...tech, children: [tech.children[0]] },
      { ...cooking, name: 'Food', edited: true, children: [{ id: 99, name: 'Pasta', edited: true, children: [] }] },
    ];
    const put = await app!.inject({ method: 'PUT', url: '/api/recategorize/draft', payload: { tree: edited } });
    expect(put.statusCode).toBe(200);
    expect(put.json().draft.diff).toMatchObject({ added: 3, removed: 1 });
    expect(put.json().draft.tree[1]).toMatchObject({ name: 'Food', origin: 'user' });

    const unconfirmed = await app!.inject({ method: 'POST', url: '/api/recategorize/accept', payload: {} });
    expect(unconfirmed.statusCode).toBe(400);
    filer = nameFiler([['Tech', 'Rust'], ['Food', 'Pasta']]);
    const accept = await app!.inject({ method: 'POST', url: '/api/recategorize/accept', payload: { confirm: true } });
    expect(accept.statusCode).toBe(202);
    const status = await waitFor(app!);
    expect(status).toMatchObject({ state: 'done', step: 'accept', summary: { kind: 'apply', refiled: 3, total: 3 } });

    const live = (await app!.inject({ method: 'GET', url: '/api/tree' })).json().tree;
    const names = (ns: { name: string; children: unknown[] }[]): unknown[] =>
      ns.map((n) => (n.children.length ? [n.name, names(n.children as never)] : n.name));
    expect(names(live)).toEqual([['Tech', ['Rust']], ['Food', ['Pasta']], 'Uncategorized']);
    expect(db.getCategoryById(rust)).toMatchObject({ parentId: live[0].id, origin: 'user' });
    expect(db.getCategoryById(ai)).toBeUndefined();
    const filed = db.getCategoryIdsForBookmarks(db.getAllBookmarks().map((b) => b.id));
    expect(filed.get(db.getBookmarkByPostId('2')!.id)).toEqual([rust]);
    expect(filed.get(db.getBookmarkByPostId('3')!.id)).toEqual([live[1].children[0].id]);
    expect((await app!.inject({ method: 'GET', url: '/api/recategorize' })).json()).toMatchObject({ draft: null, pendingRefile: null });
  });

  it('keeps the current tree exactly for an extend, editing only the additions', async () => {
    designed = [node('AI', [node('Evals')]), node('Cooking')];
    await start();
    await app!.inject({ method: 'POST', url: '/api/recategorize/proposal', payload: { mode: 'extend', confirm: true } });
    await waitFor(app!);
    const draft = (await app!.inject({ method: 'GET', url: '/api/recategorize' })).json().draft;
    expect(draft.diff).toMatchObject({ added: 2, removed: 0, renamed: 0, moved: 0 });
    expect(draft.tree.map((n: { name: string; locked: boolean }) => [n.name, n.locked])).toEqual([
      ['AI', true],
      ['Rust', true],
      ['Cooking', false],
    ]);
    // A client that tries to rename AI and drop Rust gets them back untouched.
    const tampered = [{ ...draft.tree[0], name: 'Renamed' }, { ...draft.tree[2], name: 'Food', edited: true }];
    const put = (await app!.inject({ method: 'PUT', url: '/api/recategorize/draft', payload: { tree: tampered } })).json();
    expect(put.draft.tree.map((n: { name: string }) => n.name)).toEqual(['AI', 'Rust', 'Food']);

    const before = db.getAllCategories();
    filer = nameFiler([['AI', 'Evals'], ['Rust']]);
    await app!.inject({ method: 'POST', url: '/api/recategorize/accept', payload: { confirm: true } });
    expect(await waitFor(app!)).toMatchObject({ state: 'done', summary: { mode: 'extend', refiled: 3 } });
    const after = db.getAllCategories();
    for (const c of before) expect(after.find((a) => a.id === c.id)).toEqual(c);
    expect(after.map((c) => c.name).sort()).toEqual(['AI', 'Evals', 'Food', 'Rust', 'Uncategorized']);
    expect(after.find((c) => c.name === 'Food')!.origin).toBe('user');
    expect(after.find((c) => c.name === 'Evals')!.origin).toBe('generated');
  });

  it('a failed re-file reports progress, keeps the new tree, and Try again finishes it', async () => {
    db.storeCategorizedBatch([bm('4', 'rust traits'), bm('5', 'pasta')], () => [ai], WHEN);
    await start();
    await app!.inject({ method: 'POST', url: '/api/recategorize/proposal', payload: { mode: 'redesign', confirm: true } });
    await waitFor(app!);
    let calls = 0;
    const good = filer;
    filer = {
      async categorizeBatch(batch, tree, ctx) {
        calls += 1;
        if (calls === 2) throw new Error('Rate limited.');
        return good.categorizeBatch(batch, tree, ctx);
      },
    };
    // Batches of 3 (an override, through the stored config) are simpler to count with 5 posts.
    await app!.close();
    app = buildServer(db, { recategorize: wiring({ config: { ...loadConfig({}), batchSize: 3 } }) });
    await app.ready();
    await app.inject({ method: 'POST', url: '/api/recategorize/accept', payload: { confirm: true } });
    const failed = await waitFor(app);
    expect(failed.state).toBe('error');
    expect(failed.error).toMatch(/^Re-filed 3 of 5 posts, then the filing pass failed: Rate limited\. .*remaining 2\.$/);
    const state = (await app.inject({ method: 'GET', url: '/api/recategorize' })).json();
    expect(state.pendingRefile).toEqual({ mode: 'redesign', total: 5, remaining: 2 });
    expect(db.findCategory('Tech', null)).toBeDefined();

    // A new proposal waits until the re-file is finished.
    const blocked = await app.inject({ method: 'POST', url: '/api/recategorize/proposal', payload: { mode: 'extend', confirm: true } });
    expect(blocked.statusCode).toBe(409);
    const retry = await app.inject({ method: 'POST', url: '/api/recategorize/refile', payload: { confirm: true } });
    expect(retry.statusCode).toBe(202);
    expect(await waitFor(app)).toMatchObject({ state: 'done', step: 'refile', summary: { refiled: 2, total: 5 } });
    expect((await app.inject({ method: 'GET', url: '/api/recategorize' })).json().pendingRefile).toBeNull();
  });

  it('blocks syncs, ranking, finds and category edits while it runs, and refuses to start during a sync', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let syncRelease!: () => void;
    const syncGate = new Promise<void>((r) => (syncRelease = r));
    const syncJob: SyncJob = async () => {
      await syncGate;
      return { newBookmarks: 0, batches: 0, nodesCreated: 0 };
    };
    app = buildServer(db, {
      syncJob,
      recategorize: wiring({
        buildTaxonomer: () => ({
          designTaxonomy: async () => {
            await gate;
            return designed;
          },
        }),
      }),
    });
    await app.ready();
    await app.inject({ method: 'POST', url: '/api/recategorize/proposal', payload: { mode: 'redesign', confirm: true } });
    expect((await app.inject({ method: 'POST', url: '/api/sync' })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/api/categories', payload: { name: 'X' } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/api/reset', payload: { confirm: true } })).statusCode).toBe(409);
    expect(
      (await app.inject({ method: 'PUT', url: `/api/bookmarks/${db.getBookmarkByPostId('1')!.id}/category`, payload: { categoryId: rust } }))
        .statusCode,
    ).toBe(409);
    expect((await app.inject({ method: 'DELETE', url: '/api/recategorize/draft' })).statusCode).toBe(409);
    release();
    await waitFor(app);
    await app.inject({ method: 'DELETE', url: '/api/recategorize/draft' });

    // And the other way round: a running sync holds a recategorize back.
    expect((await app.inject({ method: 'POST', url: '/api/sync' })).statusCode).toBe(202);
    const during = await app.inject({ method: 'POST', url: '/api/recategorize/proposal', payload: { mode: 'redesign', confirm: true } });
    expect(during.statusCode).toBe(409);
    expect(during.json().error).toMatch(/A sync is running/);
    syncRelease();
  });

  it('never runs beside a refresh from X, in either order', async () => {
    let unblock: (() => void) | undefined;
    const slowX: XClient = {
      fetchBookmarksPage: () =>
        new Promise((resolve) => {
          unblock = () => resolve({ bookmarks: [] });
        }),
    };
    db.setRefreshToken('stored-refresh-token');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    app = buildServer(db, {
      refresh: createRefreshWiring({
        db,
        config: loadConfig({ XBOOKMARKS_CLIENT_ID: 'id', XBOOKMARKS_CLIENT_SECRET: 'secret' }),
        connect: async () => slowX,
      }),
      recategorize: wiring({
        buildTaxonomer: () => ({
          designTaxonomy: async () => {
            await gate;
            return designed;
          },
        }),
      }),
    });
    await app.ready();
    const refresh = () => app!.inject({ method: 'POST', url: '/api/refresh', payload: { scope: 'newest', confirm: true } });
    const propose = () =>
      app!.inject({ method: 'POST', url: '/api/recategorize/proposal', payload: { mode: 'redesign', confirm: true } });

    expect((await refresh()).statusCode).toBe(202);
    for (let i = 0; i < 200 && !unblock; i++) await new Promise((r) => setTimeout(r, 5));
    const during = await propose();
    expect(during.statusCode).toBe(409);
    expect(during.json().error).toMatch(/refreshed from X/);
    unblock!();
    for (let i = 0; i < 200; i++) {
      if ((await app.inject({ method: 'GET', url: '/api/refresh' })).json().refresh.status.state !== 'running') break;
      await new Promise((r) => setTimeout(r, 5));
    }

    expect((await propose()).statusCode).toBe(202);
    const blocked = await refresh();
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toMatch(/being recategorized/);
    release();
    await waitFor(app);
  });

  it('builds both proposals on the REAL designer and prompts, over every stored post', async () => {
    const prompts: string[] = [];
    app = buildServer(db, {
      recategorize: wiring({
        buildTaxonomer: undefined,
        createLlm: () =>
          fakeLlm((prompt) => {
            prompts.push(prompt);
            return JSON.stringify({ tree: [{ name: 'Tech', description: 'Software.', children: [] }] });
          }),
      }),
    });
    await app.ready();
    await app.inject({ method: 'POST', url: '/api/recategorize/proposal', payload: { mode: 'redesign', confirm: true } });
    expect(await waitFor(app)).toMatchObject({ state: 'done' });
    expect(prompts[0]).toContain('designing a complete REPLACEMENT');
    expect(prompts[0]).toContain('- Rust [owner]');
    for (const text of ['gpt evals', 'rust async', 'cooking pasta']) expect(prompts[0]).toContain(text);
    await app.inject({ method: 'DELETE', url: '/api/recategorize/draft' });

    await app.inject({ method: 'POST', url: '/api/recategorize/proposal', payload: { mode: 'extend', confirm: true } });
    expect(await waitFor(app)).toMatchObject({ state: 'done' });
    expect(prompts[1]).toContain('add ONLY the categories');
    for (const text of ['gpt evals', 'rust async', 'cooking pasta']) expect(prompts[1]).toContain(text);
  });
});
