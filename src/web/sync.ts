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
 *
 * All of that is the generic {@link JobRunner} (`./job-runner`), which the
 * ranking pass (issue #80) runs on too; this module binds it to the ingest.
 */
import type { IngestSummary } from '../ingest';
import { JobRunner, type Job, type JobState, type JobStatus } from './job-runner';

export { MAX_MESSAGES } from './job-runner';

export type SyncState = JobState;
export type SyncStatus = JobStatus<IngestSummary>;

/** The work one sync performs. Injected, so the server never builds an ingest itself. */
export type SyncJob = Job<IngestSummary>;

/** What the owner is told when a sync fails without a message of its own. */
const SYNC_FAILED_MESSAGE = 'The sync failed. Please try again.';

export class SyncRunner extends JobRunner<IngestSummary> {
  constructor(job: SyncJob) {
    super(job, SYNC_FAILED_MESSAGE);
  }
}
