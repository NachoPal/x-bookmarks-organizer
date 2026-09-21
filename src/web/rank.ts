/**
 * The viewer's in-app ranking run (issue #80): one server-side ranking pass at
 * a time, with progress the browser can poll.
 *
 * Exactly the sync's shape ({@link JobRunner}), for exactly the sync's reason -
 * a pass that scores a whole library takes minutes, so `POST /api/rank` starts
 * it and returns, and the client polls `GET /api/rank`. A second start is
 * refused rather than queued: two runs would pay twice for the same bookmarks.
 *
 * Nothing about the paid-safety gates lives here. The run refuses itself inside
 * the job (`createRankWiring` -> `requireRankerCredentials`), so a runner built
 * around a job that is not opted into simply reports the refusal as the run's
 * error - there is no second copy of the rule to drift.
 */
import type { RankSummary } from '../rank/ranker';
import { JobRunner, type Job, type JobState, type JobStatus } from './job-runner';

export type RankState = JobState;
export type RankStatus = JobStatus<RankSummary>;

/** The work one ranking run performs. Injected, so the server builds no ranker. */
export type RankJob = Job<RankSummary>;

/** What the owner is told when a run fails without a message of its own. */
const RANK_FAILED_MESSAGE = 'The ranking run failed. Please try again.';

export class RankRunner extends JobRunner<RankSummary> {
  constructor(job: RankJob) {
    super(job, RANK_FAILED_MESSAGE);
  }
}
