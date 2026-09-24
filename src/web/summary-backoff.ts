/**
 * Remembers a failed summary so it is not re-generated on its own (security
 * review 2, #19).
 *
 * A failed call may already have been billed - a response cut off at its
 * output limit is paid for in full and then thrown away - and a failure
 * stores no summary, so without this every later request for the same
 * bookmark (reopening the modal, or a refresh) would make another full call.
 * While a failure is recorded, `POST /api/bookmarks/:id/summary` answers with
 * it instead of calling the model; the owner's
 * explicit "Try again" (`POST /api/bookmarks/:id/summary/retry`) is the one
 * path that bypasses it, so a deliberate retry is never blocked.
 *
 * In memory on purpose: restarting the viewer is itself a deliberate act, and
 * a record that outlived it would only get in the way.
 */

/** How long a failure suppresses automatic re-generation. */
export const SUMMARY_FAILURE_BACKOFF_MS = 10 * 60_000;

/** Upper bound on remembered failures, so a flood of them cannot grow memory. */
export const MAX_SUMMARY_FAILURES = 500;

export interface SummaryFailure {
  /** The adapter's already-redacted, user-facing message. */
  error: string;
  failedAt: number;
  /** Milliseconds until the failure stops suppressing a request on its own. */
  retryAfterMs: number;
}

export class SummaryFailureBackoff {
  private readonly failures = new Map<number, { error: string; failedAt: number }>();

  constructor(
    private readonly windowMs: number = SUMMARY_FAILURE_BACKOFF_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Record a failed generation for a bookmark. */
  record(bookmarkId: number, error: string): void {
    const now = this.now();
    this.prune(now);
    // Re-inserting moves the entry to the end, so the oldest is always first.
    this.failures.delete(bookmarkId);
    this.failures.set(bookmarkId, { error, failedAt: now });
    while (this.failures.size > MAX_SUMMARY_FAILURES) {
      const oldest = this.failures.keys().next().value;
      if (oldest === undefined) break;
      this.failures.delete(oldest);
    }
  }

  /** The recorded failure still in force for a bookmark, if any. */
  active(bookmarkId: number): SummaryFailure | undefined {
    const entry = this.failures.get(bookmarkId);
    if (!entry) return undefined;
    const retryAfterMs = entry.failedAt + this.windowMs - this.now();
    if (retryAfterMs <= 0) {
      this.failures.delete(bookmarkId);
      return undefined;
    }
    return { ...entry, retryAfterMs };
  }

  /** Forget a bookmark's failure: it succeeded, or the owner retried it. */
  clear(bookmarkId: number): void {
    this.failures.delete(bookmarkId);
  }

  private prune(now: number): void {
    for (const [id, entry] of this.failures) {
      if (entry.failedAt + this.windowMs > now) break;
      this.failures.delete(id);
    }
  }
}
