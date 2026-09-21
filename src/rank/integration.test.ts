import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../db/database';
import { buildServer } from '../web/server';
import type { RawBookmark } from '../types';
import { JevStateScorer } from './client';
import { rankBookmarks } from './ranker';
import { buildRubric } from './rubric';

/**
 * End to end through the REAL ranker, the REAL SDK, a REAL HTTP server standing
 * in for the TypeSafe API, and the REAL viewer API - the same "spin up a local
 * server rather than mock fetch" discipline the categorizer's integration test
 * and `HttpArticleFetcher`'s tests use. No network leaves the machine, no API key
 * is real, and nothing is billable.
 */

const WHEN = '2024-01-01T00:00:00.000Z';

function bookmark(postId: string, text: string): RawBookmark {
  return {
    postId,
    authorUsername: 'alice',
    authorName: 'Alice',
    text,
    url: `https://x.com/alice/status/${postId}`,
    postCreatedAt: WHEN,
  };
}

/**
 * A stand-in TypeSafe API. Answers every `Score` question with `scoreFor(state)`
 * on that dimension's own scale, so a test can steer the ranking while still
 * exercising the real SDK's request/response handling.
 */
async function startStubTypeSafe(
  scoreFor: (state: { post: { text: string } }) => number,
): Promise<{ baseUrl: string; requests: unknown[]; close: () => Promise<void> }> {
  const requests: unknown[] = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push(body);

      const fraction = scoreFor(body.state);
      const answers: Record<string, unknown> = {};
      for (const [key, question] of Object.entries(
        body.questions as Record<string, { type: string; criteria: unknown[] }>,
      )) {
        answers[key] = {
          type: 'score',
          score: fraction * (question.criteria.length - 1),
          confidence: 0.9,
          legend: {},
          probabilities: {},
        };
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 25, output_tokens: 0 } }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Every distinct `rubric_version` currently stored, so a run's scale is assertable. */
function storedRubricVersions(db: Database): string[] {
  const ids = db.getBookmarksToScore({ rubricVersion: 'nothing-matches-this', rescoreAll: true });
  const versions = new Set<string>();
  for (const bm of ids) {
    const score = db.getBookmarkScore(bm.id);
    if (score) versions.add(score.rubricVersion);
  }
  return [...versions];
}

