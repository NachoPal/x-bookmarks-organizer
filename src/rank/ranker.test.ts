import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EntryType } from '@typesafe-ai/sdk';
import { Database } from '../db/database';
import type { RawBookmark } from '../types';
import type { ScoredState, StateScorer } from './client';
import { planRanking, rankBookmarks } from './ranker';
import type { DimensionAnswer, Rubric } from './rubric';

/**
 * Offline end to end: a real in-memory database and a fake `StateScorer`, so
 * nothing here reaches `api.typesafe.ai` and no call is ever billed.
 */

const rubric: Rubric = {
  version: 'v-test',
  dimensions: [
    { id: 'a', weight: 3, instructions: 'A?', levels: ['low', 'mid', 'high'] },
    { id: 'b', weight: 1, instructions: 'B?', levels: ['no', 'yes'] },
  ],
};

function bm(postId: string, text = `something worth reading ${postId}`): RawBookmark {
  return {
    postId,
    authorUsername: 'a',
    authorName: 'A',
    text,
    url: `https://x.com/a/status/${postId}`,
    postCreatedAt: '',
  };
}

/** Records every state it was handed and answers from a fixed script. */
class FakeScorer implements StateScorer {
  states: EntryType[] = [];
  constructor(
    private readonly answer: (call: number) => ScoredState | Error = () => ({
      answers: new Map<string, DimensionAnswer>([
        ['a', { score: 2, confidence: 0.8 }],
        ['b', { score: 1, confidence: 0.6 }],
      ]),
      model: 'jev-test',
      inputTokens: 100,
    }),
  ) {}
  async score(state: EntryType): Promise<ScoredState> {
    this.states.push(state);
    const result = this.answer(this.states.length);
    if (result instanceof Error) throw result;
    return result;
  }
}

describe('rankBookmarks', () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(':memory:');
  });
  afterEach(() => {
    db.close();
  });

  function store(...bookmarks: RawBookmark[]): void {
    db.storeCategorizedBatch(bookmarks, () => []);
  }

  it('scores each bookmark from its assembled content and stores score + confidence', async () => {
    store(bm('1'));
    const scorer = new FakeScorer();

    const summary = await rankBookmarks({ db, scorer }, { rubric, now: () => '2026-01-01T00:00:00.000Z' });

    expect(summary).toEqual({ candidates: 1, scored: 1, skipped: 0, failed: 0, inputTokens: 100 });
    // The state is built from BookmarkContent, so the post arrives labeled.
    expect(scorer.states[0]).toMatchObject({ post: { author: '@a' } });

    const id = db.getBookmarkByPostId('1')!.id;
    const stored = db.getBookmarkScore(id)!;
    // a = 2/2 at weight 3, b = 1/1 at weight 1 -> 1.0.
    expect(stored.score).toBeCloseTo(1, 10);
    expect(stored.confidence).toBeCloseTo((0.8 * 3 + 0.6) / 4, 10);
    expect(stored.dimensions).toEqual({ a: 1, b: 1 });
    expect(stored).toMatchObject({
      model: 'jev-test',
      rubricVersion: 'v-test',
      scoredAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('is resumable and idempotent: a second run scores nothing and spends nothing', async () => {
    store(bm('1'), bm('2'));
    await rankBookmarks({ db, scorer: new FakeScorer() }, { rubric });

    const second = new FakeScorer();
    const summary = await rankBookmarks({ db, scorer: second }, { rubric });

    expect(second.states).toHaveLength(0);
    expect(summary).toMatchObject({ candidates: 0, scored: 0, inputTokens: 0 });
  });

  it('re-scores only when asked, and re-scores everything when a new rubric version arrives', async () => {
    store(bm('1'));
    await rankBookmarks({ db, scorer: new FakeScorer() }, { rubric });

    const forced = new FakeScorer();
    await rankBookmarks({ db, scorer: forced }, { rubric, rescoreAll: true });
    expect(forced.states).toHaveLength(1);

    // A different rubric version is a different scale, so the old row is stale
    // even without --all - mixing the two in one sort would be meaningless.
    const revised = new FakeScorer();
    await rankBookmarks({ db, scorer: revised }, { rubric: { ...rubric, version: 'v-test-2' } });
    expect(revised.states).toHaveLength(1);
    expect(db.getBookmarkScore(db.getBookmarkByPostId('1')!.id)!.rubricVersion).toBe('v-test-2');
  });

  it('honors a limit, so a first look has a cost ceiling', async () => {
    store(bm('1'), bm('2'), bm('3'));
    const scorer = new FakeScorer();

    const summary = await rankBookmarks({ db, scorer }, { rubric, limit: 2 });

    expect(scorer.states).toHaveLength(2);
    expect(summary.candidates).toBe(2);
    expect(db.countScoredBookmarks()).toBe(2);
  });

  it('never sends a bookmark with nothing to judge, so no money is spent on an absence', async () => {
    store(bm('1', 'https://t.co/opaque'));
    const scorer = new FakeScorer();

    const summary = await rankBookmarks({ db, scorer }, { rubric });

    expect(scorer.states).toHaveLength(0);
    expect(summary).toMatchObject({ candidates: 1, scored: 0, skipped: 1, failed: 0 });
    expect(db.countScoredBookmarks()).toBe(0);
  });

  it('keeps going after a failed call and leaves that bookmark unscored and retryable', async () => {
    store(bm('1'), bm('2'));
    const logs: string[] = [];
    const scorer = new FakeScorer((call) =>
      call === 1
        ? new Error('TypeSafe rate-limited the request (HTTP 429) after retries.')
        : {
            answers: new Map([['a', { score: 0, confidence: 0.5 }]]),
            model: 'jev-test',
            inputTokens: 40,
          },
    );

    const summary = await rankBookmarks({ db, scorer, logger: (m) => logs.push(m) }, { rubric, concurrency: 1 });

    expect(summary).toMatchObject({ candidates: 2, scored: 1, failed: 1, inputTokens: 40 });
    expect(logs.join('\n')).toContain('HTTP 429');
    // Still selected by the next run: a failure must not look like a score.
    expect(planRanking(db, { rubric })).toHaveLength(1);
  });

  it('refuses to store a zero for a call that answered nothing usable', async () => {
    store(bm('1'));
    const scorer = new FakeScorer(() => ({ answers: new Map(), model: 'jev-test', inputTokens: 10 }));

    const summary = await rankBookmarks({ db, scorer }, { rubric });

    expect(summary).toMatchObject({ scored: 0, failed: 1, inputTokens: 10 });
    expect(db.countScoredBookmarks()).toBe(0);
  });

  it('touches only the score table - no bookmark, category or taxonomy row', async () => {
    const when = new Date().toISOString();
    const ai = db.getOrCreateCategory('AI', null, when);
    db.storeCategorizedBatch([bm('1')], () => [ai.id]);
    const before = db.getBookmarkByPostId('1')!;

    await rankBookmarks({ db, scorer: new FakeScorer() }, { rubric });

    expect(db.getBookmarkByPostId('1')).toEqual(before);
    expect(db.getAllCategories().map((c) => c.name)).toEqual(['AI']);
    expect(db.getBookmarksForCategory(ai.id)).toHaveLength(1);
  });
});

describe('planRanking', () => {
  it('reports what a run would score without scoring anything', () => {
    const db = new Database(':memory:');
    db.storeCategorizedBatch([bm('1'), bm('2')], () => []);
    expect(planRanking(db, { rubric })).toHaveLength(2);
    expect(db.countScoredBookmarks()).toBe(0);
    db.close();
  });
});
