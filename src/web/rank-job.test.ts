import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EntryType } from '@typesafe-ai/sdk';
import { Database } from '../db/database';
import { loadConfig, type Config } from '../config';
import type { CredentialStore, ResolvedCredential } from '../creds/resolve';
import type { ScoredState, StateScorer } from '../rank/client';
import type { DimensionAnswer, Rubric } from '../rank/rubric';
import type { RawBookmark } from '../types';
import { buildRanker } from '../rank/build';
import { createRankWiring } from './rank-job';

/**
 * Entirely offline, and that is load-bearing twice over: ranking is the PAID
 * path, so these tests must never reach `api.typesafe.ai` and must never be
 * able to bill anything. The real wiring runs end to end - the real
 * `buildRanker` gate, the real `reportRankerBilling`, the real `rankBookmarks`
 * pass over a real in-memory database - with only the `StateScorer` faked,
 * which is the same seam `src/rank/ranker.test.ts` uses.
 */

const bm = (postId: string): RawBookmark => ({
  postId,
  authorUsername: 'a',
  authorName: 'A',
  text: `a genuinely substantive post about evaluation methodology ${postId}`,
  url: `https://x.com/a/status/${postId}`,
  postCreatedAt: '',
});

/**
 * Answers whatever rubric it is handed, mid-scale, and records every state it
 * saw - so a test can assert that nothing was sent as easily as that something
 * was. Answering the REAL rubric's own dimension ids is what keeps this a test
 * of the wiring rather than of a hand-written rubric.
 */
