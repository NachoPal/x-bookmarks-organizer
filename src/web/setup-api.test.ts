import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer, SYNC_UNAVAILABLE_MESSAGE, X_LOGIN_UNAVAILABLE_MESSAGE } from './server';
import { Database } from '../db/database';
import { buildSettingsCatalog } from '../settings/catalog';
import { readSettings } from '../settings/settings';
import type { CredentialStore, ResolvedCredential } from '../creds/resolve';
import type { IngestSummary } from '../ingest';
import type { SyncJob } from './sync';
import type { RawBookmark } from '../types';

const catalog = buildSettingsCatalog();

const bm = (postId: string): RawBookmark => ({
  postId,
  authorUsername: 'a',
  authorName: 'A',
  text: `t-${postId}`,
  url: `https://x.com/a/status/${postId}`,
  postCreatedAt: '',
});

function fakeStore(values: Record<string, string>): CredentialStore {
  return {
    get(key: string): ResolvedCredential {
      const value = values[key];
      return value ? { key, value, source: 'keychain' } : { key, source: 'none' };
    },
  };
}

/** Let a started background job settle without waiting on wall-clock time. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

const summary: IngestSummary = { newBookmarks: 4, batches: 1, nodesCreated: 3 };

describe('GET /api/setup', () => {
  let db: Database;
  let app: FastifyInstance;

  beforeEach(() => {
    db = new Database(':memory:');
  });
  afterEach(async () => {
    await app?.close();
    db.close();
  });

  it('gates the first-run flow on an EMPTY library, not on a missing settings row', async () => {
    app = buildServer(db);
    await app.ready();

    const before = (await app.inject({ method: 'GET', url: '/api/setup' })).json();
    expect(before.bookmarkCount).toBe(0);
    expect(before.configured).toBe(false);

    db.storeCategorizedBatch([bm('1')], () => [db.getOrCreateCategory('AI', null, 'now').id]);
    const after = (await app.inject({ method: 'GET', url: '/api/setup' })).json();
    expect(after.bookmarkCount).toBe(1);
  });

  it('ships the catalog the dropdowns are built from, including efforts per provider', async () => {
    app = buildServer(db);
    await app.ready();
    const body = (await app.inject({ method: 'GET', url: '/api/setup' })).json();
    expect(body.catalog.methods.map((m: { id: string }) => m.id)).toEqual(['claude-cli', 'typesafe']);
    const claude = body.catalog.providers.find((p: { id: string }) => p.id === 'claude-cli');
    expect(claude.models.length).toBeGreaterThan(0);
    expect(claude.efforts).toContain('high');
  });

  it("reports each credential's presence and source, never its value", async () => {
    app = buildServer(db, {
      credentials: fakeStore({ XBOOKMARKS_CLIENT_ID: 'super-secret-id' }),
    });
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/api/setup' });
    expect(res.json().credentials).toEqual({
      xClientId: { present: true, source: 'keychain' },
      xClientSecret: { present: false },
      typesafeApiKey: { present: false },
    });
    expect(res.body).not.toContain('super-secret-id');
  });

  it('reports whether X has been authorized, and whether the app can do it in-app', async () => {
    app = buildServer(db, { xLogin: async () => {} });
    await app.ready();
    expect((await app.inject({ method: 'GET', url: '/api/setup' })).json().x).toEqual({
      connected: false,
      canConnect: true,
      login: { state: 'idle', error: null },
    });

    db.setRefreshToken('token');
    expect((await app.inject({ method: 'GET', url: '/api/setup' })).json().x.connected).toBe(true);
  });

  it('reports sync as unavailable, with a reason, on a viewer built without the ingest wiring', async () => {
    app = buildServer(db);
    await app.ready();
    const body = (await app.inject({ method: 'GET', url: '/api/setup' })).json();
    expect(body.sync).toMatchObject({ available: false, reason: SYNC_UNAVAILABLE_MESSAGE, status: null });
  });
});

describe('PUT /api/settings', () => {
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

  it('saves a valid selection and serves it back on the next /api/setup', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: {
        categorizer: 'claude-cli',
        provider: 'claude-cli',
        taxonomyModel: 'claude-opus-4-8',
        effort: 'xhigh',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().settings).toMatchObject({
      categorizer: 'claude-cli',
      taxonomyModel: 'claude-opus-4-8',
      effort: 'xhigh',
    });

    // Durable: it is in the database, not in the request's memory.
    expect(readSettings(db, catalog)).toMatchObject({ effort: 'xhigh' });
    const setup = (await app.inject({ method: 'GET', url: '/api/setup' })).json();
    expect(setup.settings.effort).toBe('xhigh');
    expect(setup.configured).toBe(true);
  });

  it('rejects an unknown model or effort with the list of what IS available', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { provider: 'claude-cli', assignmentModel: 'gpt-9', effort: 'ludicrous' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().errors).toHaveLength(2);
    expect(res.json().error).toContain('claude-haiku-4-5');
    // Nothing was written.
    expect(readSettings(db, catalog)).toBeUndefined();
  });

  it('keeps the original setup timestamp when the choice is edited later', async () => {
    const first = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { categorizer: 'claude-cli', provider: 'claude-cli' },
    });
    const configuredAt = first.json().settings.configuredAt;
    expect(configuredAt).toBeTruthy();

    const second = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { categorizer: 'typesafe', provider: 'claude-cli' },
    });
    expect(second.json().settings).toMatchObject({ categorizer: 'typesafe', configuredAt });
  });
});

describe('POST /api/sync and GET /api/sync', () => {
  let db: Database;
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
    db.close();
  });

  /** Build a viewer whose sync job is `job`. */
  const serve = async (job?: SyncJob) => {
    db = new Database(':memory:');
    app = buildServer(db, job ? { syncJob: job } : {});
    await app.ready();
  };

  it('starts the job and returns at once (202), without waiting for it', async () => {
    let release = () => {};
    let started = false;
    await serve(
      (log) =>
        new Promise((resolve) => {
          started = true;
          log('Found 4 new bookmark(s).');
          release = () => resolve(summary);
        }),
    );

    const res = await app.inject({ method: 'POST', url: '/api/sync' });
    expect(res.statusCode).toBe(202);
    expect(res.json().status.state).toBe('running');
    expect(started).toBe(true);

    release();
    await settle();
    const done = (await app.inject({ method: 'GET', url: '/api/sync' })).json();
    expect(done.status).toMatchObject({
      state: 'done',
      summary,
      messages: ['Found 4 new bookmark(s).'],
    });
  });

  it('reports progress as the job logs it, so the client can poll a long run', async () => {
    let step = (_m: string) => {};
    let release = () => {};
    await serve(
      (log) =>
        new Promise((resolve) => {
          step = log;
          release = () => resolve(summary);
        }),
    );
    await app.inject({ method: 'POST', url: '/api/sync' });

    step('Designing taxonomy (pass 1)...');
    let body = (await app.inject({ method: 'GET', url: '/api/sync' })).json();
    expect(body.status).toMatchObject({ state: 'running', messages: ['Designing taxonomy (pass 1)...'] });

    step('Stored batch 1/1 (4 bookmark(s)).');
    body = (await app.inject({ method: 'GET', url: '/api/sync' })).json();
    expect(body.status.messages).toHaveLength(2);

    release();
    await settle();
  });

  it('refuses a concurrent start with 409 and the running job progress', async () => {
    let release = () => {};
    await serve(() => new Promise((resolve) => (release = () => resolve(summary))));

    await app.inject({ method: 'POST', url: '/api/sync' });
    const second = await app.inject({ method: 'POST', url: '/api/sync' });
    expect(second.statusCode).toBe(409);
    expect(second.json().status.state).toBe('running');

    release();
    await settle();
  });

  it("surfaces a failed sync as the job's actionable message, not a crash", async () => {
    await serve(async () => {
      throw new Error('Missing credential: XBOOKMARKS_CLIENT_SECRET. Set it in your .env.');
    });
    const res = await app.inject({ method: 'POST', url: '/api/sync' });
    expect(res.statusCode).toBe(202);

    await settle();
    const body = (await app.inject({ method: 'GET', url: '/api/sync' })).json();
    expect(body.status.state).toBe('error');
    expect(body.status.error).toContain('XBOOKMARKS_CLIENT_SECRET');
  });

  it("reports the fresh lastSyncedAt alongside progress, so the header's indicator can follow", async () => {
    await serve(async () => {
      db.setLastSyncedAt('2026-03-04T05:06:07.000Z');
      return summary;
    });
    await app.inject({ method: 'POST', url: '/api/sync' });
    await settle();
    const body = (await app.inject({ method: 'GET', url: '/api/sync' })).json();
    expect(body.lastSyncedAt).toBe('2026-03-04T05:06:07.000Z');
  });

  it('degrades with 503 and a clear reason when the viewer has no ingest wiring', async () => {
    await serve();
    const res = await app.inject({ method: 'POST', url: '/api/sync' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe(SYNC_UNAVAILABLE_MESSAGE);
  });
});

