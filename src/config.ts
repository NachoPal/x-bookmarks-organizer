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
}

const DEFAULT_REDIRECT_URI = 'http://127.0.0.1:3000/callback';
const DEFAULT_AUTH_PORT = 3000;
const DEFAULT_WEB_PORT = 5173;
const DEFAULT_LLM_PROVIDER = 'claude-cli';
const DEFAULT_TAXONOMY_EFFORT = 'high';
const DEFAULT_BATCH_SIZE = 15;
const DEFAULT_MIN_DEPTH = 3;
const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_PAGE_SIZE = 20;

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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
    authCallbackPort: intFromEnv('XBOOKMARKS_AUTH_PORT', DEFAULT_AUTH_PORT),
    webPort: intFromEnv('XBOOKMARKS_WEB_PORT', DEFAULT_WEB_PORT),
    llm: llmFromEnv(env),
    batchSize: intFromEnv('XBOOKMARKS_BATCH_SIZE', DEFAULT_BATCH_SIZE),
    minCategoryDepth: intFromEnv('XBOOKMARKS_MIN_DEPTH', DEFAULT_MIN_DEPTH),
    maxCategoryDepth: intFromEnv('XBOOKMARKS_MAX_DEPTH', DEFAULT_MAX_DEPTH),
    pageSize: intFromEnv('XBOOKMARKS_PAGE_SIZE', DEFAULT_PAGE_SIZE),
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