class FakeScorer implements StateScorer {
  states: EntryType[] = [];
  async score(state: EntryType, rubric: Rubric): Promise<ScoredState> {
    this.states.push(state);
    return {
      answers: new Map<string, DimensionAnswer>(
        rubric.dimensions.map((d) => [d.id, { score: 1, confidence: 0.9 } as DimensionAnswer]),
      ),
      model: 'jev-test',
      inputTokens: 42,
    };
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

describe('createRankWiring', () => {
  let db: Database;
  let scorer: FakeScorer;

  /**
   * The wiring with the SDK faked but every gate real. `buildRanker` is
   * overridden only to swap in the fake scorer - it still runs the real
   * credential gate first, so the refusal tests below exercise the real rule.
   */
  const wiring = (opts: { config?: Config; store?: CredentialStore } = {}) => {
    const config = opts.config ?? loadConfig({ XBOOKMARKS_RANKER: 'typesafe' });
    const store = opts.store ?? fakeStore({ TYPESAFE_API_KEY: 'k' });
    return createRankWiring({
      db,
      store,
      config,
      buildRanker: (cfg, st) => {
        // The REAL gate, then the fake scorer. Nothing here can reach the API.
        const built = buildRanker(cfg, st);
        return { scorer, rubric: built.rubric };
      },
    });
  };

  beforeEach(() => {
    db = new Database(':memory:');
    scorer = new FakeScorer();
    db.storeCategorizedBatch([bm('1'), bm('2')], () => []);
  });
  afterEach(() => db.close());

  describe('paid-safety gates', () => {
    it('refuses when ranking is not opted into, even with a key present', async () => {
      // The whole point of checking the opt-in FIRST: a TYPESAFE_API_KEY left
      // over from a categorization experiment must never make a run billable.
      const w = wiring({
        config: loadConfig({}),
        store: fakeStore({ TYPESAFE_API_KEY: 'left-over-from-something-else' }),
      });
      expect(w.blocker()).toMatch(/Ranking is off/);
      await expect(w.job(() => {})).rejects.toThrow(/Ranking is off/);
      expect(scorer.states).toHaveLength(0);
    });

    it('refuses when ranking is on but the key does not resolve', async () => {
      const w = wiring({
        config: loadConfig({ XBOOKMARKS_RANKER: 'typesafe' }),
        store: fakeStore({}),
      });
      expect(w.blocker()).toMatch(/TYPESAFE_API_KEY/);
      await expect(w.job(() => {})).rejects.toThrow(/TYPESAFE_API_KEY/);
      expect(scorer.states).toHaveLength(0);
    });

    it('treats an unrecognized ranker value as off, never as an opt-in', async () => {
      const w = wiring({
        config: loadConfig({ XBOOKMARKS_RANKER: 'typesafe-ish' }),
        store: fakeStore({ TYPESAFE_API_KEY: 'k' }),
      });
      expect(w.blocker()).toMatch(/Ranking is off/);
      expect(scorer.states).toHaveLength(0);
    });

    it('reports no blocker once ranking is opted into and the key resolves', () => {
      expect(wiring().blocker()).toBeNull();
    });

    it('announces how the run is billed BEFORE scoring anything', async () => {
      const messages: string[] = [];
      await wiring().job((m) => messages.push(m));
      // The price tag is the first thing in the progress stream the owner is
      // watching - not a line buried after the work has already been paid for.
      expect(messages[0]).toContain('TypeSafe Jev');
      expect(messages[0]).toContain('pay-per-token');
    });
  });

  describe('the run itself', () => {
    it('runs the real ranking pass: bookmarks are scored and stored', async () => {
      const summary = await wiring().job(() => {});

      expect(summary.candidates).toBe(2);
      expect(summary.scored).toBe(2);
      expect(summary.failed).toBe(0);
      expect(summary.inputTokens).toBe(84);
      expect(db.countScoredBookmarks()).toBe(2);
    });

    it('streams the pass’s own logger lines as progress', async () => {
      const messages: string[] = [];
      await wiring().job((m) => messages.push(m));
      expect(messages.some((m) => /Ranking 2 bookmark/.test(m))).toBe(true);
    });

    it('is INCREMENTAL: it never asks for a rescore of what is already scored', async () => {
      // The requirement that makes "Rank now" pressable more than once without
      // paying for the library again: the run takes the ranker's normal
      // selection (`getBookmarksToScore`, which skips anything already scored
      // under the current rubric) and must never pass `rescoreAll`. A later
      // sync's new bookmarks are then the only thing a second press pays for -
      // exactly how sync itself only fetches what is new.
      const seen: Record<string, unknown>[] = [];
      const w = createRankWiring({
        db,
        store: fakeStore({ TYPESAFE_API_KEY: 'k' }),
        config: loadConfig({ XBOOKMARKS_RANKER: 'typesafe' }),
        buildRanker: (cfg, st) => ({ scorer, rubric: buildRanker(cfg, st).rubric }),
        rank: async (_deps, options) => {
          seen.push(options as unknown as Record<string, unknown>);
          return { candidates: 0, scored: 0, skipped: 0, failed: 0, inputTokens: 0 };
        },
      });
      await w.job(() => {});

      expect(seen).toHaveLength(1);
      expect(seen[0]).not.toHaveProperty('rescoreAll');
      expect(seen[0]!.rescoreAll).toBeUndefined();
    });

    it('scores only the NEWLY added bookmarks on a later run', async () => {
      const w = wiring();
      await w.job(() => {});
      expect(scorer.states).toHaveLength(2);

      // A later sync brings in one more bookmark.
      db.storeCategorizedBatch([bm('3')], () => []);
      expect(w.pending()).toBe(1);

      const summary = await w.job(() => {});
      expect(summary.candidates).toBe(1);
      expect(summary.scored).toBe(1);
      // One extra call, not three: the first two were never paid for again.
      expect(scorer.states).toHaveLength(3);
    });

    it('no-ops cleanly over zero unranked bookmarks instead of failing', async () => {
      const w = wiring();
      await w.job(() => {});

      const messages: string[] = [];
      const summary = await w.job((m) => messages.push(m));
      expect(summary).toMatchObject({ candidates: 0, scored: 0, failed: 0, inputTokens: 0 });
      expect(messages.some((m) => /Nothing to rank/i.test(m))).toBe(true);
    });

    it('pays nothing twice: a second run finds nothing left to score', async () => {
      const w = wiring();
      await w.job(() => {});
      expect(w.pending()).toBe(0);

      const again = await w.job(() => {});
      expect(again.candidates).toBe(0);
      expect(again.scored).toBe(0);
      // Two bookmarks, one run's worth of calls.
      expect(scorer.states).toHaveLength(2);
    });
  });

  describe('pending()', () => {
    it('counts what a run would score, without making any call', () => {
      const w = wiring();
      expect(w.pending()).toBe(2);
      expect(scorer.states).toHaveLength(0);
    });

    it('is answerable even when ranking is off, so the dialog can size a run', () => {
      // A free DB read - it must not be gated behind the paid opt-in, or the
      // panel could not say what a run WOULD do before one is authorized.
      expect(wiring({ config: loadConfig({}), store: fakeStore({}) }).pending()).toBe(2);
    });
  });
});