describe('ranking end to end, over HTTP and out through the viewer API', () => {
  let db: Database;
  let categoryId: number;

  beforeEach(() => {
    db = new Database(':memory:');
    categoryId = db.getOrCreateCategory('AI', null, WHEN).id;
    // Stored oldest-first so the DEFAULT (recency) ordering is "deep, shallow"
    // and a score-ordered list has to genuinely reorder them.
    db.storeCategorizedBatch([bookmark('1', 'a deep explanation of how schedulers work')], () => [categoryId], WHEN);
    db.storeCategorizedBatch([bookmark('2', 'gm')], () => [categoryId], '2024-01-02T00:00:00.000Z');
  });

  afterEach(() => {
    db.close();
  });

  it('scores over real HTTP and the API then exposes and sorts by the stored score', async () => {
    const stub = await startStubTypeSafe((state) => (state.post.text.includes('schedulers') ? 1 : 0));
    const app = buildServer(db);
    try {
      await app.ready();

      const summary = await rankBookmarks(
        { db, scorer: new JevStateScorer({ apiKey: 'not-a-real-key', baseURL: stub.baseUrl }) },
        { rubric: buildRubric(), concurrency: 2 },
      );

      expect(summary).toMatchObject({ candidates: 2, scored: 2, failed: 0 });
      // One request per bookmark, each carrying the whole rubric.
      expect(stub.requests).toHaveLength(2);
      expect(summary.inputTokens).toBe(50);

      const recent = await app.inject({ url: `/api/categories/${categoryId}/bookmarks` });
      const recentBody = recent.json() as {
        sort: string;
        bookmarks: { postId: string; score: { value: number; confidence: number } | null }[];
      };
      // Default ordering is untouched by ranking: newest-ingested first.
      expect(recentBody.sort).toBe('recent');
      expect(recentBody.bookmarks.map((b) => b.postId)).toEqual(['2', '1']);
      expect(recentBody.bookmarks.find((b) => b.postId === '1')!.score).toMatchObject({
        value: 1,
        confidence: 0.9,
      });

      const byScore = await app.inject({ url: `/api/categories/${categoryId}/bookmarks?sort=score` });
      const scoreBody = byScore.json() as { sort: string; bookmarks: { postId: string }[] };
      expect(scoreBody.sort).toBe('score');
      expect(scoreBody.bookmarks.map((b) => b.postId)).toEqual(['1', '2']);
    } finally {
      await app.close();
      await stub.close();
    }
  });

  it('an incremental run persists and surfaces the newly synced bookmarks (issue #91)', async () => {
    const stub = await startStubTypeSafe(() => 1);
    const app = buildServer(db);
    try {
      await app.ready();
      const scorer = new JevStateScorer({ apiKey: 'not-a-real-key', baseURL: stub.baseUrl });

      // The PROVEN path: the first run over the initial library.
      const first = await rankBookmarks({ db, scorer }, { rubric: buildRubric(), concurrency: 2 });
      expect(first).toMatchObject({ candidates: 2, scored: 2, failed: 0 });
      const versionsAfterFirst = storedRubricVersions(db);
      expect(versionsAfterFirst).toEqual([buildRubric().version]);

      // A later sync stores a bookmark the first run never saw.
      db.storeCategorizedBatch([bookmark('3', 'a careful walkthrough of B-tree splits')], () => [categoryId], '2024-02-01T00:00:00.000Z');

      // The FAILING path in the report: rank again, incrementally. The rubric
      // is rebuilt from scratch exactly as a second in-app run rebuilds it -
      // if that produced a different version tag, the new rows would land
      // under a scale the first run's rows are not on.
      const rubric = buildRubric();
      const second = await rankBookmarks({ db, scorer }, { rubric, concurrency: 2 });
      // Incremental by construction (issue #80): only the new bookmark is
      // paid for, and the two already-current rows are not re-scored.
      expect(second).toMatchObject({ candidates: 1, scored: 1, failed: 0 });
      expect(db.countScoredBookmarks()).toBe(3);
      expect(storedRubricVersions(db)).toEqual(versionsAfterFirst);

      // ...and the viewer read returns a verdict for the NEW bookmark, not
      // only for the ones the first run scored.
      const res = await app.inject({ url: `/api/categories/${categoryId}/bookmarks` });
      const body = res.json() as { bookmarks: { postId: string; score: { value: number } | null }[] };
      expect(body.bookmarks.find((b) => b.postId === '3')!.score).toMatchObject({ value: 1 });
      expect(body.bookmarks.every((b) => b.score !== null)).toBe(true);

      // Sort by score includes it: an unranked bookmark sorts last, so a row
      // the read could not see would fall off the end.
      const byScore = await app.inject({ url: `/api/categories/${categoryId}/bookmarks?sort=score` });
      const scored = byScore.json() as { bookmarks: { postId: string }[] };
      expect(scored.bookmarks.map((b) => b.postId).sort()).toEqual(['1', '2', '3']);
    } finally {
      await app.close();
      await stub.close();
    }
  });

  it('turns a rate limit into the adapter message and leaves the bookmark retryable', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'slow down' } }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const logs: string[] = [];
    try {
      const summary = await rankBookmarks(
        {
          db,
          scorer: new JevStateScorer({
            apiKey: 'not-a-real-key',
            baseURL: `http://127.0.0.1:${port}`,
          }),
          logger: (m) => logs.push(m),
        },
        { rubric: buildRubric(), concurrency: 1, limit: 1 },
      );

      expect(summary).toMatchObject({ scored: 0, failed: 1 });
      expect(logs.join('\n')).toContain('rate-limited');
      expect(db.countScoredBookmarks()).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 20000);
});
