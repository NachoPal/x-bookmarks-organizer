import path from 'node:path';
import type { CredentialStore } from './creds/resolve';
import { missingCredentialMessage } from './creds/resolve';
import type { LlmConfig } from './llm/types';

/**
 * Runtime configuration for the tool.
 *
 * Secrets resolve through the layered credential chain (`src/creds/resolve.ts`):
 * the process environment first (a vault such as `av inject`, a shell export, a
 * systemd unit - unchanged), then a `.env` file, the OS keychain, and finally an
 * owner-only config file. Nothing is ever read from a *committed* file. See
 * README "Secrets".
 */
export interface Config {
  /** X OAuth 2.0 app Client ID (env: XBOOKMARKS_CLIENT_ID). */
  xClientId: string;
  /** X OAuth 2.0 app Client Secret (env: XBOOKMARKS_CLIENT_SECRET). */
  xClientSecret: string;
  /** Absolute path to the local SQLite database file. */
  dbPath: string;
  /** OAuth redirect URI. Must match the value registered on the X app exactly. */
  redirectUri: string;
  /** Port for the one-time OAuth callback listener. */
  authCallbackPort: number;
  /** Port for the local web viewer. */
  webPort: number;
  /**
   * Which LLM provider runs, and with which model per role. Model names and
   * effort levels are provider-specific, so they are resolved by the provider
   * adapter (`src/llm/`), not here.
   */
  llm: LlmConfig;
  /** How many bookmarks to send to the assignment LLM per request. */
  batchSize: number;
  /** Best-effort minimum nesting depth the taxonomy pass targets. */
  minCategoryDepth: number;
  /** Maximum category tree depth the LLM is allowed to create. */
  maxCategoryDepth: number;
  /**
   * How many bookmarks the viewer loads per batch as the owner scrolls a
   * category (env: XBOOKMARKS_PAGE_SIZE). Keeps large categories from rendering
   * every post - and every X embed - at once.
   */
  pageSize: number;
  /**
   * Which implementation runs the ASSIGNMENT pass (env: XBOOKMARKS_CATEGORIZER).
   * Deliberately separate from `XBOOKMARKS_LLM_PROVIDER`: TypeSafe is not an
   * LLM provider and must never be selectable for the summary or chat roles.
   * Defaults to `claude-cli`, so categorization stays on the flat-rate Claude
   * subscription unless the owner opts in.
   */
  categorizer: CategorizerId;
  /** Tuning for the TypeSafe categorizer. Inert unless it is the selected one. */
  typesafe: TypeSafeConfig;
  /**
   * The opt-in bookmark ranking pass (env: XBOOKMARKS_RANKER, issue #62).
   * `off` by default, and `off` means the `rank` command refuses to run at all:
   * ranking is PAID per token, so it takes an explicit choice AND a resolved
   * TYPESAFE_API_KEY before any call is made. Nothing else in the tool reads
   * this - ingestion, categorization, summaries and browsing are untouched.
   */
  ranker: RankerConfig;
  /**
   * The opt-in categorizer COMPARISON eval (env: XBOOKMARKS_EVAL_CATEGORIZERS).
   * `off` by default, and `off` means the `eval-categorizers` command refuses
   * to run the Jev side at all: it is PAID per token, so it takes an explicit
   * choice AND a resolved TYPESAFE_API_KEY before any call is made. Nothing
   * else in the tool reads this - it produces a report and never writes to the
   * library.
   */
  evalCategorizers: EvalCategorizersId;
}

/** The ranking implementations the owner can choose between. `off` is the default. */
export const RANKER_IDS = ['off', 'typesafe'] as const;
export type RankerId = (typeof RANKER_IDS)[number];

/**
 * Knobs for the TypeSafe/Jev ranking pass (issue #62).
 *
 * Separate from {@link TypeSafeConfig} on purpose: the two passes ask different
 * question types, are enabled independently, and an owner may well want the
 * free Claude categorizer alongside a paid one-off ranking run. They do share
 * the one `TYPESAFE_API_KEY`.
 */
