import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createCredentialStore,
  dotenvExposure,
  dotenvPath,
  dotenvPermissionWarning,
  ENV_ONLY_KEYS,
  missingCredentialMessage,
  parseDotenv,
} from './resolve';
import { PACKAGE_ROOT } from '../paths';
import { CLAUDE_BIN_KEY } from '../llm/providers/claude-cli';
import { PIAI_LOCAL_BASE_URL_KEY } from '../llm/providers/pi-ai';

/**
 * Every test here is fully offline: a scratch project root/config dir per
 * test, and a stubbed `exec` so the keychain tier never shells out to a real
 * `security` / `secret-tool` / `cmdkey` binary or touches the user's own
 * keychain or config file.
 */
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbo-creds-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function projectRoot(): string {
  const dir = path.join(tmpDir, 'project');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function configDir(): string {
  return path.join(tmpDir, 'config');
}

/** A stub `exec` that never touches a real keychain: not-found by default. */
function noKeychainExec(): never {
  throw new Error('ENOENT: no such CLI');
}

describe('parseDotenv', () => {
  it('parses KEY=VALUE, ignoring blank lines and comments', () => {
    const parsed = parseDotenv(['# a comment', '', 'FOO=bar', 'BAZ=qux  '].join('\n'));
    expect(parsed).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('tolerates single and double quotes around the value', () => {
    const parsed = parseDotenv('A="double"\nB=\'single\'');
    expect(parsed).toEqual({ A: 'double', B: 'single' });
  });

  it('keeps an `=` that appears inside the value', () => {
    const parsed = parseDotenv('CONN=postgres://user:pass@host/db?ssl=true');
    expect(parsed.CONN).toBe('postgres://user:pass@host/db?ssl=true');
  });

  it('skips a malformed line with no `=`', () => {
    const parsed = parseDotenv('NOT_A_LINE\nFOO=bar');
    expect(parsed).toEqual({ FOO: 'bar' });
  });
});

describe('resolution order', () => {
  it('env beats .env, .env beats the config file - first hit wins', () => {
    const root = projectRoot();
    fs.writeFileSync(path.join(root, '.env'), 'XBOOKMARKS_CLIENT_ID=from-dotenv\nOTHER=from-dotenv\n');
    const dir = configDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(dir, 'credentials.json'),
      JSON.stringify({ XBOOKMARKS_CLIENT_ID: 'from-file', OTHER: 'from-file', ONLY_IN_FILE: 'from-file' }),
      { mode: 0o600 },
    );

    const store = createCredentialStore({
      env: { XBOOKMARKS_CLIENT_ID: 'from-env' },
      projectRoot: root,
      configDir: dir,
      exec: noKeychainExec,
    });

    expect(store.get('XBOOKMARKS_CLIENT_ID')).toEqual({ value: 'from-env', source: 'env' });
    expect(store.get('OTHER')).toEqual({ value: 'from-dotenv', source: 'dotenv' });
    expect(store.get('ONLY_IN_FILE')).toEqual({ value: 'from-file', source: 'file' });
    expect(store.get('NOWHERE')).toEqual({ value: undefined, source: 'none' });
  });

  it('falls through to the keychain tier between .env and the config file', () => {
    const store = createCredentialStore({
      env: {},
      projectRoot: projectRoot(),
      configDir: configDir(),
      platform: 'darwin',
      exec: (cmd, args) => {
        if (cmd === 'security' && args[0] === 'find-generic-password') return 'from-keychain\n';
        throw new Error('unexpected exec call');
      },
    });

    expect(store.get('XBOOKMARKS_CLIENT_SECRET')).toEqual({ value: 'from-keychain', source: 'keychain' });
  });

  it('degrades gracefully when the platform keychain CLI is absent', () => {
    const store = createCredentialStore({
      env: {},
      projectRoot: projectRoot(),
      configDir: configDir(),
      platform: 'darwin',
      exec: noKeychainExec,
    });

    expect(store.get('ANYTHING')).toEqual({ value: undefined, source: 'none' });
  });
});

describe('config file permissions', () => {
  it('writes the config file 0600 and the config dir 0700', () => {
    const dir = configDir();
    const store = createCredentialStore({ env: {}, projectRoot: projectRoot(), configDir: dir, exec: noKeychainExec });

    store.set('XBOOKMARKS_CLIENT_ID', 'secret-value');

    const file = path.join(dir, 'credentials.json');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(store.get('XBOOKMARKS_CLIENT_ID')).toEqual({ value: 'secret-value', source: 'file' });
  });

  it('refuses to read a group/world-readable config file', () => {
    const dir = configDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, 'credentials.json');
    fs.writeFileSync(file, JSON.stringify({ XBOOKMARKS_CLIENT_ID: 'leaked' }), { mode: 0o644 });

    const store = createCredentialStore({ env: {}, projectRoot: projectRoot(), configDir: dir, exec: noKeychainExec });

    expect(store.get('XBOOKMARKS_CLIENT_ID')).toEqual({ value: undefined, source: 'none' });
  });

  it('set() removes a key via clear()', () => {
    const dir = configDir();
    const store = createCredentialStore({ env: {}, projectRoot: projectRoot(), configDir: dir, exec: noKeychainExec });

    store.set('XBOOKMARKS_CLIENT_SECRET', 'top-secret');
    expect(store.get('XBOOKMARKS_CLIENT_SECRET').value).toBe('top-secret');

    store.clear('XBOOKMARKS_CLIENT_SECRET');
    expect(store.get('XBOOKMARKS_CLIENT_SECRET')).toEqual({ value: undefined, source: 'none' });
  });
});

describe('missingCredentialMessage', () => {
  it('lists every chain tier and never mentions installing a specific vault', () => {
    const message = missingCredentialMessage(['XBOOKMARKS_CLIENT_ID', 'XBOOKMARKS_CLIENT_SECRET']);

    expect(message).toContain('XBOOKMARKS_CLIENT_ID');
    expect(message).toContain('XBOOKMARKS_CLIENT_SECRET');
    expect(message).toContain('environment');
    expect(message).toContain('.env');
    expect(message).toContain('keychain');
    expect(message).toContain('credentials.json');
    expect(message.toLowerCase()).not.toContain('install automic vault');
  });
});

describe('no secret leakage', () => {
  it('never includes the secret value in a thrown/warned message', () => {
    const dir = configDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, 'credentials.json');
    const secretValue = 'super-secret-value-xyz';
    fs.writeFileSync(file, JSON.stringify({ XBOOKMARKS_CLIENT_ID: secretValue }), { mode: 0o644 });

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg: string) => warnings.push(msg);
    try {
      const store = createCredentialStore({ env: {}, projectRoot: projectRoot(), configDir: dir, exec: noKeychainExec });
      store.get('XBOOKMARKS_CLIENT_ID');
    } finally {
      console.warn = originalWarn;
    }

    const message = missingCredentialMessage(['XBOOKMARKS_CLIENT_ID']);
    for (const line of [...warnings, message]) {
      expect(line).not.toContain(secretValue);
    }
  });
});

