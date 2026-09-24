import { describe, it, expect } from 'vitest';

/**
 * The pure half of the in-app "Rank now" control (issue #80), exercised in
 * Node exactly the way `categorization.test.ts` and `tree-counts.js` are: the
 * browser global is a CommonJS module too, so every rule about when a PAID run
 * may be offered is testable without a DOM.
 */
// Plain browser JS, required directly (not compiled by tsc).
const ranking = require('./ranking.js') as {
  rankBlocker: (r: unknown) => string | null;
  singleRankBlocker: (r: unknown) => string | null;
  canRank: (r: unknown) => boolean;
  isRunning: (r: unknown) => boolean;
  coverageLine: (r: unknown) => string;
  unrankedCount: (r: unknown) => number;
  hasUnranked: (r: unknown) => boolean;
  confirmCost: (r: unknown) => string;
  confirmLabel: (r: unknown) => string;
  confirmCostOne: (r?: unknown) => string;
  confirmLabelOne: (r?: unknown) => string;
  progressSource: (sync: unknown, rank: unknown, find?: unknown) => string | null;
  blockerHeadline: (m: unknown) => string;
  blockerDetail: (m: unknown) => string;
  progressLine: (s: unknown) => string;
};

/** The server's `/api/setup` ranking block, with a fully runnable default. */
const state = (over: Record<string, unknown> = {}) => ({
  scored: 0,
  total: 10,
  available: true,
  blocker: null,
  pending: 10,
  status: null,
  ...over,
});

describe('rankBlocker', () => {
  it('is null only when a run is genuinely possible', () => {
    expect(ranking.rankBlocker(state())).toBeNull();
    expect(ranking.canRank(state())).toBe(true);
  });

  it('reports a viewer with no ranking wiring, using the server’s own reason', () => {
    const r = state({ available: false, reason: 'Ranking is not available in this viewer.' });
    expect(ranking.rankBlocker(r)).toBe('Ranking is not available in this viewer.');
    expect(ranking.canRank(r)).toBe(false);
  });

  it('forwards the server gate’s own words when ranking is off or the key is missing', () => {
    // The credential chain's sentence is the owner's fix-it instruction; it is
    // passed through verbatim rather than replaced with a generic "disabled".
    const off = state({ blocker: 'Ranking is off. It is PAID per token...' });
    expect(ranking.rankBlocker(off)).toMatch(/Ranking is off/);
    expect(ranking.canRank(off)).toBe(false);

    const noKey = state({ blocker: 'Missing credential: TYPESAFE_API_KEY' });
    expect(ranking.rankBlocker(noKey)).toMatch(/TYPESAFE_API_KEY/);
    expect(ranking.canRank(noKey)).toBe(false);
  });

  it('blocks an empty library rather than offering a run over nothing', () => {
    expect(ranking.rankBlocker(state({ total: 0, pending: 0 }))).toMatch(/no bookmarks to rank/i);
  });

  it('blocks a fully-scored library - a paid run that would do nothing', () => {
    const done = state({ scored: 10, pending: 0 });
    expect(ranking.rankBlocker(done)).toMatch(/nothing a new run would pay to score/i);
    expect(ranking.canRank(done)).toBe(false);
  });

  it('never offers a run while one is already in flight', () => {
    const running = state({ status: { state: 'running', messages: [] } });
    expect(ranking.isRunning(running)).toBe(true);
    expect(ranking.canRank(running)).toBe(false);
  });

  it('defaults to OFF when the state is missing entirely', () => {
    // A paid control must fail closed: no data means no button, never a
    // hopeful default that could fire a bill.
    expect(ranking.canRank(undefined)).toBe(false);
    expect(ranking.canRank(null)).toBe(false);
  });
});

describe('coverageLine', () => {
  // Phrased around what is LEFT since issue #98: that is the number the icon's
  // dot stands for, so the panel has to name the same one.
  it('describes the library at each stage', () => {
    expect(ranking.coverageLine(state({ total: 0, pending: 0 }))).toBe('Nothing is ranked yet.');
    expect(ranking.coverageLine(state())).toBe('10 of 10 bookmarks unranked.');
    expect(ranking.coverageLine(state({ scored: 4, pending: 6 }))).toBe('6 of 10 bookmarks unranked.');
    expect(ranking.coverageLine(state({ scored: 10, pending: 0 }))).toBe('All 10 bookmarks are ranked.');
  });

  it('pluralizes a single bookmark', () => {
    expect(ranking.coverageLine(state({ total: 1, scored: 1, pending: 0 }))).toBe('All 1 bookmark are ranked.');
  });
});

