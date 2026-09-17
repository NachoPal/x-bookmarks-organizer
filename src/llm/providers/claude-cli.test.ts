import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../config';
import { createLlmFactory } from '../factory';
import { toRunner } from '../runner';
import { claudeCliProvider, redactError } from './claude-cli';
import type { ResolvedProviderConfig } from '../types';

/**
 * These tests never run the real `claude` CLI: every case points
 * `XBOOKMARKS_CLAUDE_BIN` at a throwaway stub script, so the adapter's spawn
 * behavior (flags, env, envelope parsing, failure handling) is exercised end to
 * end offline, with no network and no subscription usage.
 */
let binDir: string;

/** What a successful stub echoes back, so the test can assert what the adapter spawned. */
interface Echo {
  argv: string[];
  prompt: string;
  anthropicApiKey: string | null;
  claudeToken: string | null;
}

function writeStub(name: string, body: string): string {
  const file = path.join(binDir, name);
  fs.writeFileSync(file, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  return file;
}

beforeAll(() => {
  binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbo-claude-stub-'));

  // Echoes its argv, stdin and the credential-relevant env back through the
  // same `--output-format json` envelope the real CLI prints.
  writeStub(
    'claude-ok',
    `
let stdin = '';
process.stdin.on('data', (d) => (stdin += d));
process.stdin.on('end', () => {
  if (process.argv[2] === '--version') { console.log('9.9.9 (stub)'); process.exit(0); }
  const echo = {
    argv: process.argv.slice(2),
    prompt: stdin,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? null,
    claudeToken: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null,
  };
  console.log(JSON.stringify({ type: 'result', is_error: false, result: JSON.stringify(echo) }));
});
if (process.argv[2] === '--version') { console.log('9.9.9 (stub)'); process.exit(0); }
`,
  );

  // Resolves and runs, but every prompt fails - and leaks a secret-shaped token
  // on stderr, which must not reach the caller.
  writeStub(
    'claude-broken',
    `
if (process.argv[2] === '--version') { console.log('9.9.9 (stub)'); process.exit(0); }
process.stderr.write('Invalid API key sk-ant-abcdefghijklmnopqrstuvwxyz0123 - run /login');
process.exit(1);
`,
  );

  // Installed but not usable: the version probe itself fails.
  writeStub('claude-sick', `process.stderr.write('boom'); process.exit(2);`);
});

afterAll(() => {
  fs.rmSync(binDir, { recursive: true, force: true });
});

function cfgWith(bin: string, extra: Record<string, string> = {}): ResolvedProviderConfig {
  const env: Record<string, string> = { XBOOKMARKS_CLAUDE_BIN: path.join(binDir, bin), ...extra };
  return { get: (key) => env[key] };
}

async function echoOf(bin: string, model = 'claude-haiku-4-5', params = {}): Promise<Echo> {
  const client = claudeCliProvider.create(cfgWith(bin), { model, params });
  const result = await client.complete({ prompt: 'hello world' });
  return JSON.parse(result.text) as Echo;
}

describe('claude-cli check()', () => {
  it('reports ok when the binary resolves and runs - no token required (issue #35)', async () => {
    const health = await claudeCliProvider.check(cfgWith('claude-ok'));
    expect(health.state).toBe('ok');
    // The false negative this replaces: availability must not depend on a token.
    const withoutToken = await claudeCliProvider.check(cfgWith('claude-ok'));
    expect(withoutToken.state).toBe('ok');
  });

  it('reports unconfigured, with an actionable message, when the binary is missing', async () => {
    const health = await claudeCliProvider.check(cfgWith('does-not-exist'));
    expect(health.state).toBe('unconfigured');
    expect(health.detail).toMatch(/claude` CLI was not found/);
    expect(health.detail).toContain('XBOOKMARKS_CLAUDE_BIN');
  });

  it('reports unavailable when the binary is there but fails to run', async () => {
    const health = await claudeCliProvider.check(cfgWith('claude-sick'));
    expect(health.state).toBe('unavailable');
    expect(health.detail).toMatch(/exited with code 2/);
  });
});

describe('claude-cli complete()', () => {
  it('sends the prompt on stdin and returns the JSON envelope result', async () => {
    const echo = await echoOf('claude-ok');
    expect(echo.prompt).toBe('hello world');
  });

  it('hardens the spawn so project memory and the tool set never enter the prompt', async () => {
    const { argv } = await echoOf('claude-ok');
    expect(argv.slice(0, 5)).toEqual(['-p', '--output-format', 'json', '--model', 'claude-haiku-4-5']);
    expect(argv).toContain('--safe-mode');
    expect(argv).toContain('--max-turns');
    // `--tools ""` = no tools at all, which is what closes the path from
    // attacker-authored bookmark text to the filesystem.
    expect(argv[argv.indexOf('--tools') + 1]).toBe('');
  });

  it('passes a valid effort through and falls back on an unknown one', async () => {
    const good = await echoOf('claude-ok', 'm', { effort: 'MAX' });
    expect(good.argv[good.argv.indexOf('--effort') + 1]).toBe('max');
    const bogus = await echoOf('claude-ok', 'm', { effort: 'turbo' });
    expect(bogus.argv[bogus.argv.indexOf('--effort') + 1]).toBe('high');
    const none = await echoOf('claude-ok', 'm', {});
    expect(none.argv).not.toContain('--effort');
  });

  it('strips ANTHROPIC_API_KEY from the child env - this adapter is subscription-only', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-should-never-be-inherited';
    try {
      const echo = await echoOf('claude-ok');
      expect(echo.anthropicApiKey).toBeNull();
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('passes a configured subscription token on the child env only', async () => {
    const client = claudeCliProvider.create(
      cfgWith('claude-ok', { CLAUDE_CODE_OAUTH_TOKEN: 'tok-123' }),
      { model: 'm' },
    );
    const echo = JSON.parse((await client.complete({ prompt: 'p' })).text) as Echo;
    expect(echo.claudeToken).toBe('tok-123');
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).not.toBe('tok-123');
  });

  it('fails with an actionable, secret-free message when the call fails', async () => {
    const client = claudeCliProvider.create(cfgWith('claude-broken'), { model: 'm' });
    await expect(client.complete({ prompt: 'p' })).rejects.toThrow(/Couldn't reach Claude/);
    await expect(client.complete({ prompt: 'p' })).rejects.toThrow(
      /claude` CLI is installed and logged in/,
    );
    const err = await client.complete({ prompt: 'p' }).catch((e: Error) => e.message);
    expect(err).not.toContain('sk-ant-abcdefghijklmnopqrstuvwxyz0123');
    expect(err).toContain('[redacted]');
  });

  it('fails the same way when the binary is not installed at all', async () => {
    const client = claudeCliProvider.create(cfgWith('does-not-exist'), { model: 'm' });
    await expect(client.complete({ prompt: 'p' })).rejects.toThrow(/Couldn't reach Claude/);
  });
});

describe('redactError', () => {
  it('removes api keys and bearer tokens and bounds the length', () => {
    expect(redactError('key sk-ant-abcdefghijklmnopqrstuv here')).toBe('key [redacted] here');
    expect(redactError('Authorization: Bearer abc.def.ghi')).toBe(
      'Authorization: Bearer [redacted]',
    );
    expect(redactError('x'.repeat(500)).length).toBe(300);
  });
});

describe('the whole seam, end to end and offline', () => {
  it('resolves each role from config through the factory to a hardened CLI call', async () => {
    const env = { XBOOKMARKS_CLAUDE_BIN: path.join(binDir, 'claude-ok') };
    const llm = createLlmFactory(loadConfig(env), env);

    expect((await llm.check('summary')).state).toBe('ok');

    const taxonomy = JSON.parse(await toRunner(llm.forRole('taxonomy'), { json: true })('t')) as Echo;
    expect(taxonomy.argv[taxonomy.argv.indexOf('--model') + 1]).toBe('claude-opus-4-8');
    expect(taxonomy.argv[taxonomy.argv.indexOf('--effort') + 1]).toBe('high');

    const summary = JSON.parse(await toRunner(llm.forRole('summary'))('s')) as Echo;
    expect(summary.argv[summary.argv.indexOf('--model') + 1]).toBe('claude-haiku-4-5');
    expect(summary.argv).toContain('--safe-mode');
    expect(summary.argv).not.toContain('--effort');
  });
});