describe('the .env tier is the PACKAGE ROOT, never the working directory (security finding #3)', () => {
  it('PACKAGE_ROOT is this package, and the default .env path sits in it', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));
    expect(pkg.name).toBe('x-bookmarks-organizer');
    expect(dotenvPath()).toBe(path.join(PACKAGE_ROOT, '.env'));
  });

  it('ignores a .env planted in whatever directory the app is started from', () => {
    const hostile = path.join(tmpDir, 'hostile');
    fs.mkdirSync(hostile);
    fs.writeFileSync(
      path.join(hostile, '.env'),
      'XBOOKMARKS_CLIENT_ID=attacker-id\nOPENROUTER_API_KEY=sk-or-ATTACKERS-OWN-KEY\n',
      { mode: 0o600 },
    );
    const previous = process.cwd();
    process.chdir(hostile);
    let store;
    try {
      // No `projectRoot` - exactly how `src/index.ts` builds the real store.
      store = createCredentialStore({ env: {}, configDir: configDir(), exec: noKeychainExec });
    } finally {
      process.chdir(previous);
    }
    expect(store.get('XBOOKMARKS_CLIENT_ID').value).not.toBe('attacker-id');
    expect(store.get('OPENROUTER_API_KEY').value).not.toBe('sk-or-ATTACKERS-OWN-KEY');
  });
});