export interface RankerConfig {
  /** Which implementation ranks bookmarks; `off` disables ranking entirely. */
  id: RankerId;
  /** Model id; the SDK's own default (`jev-latest`) when unset. */
  model?: string;
  /** How many bookmarks are scored concurrently. */
  concurrency: number;
  /**
   * What the owner is interested in, in their own words (env:
   * XBOOKMARKS_RANKER_INTERESTS). Set, the rubric gains a relevance question;
   * unset, it asks only about the content itself. See `buildRubric`.
   */
  interests?: string;
  /** API root override, mainly for testing against a local stub. */
  baseUrl?: string;
}

/**
 * The categorizer-comparison eval's opt-in (`eval-categorizers`).
 *
 * Its own switch rather than a reuse of `XBOOKMARKS_CATEGORIZER`: selecting the
 * Jev categorizer for real syncs and asking for a one-off paid comparison run
 * are different decisions, and conflating them would let the first silently
 * authorize the second.
 */
export const EVAL_CATEGORIZERS_IDS = ['off', 'typesafe'] as const;
export type EvalCategorizersId = (typeof EVAL_CATEGORIZERS_IDS)[number];

/** The assignment-pass implementations the owner can choose between. */
export const CATEGORIZER_IDS = ['claude-cli', 'typesafe'] as const;
export type CategorizerId = (typeof CATEGORIZER_IDS)[number];

/**
 * Knobs for the TypeSafe/Jev assignment pass (issue #61).
 *
 * The thresholds are the quality/precision dials the scout report calls out as
 * needing tuning against a real library, so each is an env override rather than
 * a constant buried in the walk.
 */
export interface TypeSafeConfig {
  /** Model id; the SDK's own default (`jev-latest`) when unset. */
  model?: string;
  /** Paths kept alive per tree level. 1 is greedy descent. */
  beamWidth: number;
  /** Floor an edge's probability and the level's confidence must clear to descend. */
  confidenceThreshold: number;
  /** Floor on a path's normalized score to be kept as an ADDITIONAL label. */
  multiLabelThreshold: number;
  /** Cap on how many categories one bookmark may be filed under. */
  maxLabels: number;
  /** How many bookmarks are walked concurrently. */
  concurrency: number;
  /** API root override, mainly for testing against a local stub. */
  baseUrl?: string;
}

/** The credential the TypeSafe categorizer needs, resolved via the credential chain. */
export const TYPESAFE_API_KEY = 'TYPESAFE_API_KEY';

const DEFAULT_REDIRECT_URI = 'http://127.0.0.1:3000/callback';
const DEFAULT_AUTH_PORT = 3000;
const DEFAULT_WEB_PORT = 5173;
const DEFAULT_LLM_PROVIDER = 'claude-cli';
const DEFAULT_TAXONOMY_EFFORT = 'high';
const DEFAULT_BATCH_SIZE = 15;
const DEFAULT_MIN_DEPTH = 3;
const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_PAGE_SIZE = 20;
const DEFAULT_CATEGORIZER: CategorizerId = 'claude-cli';
const DEFAULT_TYPESAFE_BEAM_WIDTH = 3;
const DEFAULT_TYPESAFE_CONFIDENCE = 0.55;
const DEFAULT_TYPESAFE_MULTILABEL = 0.6;
const DEFAULT_TYPESAFE_MAX_LABELS = 3;
const DEFAULT_TYPESAFE_CONCURRENCY = 8;
const DEFAULT_RANKER: RankerId = 'off';
const DEFAULT_RANKER_CONCURRENCY = 6;
const DEFAULT_EVAL_CATEGORIZERS: EvalCategorizersId = 'off';

function intFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** A 0..1 ratio from the environment; anything outside that range keeps the default. */
function ratioFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}

/** A trimmed env value, or undefined when unset or blank (so "" never overrides a default). */
function optionalFromEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return env[name]?.trim() || undefined;
}

/**
 * Build the per-role LLM config from the environment.
 *
 * The historical vars keep their exact meaning against the default provider:
 * `XBOOKMARKS_MODEL` is the assignment model, and - unless `XBOOKMARKS_SUMMARY_MODEL`
 * overrides it - also the summary model when explicitly set; left unset, summary
 * falls through to the provider's own suggestion (Claude Sonnet 5, for quality -
 * see `models` in `src/llm/providers/claude-cli.ts`), independent of the
 * Haiku-class assignment default. `XBOOKMARKS_TAXONOMY_MODEL` /
 * `XBOOKMARKS_TAXONOMY_EFFORT` drive pass 1. Whether a level is a *valid* effort
 * is the adapter's business, not this file's - the same environment may one day
 * target several providers.
 */