describe('POST /api/x-login', () => {
  let db: Database;
  let app: FastifyInstance;

  beforeEach(() => {
    db = new Database(':memory:');
  });
  afterEach(async () => {
    await app.close();
    db.close();
  });

  it('starts the consent flow in the background and reports it through /api/setup', async () => {
    let release = () => {};
    app = buildServer(db, { xLogin: () => new Promise<void>((resolve) => (release = resolve)) });
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/x-login' });
    expect(res.statusCode).toBe(202);
    expect((await app.inject({ method: 'GET', url: '/api/setup' })).json().x.login.state).toBe('running');

    release();
    await settle();
    expect((await app.inject({ method: 'GET', url: '/api/setup' })).json().x.login.state).toBe('done');
  });

  it('reports a failed authorization with its own message', async () => {
    app = buildServer(db, {
      xLogin: async () => {
        throw new Error('OAuth state mismatch - possible CSRF, aborting.');
      },
    });
    await app.ready();
    await app.inject({ method: 'POST', url: '/api/x-login' });
    await settle();

    const login = (await app.inject({ method: 'GET', url: '/api/setup' })).json().x.login;
    expect(login).toEqual({ state: 'error', error: 'OAuth state mismatch - possible CSRF, aborting.' });
  });

  it('degrades with 503 when the viewer cannot run the consent flow', async () => {
    app = buildServer(db);
    await app.ready();
    const res = await app.inject({ method: 'POST', url: '/api/x-login' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe(X_LOGIN_UNAVAILABLE_MESSAGE);
  });
});
