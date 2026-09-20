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
}

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