function llmFromEnv(env: NodeJS.ProcessEnv): LlmConfig {
  const assignmentModel = optionalFromEnv(env, 'XBOOKMARKS_MODEL');
  return {
    defaultProvider: optionalFromEnv(env, 'XBOOKMARKS_LLM_PROVIDER') ?? DEFAULT_LLM_PROVIDER,
    defaultModel: optionalFromEnv(env, 'XBOOKMARKS_LLM_MODEL'),
    roles: {
      taxonomy: {
        provider: optionalFromEnv(env, 'XBOOKMARKS_TAXONOMY_PROVIDER'),
        model: optionalFromEnv(env, 'XBOOKMARKS_TAXONOMY_MODEL'),
        params: {
          effort: optionalFromEnv(env, 'XBOOKMARKS_TAXONOMY_EFFORT') ?? DEFAULT_TAXONOMY_EFFORT,
        },
      },
      assignment: {
        provider: optionalFromEnv(env, 'XBOOKMARKS_ASSIGNMENT_PROVIDER'),
        model: assignmentModel,
      },
      summary: {
        provider: optionalFromEnv(env, 'XBOOKMARKS_SUMMARY_PROVIDER'),
        model: optionalFromEnv(env, 'XBOOKMARKS_SUMMARY_MODEL') ?? assignmentModel,
      },
      chat: {
        provider: optionalFromEnv(env, 'XBOOKMARKS_CHAT_PROVIDER'),
        model: optionalFromEnv(env, 'XBOOKMARKS_CHAT_MODEL'),
      },
    },
  };
}

/** The message an unknown `XBOOKMARKS_CATEGORIZER` produces. */
export function unknownCategorizerMessage(id: string): string {
  return (
    `Unknown categorizer "${id}". Available: ${CATEGORIZER_IDS.join(', ')}. ` +
    'Set XBOOKMARKS_CATEGORIZER to one of these.'
  );
}

/**
 * Resolve which implementation runs the assignment pass.
 *
 * Unset means `claude-cli`, so the default path never spends money. An
 * unrecognized value throws rather than silently falling back, because
 * "I thought I selected Jev" and "I thought I was still on Claude" are both
 * bad surprises when one of them is billable.
 */
function categorizerFromEnv(env: NodeJS.ProcessEnv): CategorizerId {
  const raw = optionalFromEnv(env, 'XBOOKMARKS_CATEGORIZER');
  if (!raw) return DEFAULT_CATEGORIZER;
  const match = CATEGORIZER_IDS.find((id) => id === raw.toLowerCase());
  if (!match) throw new Error(unknownCategorizerMessage(raw));
  return match;
}

/**
 * The ranker choice from the environment. An unrecognized value is treated as
 * `off`, never as an opt-in: the failure mode of a typo must be "no ranking",
 * not "unexpected spend".
 */
function rankerFromEnv(env: NodeJS.ProcessEnv): RankerConfig {
  const raw = env.XBOOKMARKS_RANKER?.trim();
  const id = (RANKER_IDS as readonly string[]).includes(raw ?? '')
    ? (raw as RankerId)
    : DEFAULT_RANKER;
  return {
    id,
    model: optionalFromEnv(env, 'XBOOKMARKS_RANKER_MODEL'),
    concurrency: intFromEnv(env, 'XBOOKMARKS_RANKER_CONCURRENCY', DEFAULT_RANKER_CONCURRENCY),
    interests: optionalFromEnv(env, 'XBOOKMARKS_RANKER_INTERESTS'),
    baseUrl: optionalFromEnv(env, 'XBOOKMARKS_TYPESAFE_BASE_URL'),
  };
}

/**
 * The eval opt-in from the environment. Like the ranker's, an unrecognized
 * value is `off`, never an opt-in: the failure mode of a typo must be
 * "no comparison run", not "unexpected spend".
 */
