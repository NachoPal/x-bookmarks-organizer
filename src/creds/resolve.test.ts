import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCredentialStore, missingCredentialMessage, parseDotenv } from './resolve';

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
