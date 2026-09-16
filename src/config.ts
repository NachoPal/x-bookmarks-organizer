import path from 'node:path';

/**
 * Runtime configuration for the tool.
 *
 * Secrets are ONLY ever read from the process environment (injected by Automic
 * Vault at run time). They are never read from a committed file and never
 * written to disk. See README "Secrets" for the `av inject` run command.
 */
export interface Config {
  /** X OAuth 2.0 app Client ID (env: XBOOKMARKS_CLIENT_ID). */
  xClientId: string;
  /** X OAuth 2.0 app Client Secret (env: XBOOKMARKS_CLIENT_SECRET). */
  xClientSecret: string;
  /**
   * Claude subscription token (env: CLAUDE_CODE_OAUTH_TOKEN). Passed through to
   * the `claude` CLI so categorization runs on the subscription, not the paid
   * API. NOT required for the web viewer.
   */
  claudeToken: string | undefined;
  /** Absolute path to the local SQLite database file. */
  dbPath: string;
  /** OAuth redirect URI. Must match the value registered on the X app exactly. */
  redirectUri: string;
  /** Port for the one-time OAuth callback listener. */
  authCallbackPort: number;
  /** Port for the local web viewer. */
  webPort: number;
  /** Claude model used for categorization (Haiku-class for cost/quota efficiency). */
  categorizeModel: string;
  /** How many bookmarks to send to the LLM per request. */
  batchSize: number;
  /** Maximum category tree depth the LLM is allowed to create. */
  maxCategoryDepth: number;
}

const DEFAULT_REDIRECT_URI = 'http://127.0.0.1:3000/callback';
const DEFAULT_AUTH_PORT = 3000;
const DEFAULT_WEB_PORT = 5173;
const DEFAULT_MODEL = 'claude-haiku-4-5';
const DEFAULT_BATCH_SIZE = 15;
const DEFAULT_MAX_DEPTH = 4;

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Build the runtime config from the environment.
 *
 * X credentials are required for ingestion but not for the web viewer, so their
 * absence is tolerated here and validated at the point of use via
 * {@link requireXCredentials}.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dbPath = env.XBOOKMARKS_DB_PATH
    ? path.resolve(env.XBOOKMARKS_DB_PATH)
    : path.resolve(process.cwd(), 'data', 'bookmarks.db');

  return {
    xClientId: env.XBOOKMARKS_CLIENT_ID ?? '',
    xClientSecret: env.XBOOKMARKS_CLIENT_SECRET ?? '',
    claudeToken: env.CLAUDE_CODE_OAUTH_TOKEN || undefined,
    dbPath,
    redirectUri: env.XBOOKMARKS_REDIRECT_URI ?? DEFAULT_REDIRECT_URI,
    authCallbackPort: intFromEnv('XBOOKMARKS_AUTH_PORT', DEFAULT_AUTH_PORT),
    webPort: intFromEnv('XBOOKMARKS_WEB_PORT', DEFAULT_WEB_PORT),
    categorizeModel: env.XBOOKMARKS_MODEL ?? DEFAULT_MODEL,
    batchSize: intFromEnv('XBOOKMARKS_BATCH_SIZE', DEFAULT_BATCH_SIZE),
    maxCategoryDepth: intFromEnv('XBOOKMARKS_MAX_DEPTH', DEFAULT_MAX_DEPTH),
  };
}

/** Assert the X OAuth app credentials are present, with an actionable message. */
export function requireXCredentials(config: Config): void {
  const missing: string[] = [];
  if (!config.xClientId) missing.push('XBOOKMARKS_CLIENT_ID');
  if (!config.xClientSecret) missing.push('XBOOKMARKS_CLIENT_SECRET');
  if (missing.length > 0) {
    throw new Error(
      `Missing required secret(s): ${missing.join(', ')}. ` +
        'Run via Automic Vault, e.g.\n' +
        '  av inject +XBOOKMARKS_CLIENT_ID +XBOOKMARKS_CLIENT_SECRET +CLAUDE_CODE_OAUTH_TOKEN -- node dist/index.js',
    );
  }
}
