import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer, REFRESH_UNAVAILABLE_MESSAGE } from './server';
import { createRefreshWiring } from './refresh-job';
import { Database } from '../db/database';
import { loadConfig } from '../config';
import { mapBookmarks } from '../x/article';
import { mediaFixturePage } from '../x/media.fixtures';
import type { XClient } from '../x/client';
import { ImageTextWorker } from '../images/worker';
import type { TextRecognizer } from '../images/recognizer';
import type { SyncJob } from './sync';
import type { RawBookmark } from '../types';

/**
 * The HTTP surface of "Refresh from X", offline: X is a fake serving the
 * documented-shape fixture, images come from a stub fetcher, OCR is a stub
 * recognizer. Pinned here: a paid refresh starts only with `{ confirm: true }`
 * and a valid scope, never while a sync runs (and a sync never while it runs),
 * and the finished run has refreshed in place and read the images' text.
 */

const X_CREDS = { XBOOKMARKS_CLIENT_ID: 'id', XBOOKMARKS_CLIENT_SECRET: 'secret' };
const WHEN = '2026-09-01T00:00:00.000Z';

const stale = (postId: string): RawBookmark => ({
  postId,
  authorUsername: 'alice',
  authorName: 'Alice',
  text: `stale ${postId}`,
  url: `https://x.com/alice/status/${postId}`,
  postCreatedAt: '',
});

const waitFor = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
};