describe('env-only keys (security finding #3)', () => {
  it('names exactly the providers\' own binary and base-URL keys', () => {
    expect([...ENV_ONLY_KEYS].sort()).toEqual([CLAUDE_BIN_KEY, PIAI_LOCAL_BASE_URL_KEY].sort());
  });

  it('never resolves XBOOKMARKS_CLAUDE_BIN / XBOOKMARKS_PIAI_BASE_URL from .env, the keychain or the config file', () => {
    const root = projectRoot();
    fs.writeFileSync(
      path.join(root, '.env'),
      'XBOOKMARKS_CLAUDE_BIN=/tmp/payload\nXBOOKMARKS_PIAI_BASE_URL=http://attacker.example/v1\nOPENROUTER_API_KEY=from-dotenv\n',
      { mode: 0o600 },
    );
    const dir = configDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(dir, 'credentials.json'),
      JSON.stringify({ XBOOKMARKS_CLAUDE_BIN: '/tmp/from-file', XBOOKMARKS_PIAI_BASE_URL: 'http://file.example/v1' }),
      { mode: 0o600 },
    );
    const store = createCredentialStore({
      env: {},
      projectRoot: root,
      configDir: dir,
      platform: 'darwin',
      exec: () => 'from-keychain\n',
    });

    expect(store.get('XBOOKMARKS_CLAUDE_BIN')).toEqual({ value: undefined, source: 'none' });
    expect(store.get('XBOOKMARKS_PIAI_BASE_URL')).toEqual({ value: undefined, source: 'none' });
    // Every other key keeps the documented precedence.
    expect(store.get('OPENROUTER_API_KEY')).toEqual({ value: 'from-dotenv', source: 'dotenv' });
  });

  it('still honors them from the process environment', () => {
    const root = projectRoot();
    fs.writeFileSync(path.join(root, '.env'), 'XBOOKMARKS_CLAUDE_BIN=/tmp/payload\n', { mode: 0o600 });
    const store = createCredentialStore({
      env: { XBOOKMARKS_CLAUDE_BIN: '/opt/claude', XBOOKMARKS_PIAI_BASE_URL: 'http://127.0.0.1:11434/v1' },
      projectRoot: root,
      configDir: configDir(),
      exec: noKeychainExec,
    });
    expect(store.get('XBOOKMARKS_CLAUDE_BIN')).toEqual({ value: '/opt/claude', source: 'env' });
    expect(store.get('XBOOKMARKS_PIAI_BASE_URL')).toEqual({ value: 'http://127.0.0.1:11434/v1', source: 'env' });
  });
});

describe('.env permission warning (security finding #8)', () => {
  function captureWarnings(fn: () => void): string[] {
    const warnings: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((msg: string) => void warnings.push(msg));
    try {
      fn();
    } finally {
      spy.mockRestore();
    }
    return warnings;
  }

  it('warns, with the chmod fix, when .env is readable by group or others - and still reads it', () => {
    const root = projectRoot();
    const file = path.join(root, '.env');
    fs.writeFileSync(file, 'XBOOKMARKS_CLIENT_ID=secret-client-id-123\n');
    fs.chmodSync(file, 0o644);

    let store: ReturnType<typeof createCredentialStore> | undefined;
    const warnings = captureWarnings(() => {
      store = createCredentialStore({ env: {}, projectRoot: root, configDir: configDir(), platform: 'darwin', exec: noKeychainExec });
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(file);
    expect(warnings[0]).toContain('mode 644');
    expect(warnings[0]).toContain(`chmod 600 ${file}`);
    expect(warnings[0]).not.toContain('secret-client-id-123');
    // A warning, not a refusal: `cp .env.example .env` is 0644 under a normal umask.
    expect(store!.get('XBOOKMARKS_CLIENT_ID')).toEqual({ value: 'secret-client-id-123', source: 'dotenv' });
    expect(dotenvPermissionWarning(file, 'darwin')).toBe(warnings[0].replace(/^Warning: /, ''));
    expect(dotenvExposure(file, 'darwin')).toEqual({ file, mode: '644' });
  });

  it('is silent for an owner-only .env, a missing .env, and on Windows', () => {
    const root = projectRoot();
    const file = path.join(root, '.env');
    expect(dotenvPermissionWarning(file, 'darwin')).toBeNull();
    fs.writeFileSync(file, 'A=b\n');
    fs.chmodSync(file, 0o600);
    expect(dotenvPermissionWarning(file, 'darwin')).toBeNull();
    const warnings = captureWarnings(() => {
      createCredentialStore({ env: {}, projectRoot: root, configDir: configDir(), platform: 'darwin', exec: noKeychainExec });
    });
    expect(warnings).toEqual([]);
    fs.chmodSync(file, 0o640);
    expect(dotenvPermissionWarning(file, 'darwin')).toContain('mode 640');
    expect(dotenvExposure(file, 'darwin')).toEqual({ file, mode: '640' });
    expect(dotenvPermissionWarning(file, 'win32')).toBeNull();
    expect(dotenvExposure(file, 'win32')).toBeNull();
  });
});
