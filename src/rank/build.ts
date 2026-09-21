/**
 * Build the ranking pass's collaborators, and say out loud what it costs.
 *
 * Deliberately the same shape as `src/categorize/build.ts`: one place where the
 * paid path is gated, so the "no code path spends money silently" invariant has
 * a single home per feature rather than being re-derived at each call site.
 */
import { requireRankerCredentials, type Config } from '../config';
import type { CredentialStore } from '../creds/resolve';
import { billingLabel } from '../llm/factory';
import { DEFAULT_TYPESAFE_MODEL, JevStateScorer, type StateScorer } from './client';
import { buildRubric, type Rubric } from './rubric';

/** Where a build/billing line goes; the CLI prints it. */
export type Log = (message: string) => void;

export interface BuiltRanker {
  scorer: StateScorer;
  rubric: Rubric;
}

/**
 * Construct the ranker, refusing first if ranking is turned off or cannot
 * authenticate.
 *
 * `requireRankerCredentials` runs BEFORE anything is constructed. Ranking is
 * enabled by default (issue #80), so in practice the gate here is the resolved
 * `TYPESAFE_API_KEY`; constructing a ranker is still not spending, and every
 * caller announces its billing (and, in the app, asks for an explicit
 * confirmation) before a call is made. The key's value is handed straight to
 * the client and never logged.
 */
export function buildRanker(config: Config, store: CredentialStore): BuiltRanker {
  const apiKey = requireRankerCredentials(config, store);
  const { ranker } = config;
  return {
    scorer: new JevStateScorer({
      apiKey,
      model: ranker.model,
      baseURL: ranker.baseUrl,
    }),
    rubric: buildRubric(ranker.interests),
  };
}

/**
 * Announce how a ranking run is billed, before any call is made.
 *
 * Ranking has no free implementation at all - unlike the assignment pass, whose
 * default is the flat-rate subscription - so this line is not a "you changed
 * something" warning but the run's price tag, printed every time.
 */
export function reportRankerBilling(config: Config, rubric: Rubric, log: Log): void {
  const model = config.ranker.model ?? DEFAULT_TYPESAFE_MODEL;
  log(
    `Ranking pass: TypeSafe Jev (${model}) - ${billingLabel('per-token')}. ` +
      `${rubric.dimensions.length} question(s) per bookmark in one request each; ` +
      'input tokens are billed, output tokens are free.',
  );
  log('Set XBOOKMARKS_RANKER=off to disable ranking. Nothing else in the tool uses it.');
}