function evalCategorizersFromEnv(env: NodeJS.ProcessEnv): EvalCategorizersId {
  const raw = env.XBOOKMARKS_EVAL_CATEGORIZERS?.trim();
  return (EVAL_CATEGORIZERS_IDS as readonly string[]).includes(raw ?? '')
    ? (raw as EvalCategorizersId)
    : DEFAULT_EVAL_CATEGORIZERS;
}

function typeSafeFromEnv(env: NodeJS.ProcessEnv): TypeSafeConfig {
  return {
    model: optionalFromEnv(env, 'XBOOKMARKS_TYPESAFE_MODEL'),
    beamWidth: intFromEnv(env, 'XBOOKMARKS_TYPESAFE_BEAM_WIDTH', DEFAULT_TYPESAFE_BEAM_WIDTH),
    confidenceThreshold: ratioFromEnv(env, 'XBOOKMARKS_TYPESAFE_CONFIDENCE', DEFAULT_TYPESAFE_CONFIDENCE),
    multiLabelThreshold: ratioFromEnv(env, 'XBOOKMARKS_TYPESAFE_MULTILABEL', DEFAULT_TYPESAFE_MULTILABEL),
    maxLabels: intFromEnv(env, 'XBOOKMARKS_TYPESAFE_MAX_LABELS', DEFAULT_TYPESAFE_MAX_LABELS),
    concurrency: intFromEnv(env, 'XBOOKMARKS_TYPESAFE_CONCURRENCY', DEFAULT_TYPESAFE_CONCURRENCY),
    baseUrl: optionalFromEnv(env, 'XBOOKMARKS_TYPESAFE_BASE_URL'),
  };
}

/**
 * Build the runtime config from the environment.
 *
 * `store` is optional and, when omitted, behavior is byte-identical to before
 * the credential chain existed (env only) - every test that injects a fake
 * `env` keeps passing unchanged. When passed, the X credentials resolve
 * through the full chain (env -> .env -> keychain -> config file), of which
 * `env` is still tier 1.
 *
 * X credentials are required for ingestion but not for the web viewer, so their
 * absence is tolerated here and validated at the point of use via
 * {@link requireXCredentials}.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, store?: CredentialStore): Config {
  const dbPath = env.XBOOKMARKS_DB_PATH
    ? path.resolve(env.XBOOKMARKS_DB_PATH)
    : path.resolve(process.cwd(), 'data', 'bookmarks.db');

  const xClientId = store ? store.get('XBOOKMARKS_CLIENT_ID').value : env.XBOOKMARKS_CLIENT_ID;
  const xClientSecret = store ? store.get('XBOOKMARKS_CLIENT_SECRET').value : env.XBOOKMARKS_CLIENT_SECRET;

  return {
    xClientId: xClientId ?? '',
    xClientSecret: xClientSecret ?? '',
    dbPath,
    redirectUri: env.XBOOKMARKS_REDIRECT_URI ?? DEFAULT_REDIRECT_URI,
    authCallbackPort: intFromEnv(env, 'XBOOKMARKS_AUTH_PORT', DEFAULT_AUTH_PORT),
    webPort: intFromEnv(env, 'XBOOKMARKS_WEB_PORT', DEFAULT_WEB_PORT),
    llm: llmFromEnv(env),
    batchSize: intFromEnv(env, 'XBOOKMARKS_BATCH_SIZE', DEFAULT_BATCH_SIZE),
    minCategoryDepth: intFromEnv(env, 'XBOOKMARKS_MIN_DEPTH', DEFAULT_MIN_DEPTH),
    maxCategoryDepth: intFromEnv(env, 'XBOOKMARKS_MAX_DEPTH', DEFAULT_MAX_DEPTH),
    pageSize: intFromEnv(env, 'XBOOKMARKS_PAGE_SIZE', DEFAULT_PAGE_SIZE),
    categorizer: categorizerFromEnv(env),
    typesafe: typeSafeFromEnv(env),
    ranker: rankerFromEnv(env),
    evalCategorizers: evalCategorizersFromEnv(env),
  };
}

/** Assert the X OAuth app credentials are present, with an actionable message. */
export function requireXCredentials(config: Config): void {
  const missing: string[] = [];
  if (!config.xClientId) missing.push('XBOOKMARKS_CLIENT_ID');
  if (!config.xClientSecret) missing.push('XBOOKMARKS_CLIENT_SECRET');
  if (missing.length > 0) {
    throw new Error(missingCredentialMessage(missing));
  }
}

