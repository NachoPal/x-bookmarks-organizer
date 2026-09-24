import { describe, it, expect } from 'vitest';

/**
 * The pure half of the viewer's point-of-spend notices (security review 2,
 * #19/#20), exercised in Node the way `ranking.test.ts` is.
 */
// Plain browser JS, required directly (not compiled by tsc).
const paid = require('./paid-spend.js') as {
  isPaid: (s: unknown) => boolean;
  priceText: (p: unknown) => string;
  modelText: (s: unknown) => string;
  summaryCostSentence: (s: unknown) => string;
  summarizeButtonLabel: (s: unknown, hasSummary: boolean) => string;
  showsPaidMark: (s: unknown, hasSummary: boolean) => boolean;
  summaryLoadingText: (s: unknown) => string;
  summaryRetryLabel: (s: unknown) => string;
  summaryFailureNote: (s: unknown, failedAt?: string) => string;
  paidPasses: (setup: unknown) => unknown[];
  syncNeedsConfirm: (passes: unknown) => boolean;
  syncConfirmCost: (passes: unknown[]) => string;
  syncPassLine: (pass: unknown) => { label: string; detail: string };
  syncConfirmLabel: (passes?: unknown[]) => string;
  findCostSentence: (s: unknown) => string;
};

const SONNET = {
  providerId: 'pi-ai',
  providerLabel: 'pi-ai (your API key or a local model)',
  model: 'anthropic/claude-sonnet-5',
  modelLabel: 'Claude Sonnet 5 (Anthropic API)',
  billing: 'per-token',
  price: { input: 2, output: 10 },
};
const SUBSCRIPTION = { ...SONNET, providerId: 'claude-cli', billing: 'subscription', price: undefined };

describe('the Summarize button', () => {
  it('is marked paid only for a per-token summary that does not exist yet', () => {
    expect(paid.showsPaidMark(SONNET, false)).toBe(true);
    // A saved summary reopens from cache for free.
    expect(paid.showsPaidMark(SONNET, true)).toBe(false);
    expect(paid.showsPaidMark(SUBSCRIPTION, false)).toBe(false);
    // Unknown billing is never guessed paid - but also never priced.
    expect(paid.showsPaidMark(null, false)).toBe(false);
    expect(paid.showsPaidMark({ billing: 'per-token-ish' }, false)).toBe(false);
  });

  it('carries the model and price in its accessible name', () => {
    const label = paid.summarizeButtonLabel(SONNET, false);
    expect(label).toMatch(/^Summarize - paid\./);
    expect(label).toContain('Claude Sonnet 5 (Anthropic API) via pi-ai');
    expect(label).toContain('$2 in / $10 out per 1M tokens');
    expect(paid.summarizeButtonLabel(SUBSCRIPTION, false)).toBe('Summarize');
    expect(paid.summarizeButtonLabel(SONNET, true)).toBe('Open the saved summary');
  });

  it('says the loading and the retry are billed', () => {
    expect(paid.summaryLoadingText(SONNET)).toMatch(/billed per token/);
    expect(paid.summaryLoadingText(SUBSCRIPTION)).not.toMatch(/billed/);
    expect(paid.summaryRetryLabel(SONNET)).toBe('Try again - billed again');
    expect(paid.summaryRetryLabel(SUBSCRIPTION)).toBe('Try again');
  });

  it('explains that a failure is not retried on its own', () => {
    const recent = new Date(Date.now() - 3 * 60_000).toISOString();
    expect(paid.summaryFailureNote(SONNET, recent)).toMatch(/^This summary failed 3 min ago\. /);
    expect(paid.summaryFailureNote(SONNET, recent)).toMatch(/billed again\.$/);
    expect(paid.summaryFailureNote(SUBSCRIPTION)).toBe('It is not retried automatically.');
    expect(paid.summaryFailureNote(SUBSCRIPTION, 'not a date')).toBe('It is not retried automatically.');
  });
});

describe('prices', () => {
  it('formats whole, fractional and tiny prices', () => {
    expect(paid.priceText({ input: 5, output: 25 })).toBe('$5 in / $25 out per 1M tokens');
    expect(paid.priceText({ input: 0.3, output: 2.5 })).toBe('$0.3 in / $2.5 out per 1M tokens');
    expect(paid.priceText({ input: 0.05544, output: 0.11088 })).toBe('$0.055 in / $0.11 out per 1M tokens');
  });

  it('states no price rather than a wrong one', () => {
    expect(paid.priceText(undefined)).toBe('');
    expect(paid.priceText({ input: 1 })).toBe('');
    expect(paid.priceText({ input: -1, output: 2 })).toBe('');
  });
});

describe('the paid-sync confirmation', () => {
  const passes = [
    { pass: 'taxonomy', label: 'Taxonomy pass', providerId: 'pi-ai', model: 'anthropic/claude-opus-4-8', modelLabel: 'Claude Opus 4.8 (Anthropic API)', price: { input: 5, output: 25 } },
    { pass: 'filing', label: 'Filing pass', providerId: 'typesafe', providerLabel: 'TypeSafe', model: 'jev-latest', modelLabel: 'Jev (jev-latest)' },
  ];

  it('is needed exactly when /api/setup names a paid pass', () => {
    expect(paid.paidPasses({ sync: { paidPasses: passes } })).toEqual(passes);
    expect(paid.syncNeedsConfirm(paid.paidPasses({ sync: { paidPasses: passes } }))).toBe(true);
    expect(paid.syncNeedsConfirm(paid.paidPasses({ sync: {} }))).toBe(false);
    expect(paid.paidPasses(null)).toEqual([]);
  });

  it('names the price before the scope, and each pass with its model and price', () => {
    expect(paid.syncConfirmCost(passes)).toMatch(/2 passes billed per token/);
    expect(paid.syncConfirmCost(passes.slice(0, 1))).toMatch(/a pass billed per token/);
    expect(paid.syncPassLine(passes[0])).toEqual({
      label: 'Taxonomy pass',
      detail: 'Claude Opus 4.8 (Anthropic API) via pi-ai - $5 in / $25 out per 1M tokens',
    });
    expect(paid.syncPassLine(passes[1])).toEqual({ label: 'Filing pass', detail: 'Jev (jev-latest) via typesafe' });
    expect(paid.syncConfirmLabel(passes)).toBe('Start paid sync');
  });
});

describe('findCostSentence - what "Find bookmarks" says about its model', () => {
  it('names the per-token price of a paid filing model', () => {
    const text = paid.findCostSentence({ ...SONNET, price: { input: 3, output: 15 } });
    expect(text).toMatch(/^Billed per token to your own account: /);
    expect(text).toContain('$3 in / $15 out per 1M tokens');
  });

  it('names Jev as paid when Jev is the filing method', () => {
    const jev = { providerId: 'typesafe', providerLabel: 'TypeSafe', model: 'jev-latest', modelLabel: 'Jev (jev-latest)', billing: 'per-token' };
    expect(paid.findCostSentence(jev)).toBe('Billed per token to your own account: Jev (jev-latest) via typesafe.');
  });

  it('says a subscription or local model is not billed per call', () => {
    const sub = { providerId: 'claude-cli', model: 'anthropic/claude-haiku-4-5', modelLabel: 'Claude Haiku 4.5', billing: 'subscription' };
    expect(paid.findCostSentence(sub)).toBe(
      'Uses your filing model, Claude Haiku 4.5 via claude-cli - runs on your subscription, no per-call charge.',
    );
    expect(paid.findCostSentence({ ...sub, billing: 'local' })).toContain('runs locally');
    expect(paid.findCostSentence(null)).toBe('');
  });
});
