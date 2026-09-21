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
  canRank: (r: unknown) => boolean;
  isRunning: (r: unknown) => boolean;
  coverageLine: (r: unknown) => string;
  confirmCost: (r: unknown) => string;
  confirmLabel: (r: unknown) => string;
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
  it('describes the library at each stage', () => {
    expect(ranking.coverageLine(state({ total: 0, pending: 0 }))).toBe('Nothing is ranked yet.');
    expect(ranking.coverageLine(state())).toBe('None of your 10 bookmarks are ranked.');
    expect(ranking.coverageLine(state({ scored: 4, pending: 6 }))).toBe('4 of 10 bookmarks are ranked.');
    expect(ranking.coverageLine(state({ scored: 10, pending: 0 }))).toBe('All 10 bookmarks are ranked.');
  });

  it('pluralizes a single bookmark', () => {
    expect(ranking.coverageLine(state({ total: 1, scored: 1, pending: 0 }))).toBe('All 1 bookmark are ranked.');
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
