/**
 * The viewer's in-app sync (issue #71): one server-side ingest run at a time,
 * with progress the browser can poll.
 *
 * A sync fetches from X and calls a model - minutes, not milliseconds - so the
 * HTTP request that STARTS one must not be the request that waits for it.
 * `POST /api/sync` therefore kicks the job off and returns immediately, and the
 * client polls `GET /api/sync` for the same progress lines the CLI prints. The
 * runner owns exactly one slot: a second start while one is running is refused
 * (409) rather than queued, because two concurrent ingests would race on the
 * same "already seen" set.
 *
 * Progress is the ingest logger's own output, verbatim. There is no separate
 * progress vocabulary to keep in step with what ingest actually does.
 */
import type { IngestSummary } from '../ingest';

export type SyncState = 'idle' | 'running' | 'done' | 'error';

export interface SyncStatus {
  state: SyncState;
  startedAt: string | null;
  finishedAt: string | null;
  /** Progress lines, oldest first, bounded by {@link MAX_MESSAGES}. */
  messages: string[];
  summary: IngestSummary | null;
  /** Actionable, user-facing, and never a secret - see `redactError` upstream. */
  error: string | null;
}

/** The work one sync performs. Injected, so the server never builds an ingest itself. */
export type SyncJob = (log: (message: string) => void) => Promise<IngestSummary>;

/**
 * Cap on retained progress lines. A large first run logs one line per batch;
 * the owner only ever reads the tail, and an unbounded array in a long-lived
 * server is a leak.
 */
export const MAX_MESSAGES = 200;

/** Cap on how much of a failure message is forwarded to the browser. */
const MAX_ERROR_CHARS = 600;

export class SyncRunner {
  private state: SyncState = 'idle';
  private startedAt: string | null = null;
  private finishedAt: string | null = null;
  private messages: string[] = [];
  private summary: IngestSummary | null = null;
  private error: string | null = null;

  constructor(private readonly job: SyncJob) {}

  /** A snapshot safe to serialize; callers never hold the live arrays. */
  status(): SyncStatus {
    return {
      state: this.state,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      messages: [...this.messages],
      summary: this.summary,
      error: this.error,
    };
  }

  isRunning(): boolean {
    return this.state === 'running';
  }

  /**
   * Start a run unless one is already in flight. Returns whether this call
   * started it, plus the status either way - so the route can answer 409 with
   * the RUNNING job's progress rather than a bare refusal.
   *
   * The promise is deliberately not returned: nothing awaits a sync, which is
   * what keeps the UI unblocked.
   */
  start(): { started: boolean; status: SyncStatus } {
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
          : 'The sync failed. Please try again.';
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