describe('the unranked notification (issue #98)', () => {
  it('counts what carries no score at all - not what a run would re-score', () => {
    // `pending` also picks up bookmarks scored under an OLDER rubric. Those
    // have a verdict on screen, so they are not what "unranked" means here.
    expect(ranking.unrankedCount(state({ scored: 4, pending: 10 }))).toBe(6);
    expect(ranking.unrankedCount(state({ scored: 10, pending: 0 }))).toBe(0);
  });

  it('never goes negative on inconsistent counts', () => {
    expect(ranking.unrankedCount(state({ total: 3, scored: 5 }))).toBe(0);
  });

  it('shows the dot only when something is unranked, and clears it when nothing is', () => {
    expect(ranking.hasUnranked(state({ scored: 4 }))).toBe(true);
    expect(ranking.hasUnranked(state({ scored: 10, pending: 0 }))).toBe(false);
    expect(ranking.hasUnranked(state({ total: 0, pending: 0 }))).toBe(false);
  });

  it('shows the dot even when the key is missing - the panel says what to fix', () => {
    expect(ranking.hasUnranked(state({ scored: 1, blocker: 'Missing credential: TYPESAFE_API_KEY' }))).toBe(
      true,
    );
  });

  it('shows no dot on a viewer that cannot rank at all - a dot invites an action', () => {
    expect(ranking.hasUnranked(state({ scored: 1, available: false }))).toBe(false);
    expect(ranking.hasUnranked(null)).toBe(false);
  });
});

describe('the one-post confirmation (issue #98)', () => {
  it('keeps every gate a whole run has, except "nothing to score"', () => {
    // The card itself already answered that: an empty badge is only rendered
    // for a bookmark with no verdict.
    expect(ranking.singleRankBlocker(state({ pending: 0, scored: 10 }))).toBeNull();
    expect(ranking.singleRankBlocker(state({ blocker: 'Missing credential: TYPESAFE_API_KEY' }))).toMatch(
      /TYPESAFE_API_KEY/,
    );
    expect(ranking.singleRankBlocker(state({ available: false }))).toMatch(/not available/i);
    expect(ranking.singleRankBlocker(null)).toMatch(/not available/i);
  });

  it('names the PRICE before the scope, exactly as the whole-run one does', () => {
    const text = ranking.confirmCostOne();
    expect(text).toMatch(/paid run/i);
    expect(text).toMatch(/billed per input token/i);
    expect(text.indexOf('paid run')).toBeLessThan(text.indexOf('1 bookmark'));
    expect(ranking.confirmLabelOne()).toBe('Rank this bookmark');
  });
});

describe('progressSource - which job owns the ONE shared strip (issue #98)', () => {
  const running = (startedAt: string) => ({ state: 'running', startedAt, messages: [] });
  const done = (startedAt: string) => ({ state: 'done', startedAt, messages: [] });

  it('shows nothing when neither job has anything to report', () => {
    expect(ranking.progressSource(null, null)).toBeNull();
    expect(ranking.progressSource({ state: 'idle' }, { state: 'idle' })).toBeNull();
  });

  it('shows whichever job exists on its own', () => {
    expect(ranking.progressSource(done('1'), null)).toBe('sync');
    expect(ranking.progressSource(null, done('1'))).toBe('rank');
    expect(ranking.progressSource({ state: 'idle' }, running('1'))).toBe('rank');
  });

  it('gives a RUNNING job the strip over a finished one, either way round', () => {
    expect(ranking.progressSource(done('2'), running('1'))).toBe('rank');
    expect(ranking.progressSource(running('1'), done('2'))).toBe('sync');
  });

  it('otherwise keeps the run the owner just watched - the most recent one', () => {
    expect(ranking.progressSource(done('2024-01-01T00:00:00Z'), done('2024-01-02T00:00:00Z'))).toBe('rank');
    expect(ranking.progressSource(done('2024-01-03T00:00:00Z'), done('2024-01-02T00:00:00Z'))).toBe('sync');
  });
});

