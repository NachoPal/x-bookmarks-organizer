import { describe, expect, it } from 'vitest';
import { MAX_SUMMARY_FAILURES, SummaryFailureBackoff } from './summary-backoff';

describe('SummaryFailureBackoff (security review 2, #19)', () => {
  const clock = () => {
    let t = 1_000_000;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  };

  it('holds a failure for the window, then lets it go on its own', () => {
    const c = clock();
    const backoff = new SummaryFailureBackoff(60_000, c.now);
    backoff.record(7, 'the response hit its output limit');
    expect(backoff.active(7)).toMatchObject({ error: 'the response hit its output limit', retryAfterMs: 60_000 });
    c.advance(59_999);
    expect(backoff.active(7)?.retryAfterMs).toBe(1);
    c.advance(1);
    expect(backoff.active(7)).toBeUndefined();
  });

  it('is per bookmark, and clear() forgets one', () => {
    const backoff = new SummaryFailureBackoff(60_000, clock().now);
    backoff.record(1, 'a');
    backoff.record(2, 'b');
    backoff.clear(1);
    expect(backoff.active(1)).toBeUndefined();
    expect(backoff.active(2)?.error).toBe('b');
  });

  it('bounds its memory, dropping the oldest failure first', () => {
    const backoff = new SummaryFailureBackoff(60_000, clock().now);
    for (let id = 0; id <= MAX_SUMMARY_FAILURES; id++) backoff.record(id, 'x');
    expect(backoff.active(0)).toBeUndefined();
    expect(backoff.active(1)).toBeDefined();
    expect(backoff.active(MAX_SUMMARY_FAILURES)).toBeDefined();
  });
});
