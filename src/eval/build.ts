/**
 * Build the comparison's paid half, and say out loud what it costs.
 *
 * Deliberately the same shape as `src/rank/build.ts` and
 * `src/categorize/build.ts`: one place per feature where the paid path is
 * gated, so the "no code path spends money silently" invariant has a single
 * home rather than being re-derived at each call site.
 */
import { requireEvalCategorizersCredentials, type Config } from '../config';
import type { CredentialStore } from '../creds/resolve';
import { DEFAULT_TYPESAFE_MODEL, TypeSafeLevelAsker, type LevelAsker } from '../categorize/typesafe/client';
import { billingLabel, type LlmFactory } from '../llm/factory';
import { meteringFetch, newJevUsage, type JevUsage } from './jev';

/** Where a build/billing line goes; the CLI prints it. */
export type Log = (message: string) => void;

export interface BuiltEval {
  asker: LevelAsker;
  /** The tally `asker`'s transport writes into, read by the report's cost section. */
  usage: JevUsage;
}

/**
 * Construct the Jev side of the comparison, refusing first if it is not opted
 * into or cannot authenticate.
 *
 * `requireEvalCategorizersCredentials` runs BEFORE anything is constructed, and
 * it checks the opt-in before the key, so neither a leftover `TYPESAFE_API_KEY`
 * nor a typo'd `XBOOKMARKS_EVAL_CATEGORIZERS` can produce a billable run. The
 * key's value is handed straight to the client and never logged.
 *
 * The walk settings come from `config.typesafe` - the SAME knobs a real
 * `XBOOKMARKS_CATEGORIZER=typesafe` sync would run under - because the point of
 * the comparison is to judge the method the owner would actually turn on, not a
 * differently tuned one.
 */
export function buildEvalJev(config: Config, store: CredentialStore, log: Log = () => {}): BuiltEval {
  const apiKey = requireEvalCategorizersCredentials(config, store);
  const usage = newJevUsage();
  const ts = config.typesafe;
  return {
    usage,
    asker: new TypeSafeLevelAsker({
      apiKey,
      // Metering rides on the SDK's own injectable transport, so the report can
      // quote the API's reported token spend without the live categorizer
      // client growing a counter it has no use for.
      fetch: meteringFetch(globalThis.fetch.bind(globalThis), usage),
      ...(ts.model ? { model: ts.model } : {}),
      ...(ts.baseUrl ? { baseURL: ts.baseUrl } : {}),
      logger: log,
    }),
  };
}

/**
 * Announce how a comparison run is billed, before any call is made.
 *
 * The comparison has a free half and a paid half, so unlike the ranker's line
 * this one names both: the owner should know that the run's price is the Jev
 * side alone, and that the Claude side costs subscription time instead.
 */
export function reportEvalBilling(config: Config, llm: LlmFactory, log: Log): void {
  const jevModel = config.typesafe.model ?? DEFAULT_TYPESAFE_MODEL;
  const taxonomy = llm.describe('taxonomy');
  const assignment = llm.describe('assignment');
  log(
    `Comparison, Jev half: TypeSafe (${jevModel}) - ${billingLabel('per-token')}. ` +
      'Every bookmark is walked down the tree, one request per tree level; ' +
      'input tokens are billed, output tokens are free.',
  );
  log(
    `Comparison, Claude half: ${assignment.providerId} / ${assignment.model} - ` +
      `${billingLabel(assignment.billing)}. Taxonomy design: ${taxonomy.providerId} / ` +
      `${taxonomy.model} - ${billingLabel(taxonomy.billing)}.`,
  );
  log(
    'Unset XBOOKMARKS_EVAL_CATEGORIZERS to leave the comparison off. It writes a report ' +
      'and nothing else - your library is never modified.',
  );
}