describe('progressSource - a "find bookmarks" run shares the strip too', () => {
  const running = (startedAt: string) => ({ state: 'running', startedAt, messages: [] });
  const done = (startedAt: string) => ({ state: 'done', startedAt, messages: [] });

  it('shows a find on its own, and gives a running find the strip over finished jobs', () => {
    expect(ranking.progressSource(null, null, done('1'))).toBe('find');
    expect(ranking.progressSource(done('3'), done('3'), running('1'))).toBe('find');
    expect(ranking.progressSource(running('1'), null, done('2'))).toBe('sync');
  });

  it('otherwise keeps the most recent of the three', () => {
    expect(ranking.progressSource(done('2'), done('1'), done('3'))).toBe('find');
    expect(ranking.progressSource(done('2'), done('3'), done('1'))).toBe('rank');
  });
});

describe('the confirmation', () => {
  it('names the PRICE before the scope - the owner is authorizing a bill', () => {
    const text = ranking.confirmCost(state({ pending: 7 }));
    expect(text).toMatch(/paid run/i);
    expect(text).toMatch(/billed per input token/i);
    expect(text).toContain('7 bookmarks');
    // The price is stated before the count, not after it.
    expect(text.indexOf('paid run')).toBeLessThan(text.indexOf('7 bookmarks'));
  });

  it('restates the scope on the button that actually spends the money', () => {
    expect(ranking.confirmLabel(state({ pending: 7 }))).toBe('Rank 7 bookmarks');
    expect(ranking.confirmLabel(state({ pending: 1 }))).toBe('Rank 1 bookmark');
  });
});

describe('progressLine', () => {
  it('is empty when there is no run to report', () => {
    expect(ranking.progressLine(null)).toBe('');
  });

  it('shows the newest progress line while running', () => {
    expect(ranking.progressLine({ state: 'running', messages: ['first', 'newest'] })).toBe('newest');
  });

  it('has something to say before the first line arrives', () => {
    expect(ranking.progressLine({ state: 'running', messages: [] })).toMatch(/Starting the ranking run/);
  });

  it('forwards a failure’s own actionable message', () => {
    expect(ranking.progressLine({ state: 'error', error: 'Missing credential: TYPESAFE_API_KEY' })).toMatch(
      /TYPESAFE_API_KEY/,
    );
  });

  it('reports what a finished run scored AND what it cost', () => {
    const line = ranking.progressLine({
      state: 'done',
      summary: { candidates: 9, scored: 8, skipped: 1, failed: 0, inputTokens: 1200 },
    });
    expect(line).toContain('Ranked 8 bookmarks');
    expect(line).toContain('1 had nothing to judge');
    expect(line).toContain('1200 input tokens');
  });

  it('says plainly when a run found nothing to do', () => {
    const line = ranking.progressLine({
      state: 'done',
      summary: { candidates: 0, scored: 0, skipped: 0, failed: 0, inputTokens: 0 },
    });
    expect(line).toMatch(/Nothing to rank/);
  });

  it('surfaces failures in the summary rather than hiding them', () => {
    const line = ranking.progressLine({
      state: 'done',
      summary: { candidates: 5, scored: 3, skipped: 0, failed: 2, inputTokens: 300 },
    });
    expect(line).toContain('2 failures');
  });
});

describe('blockerHeadline / blockerDetail', () => {
  // The server's blocker is the credential chain's own message: one clear
  // cause, then the list of places a secret can live. The panel states the
  // cause and holds the procedure behind a disclosure, so the split has to be
  // exact - a headline that swallowed the list would be the wall of text this
  // replaced.
  const blocker = [
    'TypeSafe API key missing - add your key to enable ranking.',
    'Missing required secret(s): TYPESAFE_API_KEY. Provide them any of these ways:\n  - the environment\n  - a `.env` file',
    'Ranking scores bookmarks through the TypeSafe/Jev API, which is PAID per token.',
  ].join('\n\n');

  it('leads with the one clear cause', () => {
    expect(ranking.blockerHeadline(blocker)).toBe(
      'TypeSafe API key missing - add your key to enable ranking.',
    );
  });

  it('keeps every following paragraph, and their line breaks, in the detail', () => {
    const detail = ranking.blockerDetail(blocker);
    expect(detail).toContain('Missing required secret(s)');
    expect(detail).toContain('  - a `.env` file');
    expect(detail).toContain('PAID per token');
    expect(detail).not.toContain('add your key to enable ranking');
  });

  it('has no detail for a single-paragraph blocker, so nothing empty is shown', () => {
    expect(ranking.blockerHeadline('Sync your library first.')).toBe('Sync your library first.');
    expect(ranking.blockerDetail('Sync your library first.')).toBe('');
  });

  it('tolerates a missing message', () => {
    expect(ranking.blockerHeadline(null)).toBe('');
    expect(ranking.blockerDetail(undefined)).toBe('');
  });
});
