import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PACKAGE_ROOT } from '../paths';

/**
 * Layered credential provider chain. `process.env` (tier 1) is unchanged - a
 * vault such as Automic Vault's `av inject`, a shell export, Docker `-e`, a
 * systemd unit, or CI secrets all keep working exactly as before. `.env`,
 * the OS keychain, and the owner-only config file are additional doors for a
 * third party with no vault of their own. First hit wins.
 */
export type CredentialSource = 'env' | 'dotenv' | 'keychain' | 'file' | 'claude-cli' | 'none';

export interface ResolvedCredential {
  value: string | undefined;
  /** Safe to surface ("came from .env"); `value` never is. */
  source: CredentialSource;
}

export interface CredentialStore {
  get(key: string): ResolvedCredential;
  /** Writes to the keychain when available, else the `chmod 600` config file. */
  set(key: string, value: string): void;
  clear(key: string): void;
}

const SERVICE = 'x-bookmarks-organizer';

/**
 * Keys read from the PROCESS ENVIRONMENT ONLY, never from `.env`, the keychain
 * or the config file. They are not secrets: they decide what program runs as
 * the owner (`XBOOKMARKS_CLAUDE_BIN`, spawned by every availability probe) and
 * where prompts full of bookmark text are sent (`XBOOKMARKS_PIAI_BASE_URL`).
 * A file the owner did not write must never be able to choose either, so they
 * take an explicit export (or a vault) - the same bar as launching a program.
 * Named literally rather than imported so this module stays free of the
 * provider code; `resolve.test.ts` pins them to the providers' own constants.
 */
export const ENV_ONLY_KEYS: ReadonlySet<string> = new Set(['XBOOKMARKS_CLAUDE_BIN', 'XBOOKMARKS_PIAI_BASE_URL']);

/** Where the chain's `.env` tier lives: the package root, never `process.cwd()`. */
export function dotenvPath(projectRoot: string = PACKAGE_ROOT): string {
  return path.join(projectRoot, '.env');
}

/** A `.env` readable by users other than the owner: where it is, and its octal mode. */
export interface DotenvExposure {
  file: string;
  /** e.g. `644` - never the file's content. */
  mode: string;
}

/**
 * Whether the chain's `.env` is readable by group or others (security finding
 * #8), or null when it is owner-only or absent. Unlike `credentials.json` a
 * readable `.env` is still READ - `cp .env.example .env` leaves it `0644`
 * under a normal umask, so refusing it would break every existing setup - but
 * the owner is told, once at startup and on the viewer's setup surface, with
 * the fix. Windows has no such mode bits, so there is nothing to check there.
 */
export function dotenvExposure(
  file: string = dotenvPath(),
  platform: NodeJS.Platform = process.platform,
): DotenvExposure | null {
  if (platform === 'win32') return null;
  let mode: number;
  try {
    mode = fs.statSync(file).mode;
  } catch {
    return null;
  }
  if (!(mode & 0o077)) return null;
  return { file, mode: (mode & 0o777).toString(8).padStart(3, '0') };
}

/** The one-line form of {@link dotenvExposure}, as the startup log prints it. */
export function dotenvPermissionWarning(
  file: string = dotenvPath(),
  platform: NodeJS.Platform = process.platform,
): string | null {
  const exposed = dotenvExposure(file, platform);
  if (!exposed) return null;
  return (
    `${exposed.file} is readable by other users on this machine (mode ${exposed.mode}), and it can hold ` +
    `your X client secret and API keys. Fix with: chmod 600 ${exposed.file}`
  );
}

