import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  buildServer,
  RANK_CONFIRM_MESSAGE,
  RANK_ONE_CONFIRM_MESSAGE,
  RANK_UNAVAILABLE_MESSAGE,
} from './server';
import { Database } from '../db/database';
import type { RankSummary } from '../rank/ranker';
import type { RankWiring } from './rank-job';
import type { SyncJob } from './sync';
import type { RawBookmark } from '../types';

/**
 * The HTTP surface of the in-app ranking run (issue #80), offline end to end:
 * the wiring is faked, so nothing here can reach `api.typesafe.ai` and nothing
 * can be billed. What is NOT faked is the route's own paid-safety logic, which
 * is the entire subject of the first block below.
 *
 * The rule these tests pin down: between a browser and a bill there are three
 * independent gates - the explicit confirmation, the opt-in/key blocker, and
 * the single-run guard - and none of them may be skippable by a direct POST
 * that never went near the app's UI.
 */

const bm = (postId: string): RawBookmark => ({
  postId,
  authorUsername: 'a',
  authorName: 'A',
  text: `t-${postId}`,
  url: `https://x.com/a/status/${postId}`,
  postCreatedAt: '',
});

/** Let a started background job settle without waiting on wall-clock time. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

const summary: RankSummary = { candidates: 2, scored: 2, skipped: 0, failed: 0, inputTokens: 900 };

describe('POST /api/rank and GET /api/rank', () => {
  let db: Database;
  let app: FastifyInstance;
  /** Every scoring attempt the fake wiring was asked to make. */
  let runs: number;

  beforeEach(() => {
    db = new Database(':memory:');
    db.storeCategorizedBatch([bm('1'), bm('2')], () => []);
    runs = 0;
  });
  afterEach(async () => {
    await app.close();
    db.close();
  });

  /**
   * Build a viewer with the ranking wiring faked. `blocker` stands in for the
   * server-side opt-in + key gate; `job` for the pass itself.
   */
  const serve = async (
    opts: {
      wiring?: Partial<RankWiring> | null;
      syncJob?: SyncJob;
    } = {},
  ) => {
    const ranking: RankWiring | undefined =
      opts.wiring === null
        ? undefined
        : {
            job: async () => {
              runs++;
              return summary;
            },
            rankOne: async () => {
              runs++;
              return summary;
            },
            blocker: () => null,
            pending: () => 2,
            ...opts.wiring,
          };
    app = buildServer(db, {
      ...(ranking ? { ranking } : {}),
      ...(opts.syncJob ? { syncJob: opts.syncJob } : {}),
    });
    await app.ready();
  };

  const post = (body?: unknown) =>
    app.inject({ method: 'POST', url: '/api/rank', ...(body === undefined ? {} : { payload: body }) });

  describe('paid-safety gates', () => {
    it('refuses a start that carries no explicit confirmation', async () => {
      // A paid run must be an AUTHORIZATION, never a stray POST: the dialog's
      // "yes" is what `confirm: true` encodes, and the route will not run
      // without it - so the confirmation cannot be routed around.
      await serve();
      const res = await post({});
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe(RANK_CONFIRM_MESSAGE);
      expect(runs).toBe(0);
    });

    it('refuses a confirmation that is anything other than exactly true', async () => {
      await serve();
      for (const confirm of ['true', 1, 'yes', {}, null]) {
        const res = await post({ confirm });
        expect(res.statusCode).toBe(400);
      }
      expect(runs).toBe(0);
    });

    it('refuses an empty body, not just a wrong one', async () => {
      await serve();
      const res = await post();
      expect(res.statusCode).toBe(400);
      expect(runs).toBe(0);
    });

    it('refuses with 403 and the gate’s own words when ranking is off', async () => {
      await serve({ wiring: { blocker: () => 'Ranking is off. It is PAID per token, so it never runs...' } });
      const res = await post({ confirm: true });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toMatch(/Ranking is off/);
      expect(runs).toBe(0);
    });

    it('refuses with 403 when ranking is on but the key does not resolve', async () => {
      await serve({
        wiring: { blocker: () => 'Missing credential: TYPESAFE_API_KEY. Set it in your .env.' },
      });
      const res = await post({ confirm: true });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toMatch(/TYPESAFE_API_KEY/);
      expect(runs).toBe(0);
    });

    it('re-checks the blocker on the server, so a stale UI cannot spend money', async () => {
      // The browser's copy of "you may rank" can be seconds old. The route
      // asks again at the moment of the authorization, not before it.
      let off = false;
      await serve({ wiring: { blocker: () => (off ? 'Ranking is off.' : null) } });

      off = true;
      const res = await post({ confirm: true });
      expect(res.statusCode).toBe(403);
      expect(runs).toBe(0);
    });
  });

  describe('running one', () => {
    it('starts the pass and returns at once (202), without waiting for it', async () => {
      let release = () => {};
      let started = false;
      await serve({
        wiring: {
          job: () =>
            new Promise<RankSummary>((resolve) => {
              started = true;
              release = () => resolve(summary);
            }),
        },
      });

      const res = await post({ confirm: true });
      expect(res.statusCode).toBe(202);
      expect(res.json().status.state).toBe('running');
      expect(started).toBe(true);

      release();
      await settle();
      const done = (await app.inject({ method: 'GET', url: '/api/rank' })).json();
      expect(done.ranking.status).toMatchObject({ state: 'done', summary });
    });

    it('reports the pass’s own logger lines as progress, so a long run can be polled', async () => {
      let step = (_m: string) => {};
      let release = () => {};
      await serve({
        wiring: {
          job: (log) =>
            new Promise<RankSummary>((resolve) => {
              step = log;
              release = () => resolve(summary);
            }),
        },
      });
      await post({ confirm: true });

      // The billing line is the ranker's own first message - it reaches the
      // owner through the same stream as everything else the run says.
      step('Ranking pass: TypeSafe Jev - pay-per-token.');
      let body = (await app.inject({ method: 'GET', url: '/api/rank' })).json();
      expect(body.ranking.status).toMatchObject({
        state: 'running',
        messages: ['Ranking pass: TypeSafe Jev - pay-per-token.'],
      });

      step('Ranking 2 bookmark(s) against rubric v1.');
      body = (await app.inject({ method: 'GET', url: '/api/rank' })).json();
      expect(body.ranking.status.messages).toHaveLength(2);

      release();
      await settle();
    });

    it('marks the new scores, so sorting by score reflects them immediately after', async () => {
      // The run stores through the real Database, and GET /api/rank re-reads
      // the counts - which is what lets the Order control update with no reload.
      await serve({
        wiring: {
          job: async () => {
            for (const post of ['1', '2']) {
              db.saveBookmarkScore({
                bookmarkId: db.getBookmarkByPostId(post)!.id,
                score: 0.8,
                confidence: 0.9,
                dimensions: { depth: 2 },
                model: 'jev-test',
                rubricVersion: 'v1',
                scoredAt: '2026-01-01T00:00:00.000Z',
              });
            }
            return summary;
          },
        },
      });

      const before = (await app.inject({ method: 'GET', url: '/api/rank' })).json();
      expect(before.ranking.scored).toBe(0);

      await post({ confirm: true });
      await settle();

      const after = (await app.inject({ method: 'GET', url: '/api/rank' })).json();
      expect(after.ranking).toMatchObject({ scored: 2, total: 2 });
      expect(after.ranking.status.state).toBe('done');
    });

    it('surfaces a failed run as the pass’s actionable message, not a crash', async () => {
      await serve({
        wiring: {
          job: async () => {
            throw new Error('TypeSafe request failed: 401 unauthorized.');
          },
        },
      });
      const res = await post({ confirm: true });
      expect(res.statusCode).toBe(202);

      await settle();
      const body = (await app.inject({ method: 'GET', url: '/api/rank' })).json();
      expect(body.ranking.status.state).toBe('error');
      expect(body.ranking.status.error).toContain('401');
    });
  });

  describe('one run at a time', () => {
    it('refuses a concurrent start with 409 - two runs would pay twice', async () => {
      let release = () => {};
      await serve({
        wiring: { job: () => new Promise<RankSummary>((resolve) => (release = () => resolve(summary))) },
      });

      await post({ confirm: true });
      const second = await post({ confirm: true });
      expect(second.statusCode).toBe(409);
      expect(second.json().status.state).toBe('running');

      release();
      await settle();
    });

    it('refuses to rank while a sync is running, and to sync while a run is', async () => {
      // An ingest is writing the very bookmarks a run selects; paying to score
      // a half-written library helps nobody, so the two exclude each other.
      let releaseSync = () => {};
      let releaseRank = () => {};
      await serve({
        wiring: { job: () => new Promise<RankSummary>((resolve) => (releaseRank = () => resolve(summary))) },
        syncJob: () =>
          new Promise((resolve) => {
            releaseSync = () => resolve({ newBookmarks: 0, batches: 0, nodesCreated: 0 });
          }),
      });

      await app.inject({ method: 'POST', url: '/api/sync' });
      const blockedRank = await post({ confirm: true });
      expect(blockedRank.statusCode).toBe(409);
      expect(blockedRank.json().error).toMatch(/sync is running/i);
      expect(runs).toBe(0);

      releaseSync();
      await settle();

      await post({ confirm: true });
      const blockedSync = await app.inject({ method: 'POST', url: '/api/sync' });
      expect(blockedSync.statusCode).toBe(409);
      expect(blockedSync.json().error).toMatch(/ranking run is in progress/i);

      releaseRank();
      await settle();
    });

    it('refuses a library reset while a run is in flight', async () => {
      let release = () => {};
      await serve({
        wiring: { job: () => new Promise<RankSummary>((resolve) => (release = () => resolve(summary))) },
      });
      await post({ confirm: true });

      const res = await app.inject({ method: 'POST', url: '/api/reset', payload: { confirm: true } });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatch(/ranking run is in progress/i);
      expect(db.getBookmarkCount()).toBe(2);

      release();
      await settle();
    });
  });

  describe('a viewer built without the ranking wiring', () => {
    it('degrades with 503 and a clear reason instead of crashing', async () => {
      await serve({ wiring: null });
      const res = await post({ confirm: true });
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe(RANK_UNAVAILABLE_MESSAGE);
    });

    it('still answers GET /api/rank, reporting the pass as unavailable', async () => {
      // `buildServer(db)` must stay usable in tests: every route answers, this
      // one just says there is nothing to offer.
      await serve({ wiring: null });
      const body = (await app.inject({ method: 'GET', url: '/api/rank' })).json();
      expect(body.ranking).toMatchObject({
        available: false,
        reason: RANK_UNAVAILABLE_MESSAGE,
        scored: 0,
        total: 2,
        pending: 0,
        blocker: null,
        status: null,
      });
    });
  });

  describe('GET /api/setup', () => {
    it('carries everything the control needs to decide what to offer', async () => {
      await serve({ wiring: { pending: () => 2 } });
      const body = (await app.inject({ url: '/api/setup' })).json();
      expect(body.ranking).toMatchObject({
        scored: 0,
        total: 2,
        available: true,
        blocker: null,
        pending: 2,
      });
    });

    it('never reads out a credential value - only whether a run is possible', async () => {
      await serve();
      const body = (await app.inject({ url: '/api/setup' })).json();
      expect(JSON.stringify(body)).not.toMatch(/TYPESAFE_API_KEY.{0,40}=|sk-|secret-value/);
    });
  });

  // ---- POST /api/bookmarks/:id/rank (issue #98) --------------------------
  // The card's empty score badge. One bookmark is still a billed call, so it
  // carries every gate the whole-library run does - these tests exist to stop
  // the narrower scope quietly becoming the looser one.
  describe('POST /api/bookmarks/:id/rank', () => {
    const one = (id: number, body?: unknown) =>
      app.inject({
        method: 'POST',
        url: `/api/bookmarks/${id}/rank`,
        ...(body === undefined ? {} : { payload: body }),
      });

    const firstId = () => db.getBookmarkByPostId('1')!.id;

    it('refuses without the explicit paid confirmation', async () => {
      await serve();
      expect((await one(firstId(), {})).statusCode).toBe(400);
      expect((await one(firstId(), {})).json().error).toBe(RANK_ONE_CONFIRM_MESSAGE);
      expect((await one(firstId())).statusCode).toBe(400);
      for (const confirm of ['true', 1, 'yes', {}, null]) {
        expect((await one(firstId(), { confirm })).statusCode).toBe(400);
      }
      expect(runs).toBe(0);
    });

    it('refuses with 403 and the gate’s own words when ranking is off or the key is missing', async () => {
      await serve({ wiring: { blocker: () => 'Missing credential: TYPESAFE_API_KEY. Set it in your .env.' } });
      const res = await one(firstId(), { confirm: true });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toMatch(/TYPESAFE_API_KEY/);
      expect(runs).toBe(0);
    });

    it('degrades with 503 on a viewer with no ranking wiring', async () => {
      await serve({ wiring: null });
      const res = await one(firstId(), { confirm: true });
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe(RANK_UNAVAILABLE_MESSAGE);
    });

    it('404s an unknown bookmark - and checks the blocker BEFORE it looks', async () => {
      await serve();
      expect((await one(999_999, { confirm: true })).statusCode).toBe(404);
      expect(runs).toBe(0);
      expect((await one(Number.NaN, { confirm: true })).statusCode).toBe(400);
    });

    it('scores exactly the bookmark asked for, and nothing else', async () => {
      await serve({
        wiring: {
          rankOne: async (bookmarkId, log) => {
            log('Ranking pass: TypeSafe Jev - pay-per-token.');
            db.saveBookmarkScore({
              bookmarkId,
              score: 0.75,
              confidence: 0.6,
              dimensions: { depth: 0.8 },
              model: 'jev-test',
              rubricVersion: 'v1',
              scoredAt: '2026-01-01T00:00:00.000Z',
            });
            return { candidates: 1, scored: 1, skipped: 0, failed: 0, inputTokens: 120 };
          },
        },
      });

      const res = await one(firstId(), { confirm: true });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.score).toMatchObject({ value: 0.75, confidence: 0.6 });
      expect(body.summary).toMatchObject({ scored: 1, inputTokens: 120 });
      // The billing line rides the same stream a whole run's does, so a paid
      // call is announced even at this size.
      expect(body.messages[0]).toMatch(/pay-per-token/);
      // Exactly one of the two stored bookmarks gained a score.
      expect(body.ranking).toMatchObject({ scored: 1, total: 2 });
      expect(db.getBookmarkScores([db.getBookmarkByPostId('2')!.id]).size).toBe(0);
    });

    it('reports a failed call as its own actionable message, not a crash', async () => {
      await serve({
        wiring: {
          rankOne: async () => {
            throw new Error('TypeSafe request failed: 401 unauthorized.');
          },
        },
      });
      const res = await one(firstId(), { confirm: true });
      expect(res.statusCode).toBe(502);
      expect(res.json().error).toContain('401');
    });

    it('refuses while a whole-library run or a sync is in flight', async () => {
      let releaseRank = () => {};
      let releaseSync = () => {};
      await serve({
        wiring: { job: () => new Promise<RankSummary>((resolve) => (releaseRank = () => resolve(summary))) },
        syncJob: () =>
          new Promise((resolve) => {
            releaseSync = () => resolve({ newBookmarks: 0, batches: 0, nodesCreated: 0 });
          }),
      });

      await post({ confirm: true });
      const duringRank = await one(firstId(), { confirm: true });
      expect(duringRank.statusCode).toBe(409);
      expect(duringRank.json().error).toMatch(/ranking run is in progress/i);
      releaseRank();
      await settle();

      await app.inject({ method: 'POST', url: '/api/sync' });
      const duringSync = await one(firstId(), { confirm: true });
      expect(duringSync.statusCode).toBe(409);
      expect(duringSync.json().error).toMatch(/sync is running/i);
      releaseSync();
      await settle();
    });
  });
});
