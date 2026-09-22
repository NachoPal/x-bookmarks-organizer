import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

function readDotenv(projectRoot: string): Record<string, string> {
  try {
    return parseDotenv(fs.readFileSync(path.join(projectRoot, '.env'), 'utf8'));
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
  const dotenv = readDotenv(opts.projectRoot ?? process.cwd());
  const { dir: configDir, file: configFile } = credentialConfigPaths(opts.configDir);

  return {
    get(key) {
      if (env[key]) return { value: env[key], source: 'env' };
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
    '  - a `.env` file in the project root (see `.env.example`)\n' +
    '  - your OS keychain (macOS Keychain, GNOME/libsecret, Windows Credential Manager)\n' +
    `  - ${file} (chmod 600)`
  );
}