/** Simple `KEY=VALUE` parser: ignores blank lines/comments, tolerates quotes and `=` in values. */
export function parseDotenv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && ((value[0] === '"' && value.endsWith('"')) || (value[0] === "'" && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

function readDotenv(file: string): Record<string, string> {
  try {
    return parseDotenv(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

/** Refuses (with a warning, never a throw) a group/world-readable file - the `ssh` pattern. */
function readConfigFile(file: string): Record<string, string> {
  let mode: number;
  try {
    mode = fs.statSync(file).mode;
  } catch {
    return {};
  }
  if (mode & 0o077) {
    console.warn(`Warning: ${file} is readable by group or others; refusing to read it. Fix with: chmod 600 ${file}`);
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function writeConfigFile(file: string, dir: string, values: Record<string, string>): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(values, null, 2), { mode: 0o600 });
}

type Exec = (cmd: string, args: string[], input?: string) => string;

/**
 * Synchronous by design: credential resolution happens once, at the point of use.
 * stderr is captured rather than inherited: a keychain MISS is the normal case
 * for most keys, and `security` reports each one on stderr, which otherwise
 * printed a "could not be found in the keychain" line per lookup at startup.
 */
function defaultExec(cmd: string, args: string[], input?: string): string {
  return execFileSync(cmd, args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

/** Reads via the platform CLI. `cmdkey` cannot retrieve a stored password, only set/delete one. */
function keychainGet(platform: NodeJS.Platform, exec: Exec, key: string): string | undefined {
  try {
    if (platform === 'darwin') return exec('security', ['find-generic-password', '-a', SERVICE, '-s', key, '-w']).trim() || undefined;
    if (platform === 'linux') return exec('secret-tool', ['lookup', 'service', SERVICE, 'key', key]).trim() || undefined;
    return undefined;
  } catch {
    return undefined;
  }
}

function keychainSet(platform: NodeJS.Platform, exec: Exec, key: string, value: string): boolean {
  try {
    if (platform === 'darwin') {
      exec('security', ['add-generic-password', '-a', SERVICE, '-s', key, '-w', value, '-U']);
      return true;
    }
    if (platform === 'linux') {
      exec('secret-tool', ['store', '--label', `${SERVICE} ${key}`, 'service', SERVICE, 'key', key], value);
      return true;
    }
    if (platform === 'win32') {
      exec('cmdkey', [`/generic:${SERVICE}-${key}`, `/user:${SERVICE}`, `/pass:${value}`]);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function keychainClear(platform: NodeJS.Platform, exec: Exec, key: string): void {
  try {
    if (platform === 'darwin') exec('security', ['delete-generic-password', '-a', SERVICE, '-s', key]);
    else if (platform === 'linux') exec('secret-tool', ['clear', 'service', SERVICE, 'key', key]);
    else if (platform === 'win32') exec('cmdkey', [`/delete:${SERVICE}-${key}`]);
  } catch {
    // Best-effort: nothing to clear, or the CLI is absent.
  }
}

export interface CredentialStoreOptions {
  env?: NodeJS.ProcessEnv;
  /** Where `.env` is read from. Defaults to {@link PACKAGE_ROOT}, never `process.cwd()`. */
  projectRoot?: string;
  configDir?: string;
  platform?: NodeJS.Platform;
  /** Injection seam for tests: never spawns a real keychain CLI when overridden. */
  exec?: Exec;
}

export function credentialConfigPaths(configDir?: string): { dir: string; file: string } {
  const dir = configDir ?? path.join(os.homedir(), '.config', 'x-bookmarks-organizer');
  return { dir, file: path.join(dir, 'credentials.json') };
}

export function createCredentialStore(opts: CredentialStoreOptions = {}): CredentialStore {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const exec = opts.exec ?? defaultExec;
  const dotenvFile = dotenvPath(opts.projectRoot);
  const exposed = dotenvPermissionWarning(dotenvFile, platform);
  if (exposed) console.warn(`Warning: ${exposed}`);
  const dotenv = readDotenv(dotenvFile);
  const { dir: configDir, file: configFile } = credentialConfigPaths(opts.configDir);

  return {
    get(key) {
      if (env[key]) return { value: env[key], source: 'env' };
      if (ENV_ONLY_KEYS.has(key)) return { value: undefined, source: 'none' };
      if (dotenv[key]) return { value: dotenv[key], source: 'dotenv' };
      const fromKeychain = keychainGet(platform, exec, key);
      if (fromKeychain) return { value: fromKeychain, source: 'keychain' };
      const fromFile = readConfigFile(configFile)[key];
      if (fromFile) return { value: fromFile, source: 'file' };
      return { value: undefined, source: 'none' };
    },
    set(key, value) {
      if (keychainSet(platform, exec, key, value)) return;
      const current = readConfigFile(configFile);
      current[key] = value;
      writeConfigFile(configFile, configDir, current);
    },
    clear(key) {
      keychainClear(platform, exec, key);
      const current = readConfigFile(configFile);
      if (key in current) {
        delete current[key];
        writeConfigFile(configFile, configDir, current);
      }
    },
  };
}

/** The degradation message when nothing in the chain has a value - lists every tier. */
export function missingCredentialMessage(keys: string[]): string {
  const { file } = credentialConfigPaths();
  return (
    `Missing required secret(s): ${keys.join(', ')}. Provide them any of these ways:\n` +
    '  - the environment (a vault such as `av inject`, a shell export, Docker -e, systemd, CI secrets)\n' +
    `  - ${dotenvPath()} (see \`.env.example\`)\n` +
    '  - your OS keychain (macOS Keychain, GNOME/libsecret, Windows Credential Manager)\n' +
    `  - ${file} (chmod 600)`
  );
}
