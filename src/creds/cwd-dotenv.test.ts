import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCredentialStore } from './resolve';
import { loadConfig } from '../config';
import { createLlmFactory } from '../llm/factory';
import '../llm/providers';

/**
 * Regression for security finding #3, adapted from the review's
 * `repro-dotenv-cwd.ts`: the owner runs `xbo serve` from a directory someone
 * else controls, which holds a `.env` naming a payload as the `claude` binary,
 * an attacker's base URL and the attacker's own API key. Before the fix the
 * summary preflight ran the payload as the owner and every key came from that
 * file. Offline: `PATH` is pointed at an empty directory for the probe, so the
 * fallback `claude` resolves to nothing and no real binary is ever spawned.
 */
let hostile: string;
let emptyBin: string;

beforeEach(() => {
  hostile = fs.mkdtempSync(path.join(os.tmpdir(), 'xbo-hostile-'));
  emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), 'xbo-empty-bin-'));
});

afterEach(() => {
  fs.rmSync(hostile, { recursive: true, force: true });
  fs.rmSync(emptyBin, { recursive: true, force: true });
});

describe('a .env in the working directory (security finding #3)', () => {
  it('cannot choose the claude binary, the pi-ai base URL, or an upstream key', async () => {
    const marker = path.join(hostile, 'PWNED');
    const payload = path.join(hostile, 'claude');
    fs.writeFileSync(payload, `#!/bin/sh\necho "arbitrary code ran with args: $*" >> "${marker}"\nexit 0\n`);
    fs.chmodSync(payload, 0o755);
    fs.writeFileSync(
      path.join(hostile, '.env'),
      `XBOOKMARKS_CLAUDE_BIN=${payload}\nXBOOKMARKS_PIAI_BASE_URL=http://attacker.example/v1\n` +
        'OPENROUTER_API_KEY=sk-or-ATTACKERS-OWN-KEY\n',
    );

    const previousCwd = process.cwd();
    process.chdir(hostile);
    let store;
    try {
      // Exactly `src/index.ts`'s store - no `projectRoot` - with a scratch
      // config dir and no keychain so the owner's real ones are never read.
      store = createCredentialStore({
        env: {},
        configDir: path.join(hostile, 'config'),
        exec: () => {
          throw new Error('no keychain in tests');
        },
      });
    } finally {
      process.chdir(previousCwd);
    }

    expect(store.get('XBOOKMARKS_CLAUDE_BIN').source).not.toBe('dotenv');
    expect(store.get('XBOOKMARKS_PIAI_BASE_URL').source).not.toBe('dotenv');
    expect(store.get('OPENROUTER_API_KEY').value).not.toBe('sk-or-ATTACKERS-OWN-KEY');

    const previousPath = process.env.PATH;
    process.env.PATH = emptyBin;
    try {
      const llm = createLlmFactory(loadConfig({}, store), {}, store);
      await llm.check('summary');
    } finally {
      process.env.PATH = previousPath;
    }
    expect(fs.existsSync(marker)).toBe(false);
  });
});
