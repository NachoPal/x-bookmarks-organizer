/**
 * One background job at a time, with progress the browser can poll.
 *
 * Extracted from the in-app sync (issue #71) when the ranking pass needed the
 * same shape (issue #80). The rules it encodes are not sync-specific: a job
 * that takes minutes must not be awaited by the HTTP request that STARTS it,
 * a second start while one is running is REFUSED rather than queued (two runs
 * would race on the same rows), and progress is the job's own logger output
 * verbatim - there is no separate progress vocabulary to keep in step with
 * what the job actually does.
 *
 * `SyncRunner` (`./sync`) and `RankRunner` (`./rank`) are the two instances;
 * each binds the summary type it produces and the sentence shown when a
 * failure carries no message of its own.
 */

export type JobState = 'idle' | 'running' | 'done' | 'error';

export interface JobStatus<TSummary> {
  state: JobState;
  startedAt: string | null;
  finishedAt: string | null;
  /** Progress lines, oldest first, bounded by {@link MAX_MESSAGES}. */
  messages: string[];
  summary: TSummary | null;
  /** Actionable, user-facing, and never a secret - see `redactError` upstream. */
  error: string | null;
}

/** The work one run performs. Injected, so the server never builds one itself. */
export type Job<TSummary> = (log: (message: string) => void) => Promise<TSummary>;

/**
 * Cap on retained progress lines. A large first run logs one line per batch;
 * the owner only ever reads the tail, and an unbounded array in a long-lived
 * server is a leak.
 */
export const MAX_MESSAGES = 200;

/** Cap on how much of a failure message is forwarded to the browser. */
const MAX_ERROR_CHARS = 600;

export class JobRunner<TSummary> {
  private state: JobState = 'idle';
  private startedAt: string | null = null;
  private finishedAt: string | null = null;
  private messages: string[] = [];
  private summary: TSummary | null = null;
  private error: string | null = null;

  /**
   * @param job the work to run.
   * @param failureMessage what the owner is told when a failure carries no
   *   message of its own - everything else forwards the thrown message, which
   *   is already actionable and redacted at its own boundary.
   */
  constructor(
    private readonly job: Job<TSummary>,
    private readonly failureMessage: string,
  ) {}

  /** A snapshot safe to serialize; callers never hold the live arrays. */
  status(): JobStatus<TSummary> {
    return {
      state: this.state,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      messages: [...this.messages],
      summary: this.summary,
      error: this.error,
    };
  }

  /** Forget a finished run (after a library reset); a running one is left alone. */
  clear(): void {
    if (this.state === 'running') return;
    this.state = 'idle';
    this.startedAt = null;
    this.finishedAt = null;
    this.messages = [];
    this.summary = null;
    this.error = null;
  }

  isRunning(): boolean {
    return this.state === 'running';
  }

  /**
   * Start a run unless one is already in flight. Returns whether this call
   * started it, plus the status either way - so the route can answer 409 with
   * the RUNNING job's progress rather than a bare refusal.
   *
   * The promise is deliberately not returned: nothing awaits the job, which is
   * what keeps the UI unblocked.
   */
  start(): { started: boolean; status: JobStatus<TSummary> } {
    if (this.state === 'running') return { started: false, status: this.status() };

    this.state = 'running';
    this.startedAt = new Date().toISOString();
    this.finishedAt = null;
    this.messages = [];
    this.summary = null;
    this.error = null;

    void this.run();
    return { started: true, status: this.status() };
  }

  private async run(): Promise<void> {
    try {
      this.summary = await this.job((message) => this.log(message));
      this.state = 'done';
    } catch (err) {
      // The message is the credential chain's or the provider adapter's own
      // actionable text - already user-facing and redacted at its boundary -
      // so it is forwarded rather than replaced with a generic failure.
      this.error =
        err instanceof Error && err.message
          ? err.message.slice(0, MAX_ERROR_CHARS)
          : this.failureMessage;
      this.state = 'error';
    } finally {
      this.finishedAt = new Date().toISOString();
    }
  }

  private log(message: string): void {
    const text = message.trim();
    if (!text) return;
    this.messages.push(text);
    if (this.messages.length > MAX_MESSAGES) {
      this.messages.splice(0, this.messages.length - MAX_MESSAGES);
    }
  }
}
