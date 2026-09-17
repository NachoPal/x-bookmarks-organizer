import path from 'node:path';

/**
 * Runtime configuration for the tool.
 *
 * The X app secrets are ONLY ever read from the process environment (however
 * you provide it - `av inject`, a `.env` file, your shell, CI secrets, ...).
 * They are never read from a committed file and never written to disk. See
 * README "Secrets". Claude is not held as a secret at all: it is a probed
 * capability (see {@link import('./categorize/llm').isClaudeAvailable}) -
 * `claudeToken` below is only an optional override for a headless machine.
 */
export interface Config {
  /** X OAuth 2.0 app Client ID (env: XBOOKMARKS_CLIENT_ID). */
  xClientId: string;
  /** X OAuth 2.0 app Client Secret (env: XBOOKMARKS_CLIENT_SECRET). */
  xClientSecret: string;
  /**
   * Claude subscription token (env: CLAUDE_CODE_OAUTH_TOKEN). Optional -
   * passed through to the `claude` CLI when set, for a headless machine with
   * no interactive login. Most users need neither this nor the web viewer:
   * an already-logged-in `claude` CLI is enough (see `isClaudeAvailable`).
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
  /** Claude model used for the assignment pass (Haiku-class for cost/quota efficiency). */
  categorizeModel: string;
  /** Claude model used for the holistic taxonomy-design pass (Opus-class). */
  taxonomyModel: string;
  /** Effort level for the taxonomy-design pass (low|medium|high|xhigh|max). */
  taxonomyEffort: string;
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
const DEFAULT_MODEL = 'claude-haiku-4-5';
const DEFAULT_TAXONOMY_MODEL = 'claude-opus-4-8';
const DEFAULT_TAXONOMY_EFFORT = 'high';
const DEFAULT_BATCH_SIZE = 15;
const DEFAULT_MIN_DEPTH = 3;
const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_PAGE_SIZE = 20;

/** Effort levels the `claude` CLI accepts for `--effort`. */
const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Read an effort level from the env, falling back if unset or invalid. */
function effortFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const raw = env[name]?.trim().toLowerCase();
  return raw && VALID_EFFORTS.has(raw) ? raw : fallback;
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
    taxonomyModel: env.XBOOKMARKS_TAXONOMY_MODEL ?? DEFAULT_TAXONOMY_MODEL,
    taxonomyEffort: effortFromEnv(env, 'XBOOKMARKS_TAXONOMY_EFFORT', DEFAULT_TAXONOMY_EFFORT),
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
    throw new Error(
      `Missing required secret(s): ${missing.join(', ')}. ` +
        'Set them however you provide env vars, e.g. via Automic Vault:\n' +
        '  av inject +XBOOKMARKS_CLIENT_ID +XBOOKMARKS_CLIENT_SECRET -- node dist/index.js',
    );
  }
}
