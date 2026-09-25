import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Database } from '../db/database';

/**
 * Who may use the MCP endpoint (`/mcp`): whether it is on, and the ONE bearer
 * token that opens it.
 *
 * Only a SHA-256 hash of the token is stored. The plaintext is returned once,
 * by the call that generates it, and the Settings panel shows it with "copy it
 * now" - the same contract as a GitHub personal access token. Storing the
 * plaintext (in `run_state` or the credential chain) would let the app show it
 * again, but the token is a key to the whole library, and a database file that
 * only ever held a hash of it cannot leak a working one: the file already sits
 * in backups and syncs where a secret should not. Losing it costs a
 * regenerate and a pasted config line, which is cheap.
 *
 * A token is 32 random bytes, so a plain unsalted hash is enough - there is
 * nothing to brute-force - and comparing two fixed-length digests with
 * `timingSafeEqual` keeps the check constant-time whatever was presented.
 *
 * Stored in `run_state` under {@link MCP_ACCESS_KEY}, which a library reset
 * leaves alone (it is configuration, not library state).
 */
export const MCP_ACCESS_KEY = 'mcp_access';

/** Every token starts with this, so a leaked one is recognizable in a log or a paste. */
export const MCP_TOKEN_PREFIX = 'xbo_mcp_';

interface StoredAccess {
  enabled: boolean;
  tokenHash: string | null;
  /**
   * A non-secret mask of the token ({@link maskMcpToken}), derived when it is
   * generated so the panel can say which one is live. Rows written before the
   * mask existed hold the bare last four characters; {@link toView} shows those
   * in the same shape.
   */
  tokenHint: string | null;
  tokenCreatedAt: string | null;
}

/** What the Settings panel may know: never the token, never its hash. */
export interface McpAccessView {
  enabled: boolean;
  hasToken: boolean;
  tokenHint: string | null;
  tokenCreatedAt: string | null;
}

const OFF: StoredAccess = { enabled: false, tokenHash: null, tokenHint: null, tokenCreatedAt: null };

function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

function read(db: Database): StoredAccess {
  const raw = db.getState(MCP_ACCESS_KEY);
  if (!raw) return { ...OFF };
  try {
    const parsed = JSON.parse(raw) as Partial<StoredAccess>;
    return {
      enabled: parsed.enabled === true,
      tokenHash: typeof parsed.tokenHash === 'string' ? parsed.tokenHash : null,
      tokenHint: typeof parsed.tokenHint === 'string' ? parsed.tokenHint : null,
      tokenCreatedAt: typeof parsed.tokenCreatedAt === 'string' ? parsed.tokenCreatedAt : null,
    };
  } catch {
    // An unreadable row fails CLOSED: off, with no token that could match.
    return { ...OFF };
  }
}

/** How many characters of the token's random part a hint shows at each end. */
const HINT_EDGE = 4;

/**
 * The non-secret hint for a token: the fixed prefix, the first and last
 * {@link HINT_EDGE} characters of its random part, and an ellipsis between
 * (`xbo_mcp_ab12…9f3c`). Eight of the 43 base64url characters leaves 210 bits
 * unknown, so the hint identifies the token without weakening it.
 */
export function maskMcpToken(token: string): string {
  const body = token.startsWith(MCP_TOKEN_PREFIX) ? token.slice(MCP_TOKEN_PREFIX.length) : token;
  return `${MCP_TOKEN_PREFIX}${body.slice(0, HINT_EDGE)}\u2026${body.slice(-HINT_EDGE)}`;
}

/** A pre-mask row stored only the last four characters: show them in the mask's shape. */
function normalizeHint(hint: string | null): string | null {
  if (!hint) return null;
  return hint.includes('\u2026') ? hint : `${MCP_TOKEN_PREFIX}\u2026${hint}`;
}

function write(db: Database, access: StoredAccess): void {
  db.setState(MCP_ACCESS_KEY, JSON.stringify(access));
}

function toView(access: StoredAccess): McpAccessView {
  return {
    enabled: access.enabled,
    hasToken: access.tokenHash !== null,
    tokenHint: normalizeHint(access.tokenHint),
    tokenCreatedAt: access.tokenCreatedAt,
  };
}

export function readMcpAccess(db: Database): McpAccessView {
  return toView(read(db));
}

/** Replace the token (the old one stops working at once) and return the new plaintext - the only time it exists. */
export function regenerateMcpToken(db: Database, when: string = new Date().toISOString()): { token: string; access: McpAccessView } {
  const token = `${MCP_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  const access: StoredAccess = {
    ...read(db),
    tokenHash: hashToken(token).toString('hex'),
    tokenHint: maskMcpToken(token),
    tokenCreatedAt: when,
  };
  write(db, access);
  return { token, access: toView(access) };
}

/**
 * Turn the endpoint on or off. Turning it on with no token yet generates one
 * (returned once, like {@link regenerateMcpToken}); turning it off keeps the
 * token, so switching back on does not break an assistant already configured
 * with it - "Regenerate" is what revokes a token.
 */
export function setMcpEnabled(db: Database, enabled: boolean): { token?: string; access: McpAccessView } {
  const current = read(db);
  write(db, { ...current, enabled });
  if (enabled && current.tokenHash === null) return regenerateMcpToken(db);
  return { access: toView({ ...current, enabled }) };
}

/** Whether `presented` is the live token. Constant-time; false whenever no token exists. */
export function verifyMcpToken(db: Database, presented: string): boolean {
  const { tokenHash } = read(db);
  if (!tokenHash || !presented) return false;
  const expected = Buffer.from(tokenHash, 'hex');
  const actual = hashToken(presented);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