/**
 * Assert the TypeSafe API key is present before anything can spend money.
 *
 * Called from the categorization preflight when - and only when - the owner
 * selected the `typesafe` categorizer, so the default Claude path never asks
 * for this key. The key resolves through the same layered chain as every other
 * secret, and its VALUE is never surfaced (only whether one was found).
 */
export function requireTypeSafeCredentials(store: CredentialStore): string {
  const resolved = store.get(TYPESAFE_API_KEY);
  if (!resolved.value) {
    throw new Error(
      `${missingCredentialMessage([TYPESAFE_API_KEY])}\n\n` +
        'XBOOKMARKS_CATEGORIZER=typesafe routes the assignment pass through the TypeSafe/Jev\n' +
        'API, which is PAID per token. Unset XBOOKMARKS_CATEGORIZER to go back to the\n' +
        'default Claude-subscription categorizer, which costs nothing per call.',
    );
  }
  return resolved.value;
}

/**
 * Assert the ranking pass is BOTH opted into and able to authenticate, before
 * anything can spend money (issue #62).
 *
 * Two independent gates, and the order matters: an owner who never asked for
 * ranking is told that first, so a stale `TYPESAFE_API_KEY` left in the
 * environment from a categorization experiment can never turn `rank` into a
 * paid run on its own. Only the key's PRESENCE is ever checked here; its value
 * is returned to the caller and never logged (`AGENTS.md`).
 */
export function requireRankerCredentials(config: Config, store: CredentialStore): string {
  if (config.ranker.id !== 'typesafe') {
    throw new Error(
      'Ranking is off. It is PAID per token, so it never runs unless you ask for it:\n' +
        'set XBOOKMARKS_RANKER=typesafe to score bookmarks with the TypeSafe/Jev API.\n' +
        'Everything else - syncing, categorizing, summaries, browsing - is unaffected.',
    );
  }
  const resolved = store.get(TYPESAFE_API_KEY);
  if (!resolved.value) {
    throw new Error(
      `${missingCredentialMessage([TYPESAFE_API_KEY])}\n\n` +
        'XBOOKMARKS_RANKER=typesafe scores bookmarks through the TypeSafe/Jev API, which\n' +
        'is PAID per token. Unset XBOOKMARKS_RANKER to leave ranking off; nothing else in\n' +
        'the tool needs this key.',
    );
  }
  return resolved.value;
}

/**
 * Assert the categorizer-comparison eval is BOTH opted into and able to
 * authenticate, before anything can spend money.
 *
 * Exactly the ranker's two gates, in exactly the ranker's order: the opt-in is
 * checked FIRST, so a `TYPESAFE_API_KEY` left in the environment by a
 * categorization or ranking experiment can never turn `eval-categorizers` into
 * a paid run on its own. Only the key's PRESENCE is checked here; its value is
 * returned to the caller and never logged (`AGENTS.md`).
 */
export function requireEvalCategorizersCredentials(config: Config, store: CredentialStore): string {
  if (config.evalCategorizers !== 'typesafe') {
    throw new Error(
      'The categorizer comparison is off. Its TypeSafe/Jev half is PAID per token, so it\n' +
        'never runs unless you ask for it: set XBOOKMARKS_EVAL_CATEGORIZERS=typesafe to\n' +
        'compare the Claude and Jev assignment passes. The report is the only thing it\n' +
        'produces - your library is never written to.',
    );
  }
  const resolved = store.get(TYPESAFE_API_KEY);
  if (!resolved.value) {
    throw new Error(
      `${missingCredentialMessage([TYPESAFE_API_KEY])}\n\n` +
        'XBOOKMARKS_EVAL_CATEGORIZERS=typesafe files every bookmark a second time through\n' +
        'the TypeSafe/Jev API, which is PAID per token. Unset XBOOKMARKS_EVAL_CATEGORIZERS\n' +
        'to leave the comparison off; nothing else in the tool needs this key.',
    );
  }
  return resolved.value;
}