describe('POST /api/refresh and GET /api/refresh', () => {
  let db: Database;
  let app: FastifyInstance;
  let reads: number;
  let images: ImageTextWorker;

  const fakeX: XClient = {
    async fetchBookmarksPage() {
      reads++;
      const page = mediaFixturePage();
      return { bookmarks: mapBookmarks(page.data, page.includes, () => {}, { own: true, quoted: true }) };
    },
  };
  const recognizer: TextRecognizer = {
    id: 'stub',
    label: 'Stub',
    async recognize(paths) {
      return paths.map(() => ({ ok: true as const, text: 'Quarterly zephyrine report' }));
    },
  };

  beforeEach(() => {
    db = new Database(':memory:');
    db.storeCategorizedBatch(['1900000000000000001', '1900000000000000002'].map(stale), () => [], WHEN);
    db.setRefreshToken('stored-refresh-token');
    reads = 0;
    images = new ImageTextWorker({
      db,
      detect: async () => recognizer,
      fetcher: { fetch: async () => ({ ok: true, bytes: Buffer.from('png'), contentType: 'image/png' }) },
    });
  });
  afterEach(async () => {
    await images.idle();
    await app.close();
    db.close();
  });

  const build = (syncJob?: SyncJob) => {
    app = buildServer(db, {
      refresh: createRefreshWiring({ db, config: loadConfig({ ...X_CREDS }), images, connect: async () => fakeX }),
      images,
      syncJob,
    });
    return app;
  };

  it('is unavailable (503) on a viewer built without the wiring, and says so in /api/setup', async () => {
    app = buildServer(db);
    const res = await app.inject({ method: 'POST', url: '/api/refresh', payload: { scope: 'all', confirm: true } });
    expect(res.statusCode).toBe(503);
    const setup = (await app.inject({ method: 'GET', url: '/api/setup' })).json();
    expect(setup.refresh).toMatchObject({ available: false, reason: REFRESH_UNAVAILABLE_MESSAGE, estimates: null });
    expect(setup.refresh.images).toMatchObject({ total: 0, worker: null });
  });

  it('demands a scope and an explicit confirmation, answering the estimate - and reads nothing from X', async () => {
    build();
    const noScope = await app.inject({ method: 'POST', url: '/api/refresh', payload: { confirm: true } });
    expect(noScope.statusCode).toBe(400);
    const unconfirmed = await app.inject({ method: 'POST', url: '/api/refresh', payload: { scope: 'newest' } });
    expect(unconfirmed.statusCode).toBe(400);
    expect(unconfirmed.json()).toMatchObject({ confirmRequired: true, estimate: { scope: 'newest', posts: 2 } });
    expect(reads).toBe(0);
  });

  it('refuses before the confirmation when X is not connected', async () => {
    build();
    db.setState('x_refresh_token', '');
    const res = await app.inject({ method: 'POST', url: '/api/refresh', payload: { scope: 'all' } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatch(/Not connected to X/);
  });

  it('refreshes in place, then reads the images in the background', async () => {
    build();
    const res = await app.inject({ method: 'POST', url: '/api/refresh', payload: { scope: 'all', confirm: true } });
    expect(res.statusCode).toBe(202);
    await waitFor(() => db.getImageStats(3).done === 3);
    await images.idle();

    const { refresh } = (await app.inject({ method: 'GET', url: '/api/refresh' })).json();
    expect(refresh.status.state).toBe('done');
    expect(refresh.status.summary).toMatchObject({ refreshed: 2, notStored: 2, imagesFound: 3 });
    expect(refresh.status.messages[0]).toMatch(/^Billing: X API owned reads, \$0\.001 per post/);
    expect(refresh.images).toMatchObject({ photos: 3, done: 3, withText: 3, worker: { state: 'done', recognizer: { id: 'stub' } } });
    // Two of the fixture's posts are not stored: the refresh never adds them.
    expect(db.getBookmarkCount()).toBe(2);

    const id = db.getBookmarkByPostId('1900000000000000002')!.id;
    const shown = (await app.inject({ method: 'GET', url: `/api/bookmarks/${id}/images` })).json();
    expect(shown.images).toEqual([
      { source: 'quoted-post', type: 'photo', altText: null, text: 'Quarterly zephyrine report', status: 'done' },
    ]);
    expect(db.searchBookmarks({ query: 'zephyrine', limit: 10 }).hits).toHaveLength(2);
  });

  it('never races a sync, in either order', async () => {
    let release!: () => void;
    const syncJob: SyncJob = () =>
      new Promise((resolve) => {
        release = () => resolve({ newBookmarks: 0, batches: 0, nodesCreated: 0 });
      });
    build(syncJob);
    expect((await app.inject({ method: 'POST', url: '/api/sync' })).statusCode).toBe(202);
    const during = await app.inject({ method: 'POST', url: '/api/refresh', payload: { scope: 'all', confirm: true } });
    expect(during.statusCode).toBe(409);
    release();
    for (let i = 0; i < 100; i++) {
      const { status } = (await app.inject({ method: 'GET', url: '/api/sync' })).json();
      if (status.state === 'done') break;
    }

    let unblock!: () => void;
    const slowX: XClient = {
      fetchBookmarksPage: () =>
        new Promise((resolve) => {
          unblock = () => resolve({ bookmarks: [] });
        }),
    };
    await app.close();
    app = buildServer(db, {
      refresh: createRefreshWiring({ db, config: loadConfig({ ...X_CREDS }), connect: async () => slowX }),
      syncJob,
    });
    expect(
      (await app.inject({ method: 'POST', url: '/api/refresh', payload: { scope: 'newest', confirm: true } })).statusCode,
    ).toBe(202);
    await waitFor(() => !!unblock);
    expect((await app.inject({ method: 'POST', url: '/api/sync' })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/api/reset', payload: { confirm: true } })).statusCode).toBe(409);
    unblock();
  });

  it('carries both estimates on /api/setup for the Sync panel', async () => {
    build();
    const { refresh } = (await app.inject({ method: 'GET', url: '/api/setup' })).json();
    expect(refresh.available).toBe(true);
    expect(refresh.estimates.newest).toMatchObject({ posts: 2, cost: { low: 0.002 } });
    expect(refresh.estimates.all).toMatchObject({ posts: 2, maxPostsRead: 2 });
  });
});
