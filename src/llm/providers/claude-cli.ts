import { spawn } from 'node:child_process';
import type {
  CompletionRequest,
  CompletionResult,
  Health,
  LlmClient,
  ProviderDefinition,
  ProviderParams,
  ResolvedProviderConfig,
} from '../types';

/** Provider id, and the default value of `XBOOKMARKS_LLM_PROVIDER`. */
export const CLAUDE_CLI_PROVIDER_ID = 'claude-cli';

/** Env key naming the `claude` binary, for a non-PATH install (and the offline test seam). */
export const CLAUDE_BIN_KEY = 'XBOOKMARKS_CLAUDE_BIN';

/** Env key holding the Claude *subscription* token. Optional: a logged-in CLI needs no token. */
export const CLAUDE_TOKEN_KEY = 'CLAUDE_CODE_OAUTH_TOKEN';

/** Effort levels the `claude` CLI accepts for `--effort`. */
const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/** Applied when an effort level is requested but not one the CLI knows. */
const DEFAULT_EFFORT = 'high';

/** How long the availability probe waits for `claude --version` before giving up. */
const VERSION_PROBE_TIMEOUT_MS = 10_000;

/** What the owner is told when the binary is not there. */
const NOT_INSTALLED_DETAIL =
  'The `claude` CLI was not found. Install it and run `claude` once to log in, ' +
  `or point ${CLAUDE_BIN_KEY} at the binary.`;

/**
 * Flags that make `claude -p` behave like a completion call instead of an agent.
 *
 * `--safe-mode` stops the CLI auto-loading whatever `CLAUDE.md` / `AGENTS.md`
 * happens to sit in the working directory (which otherwise lands inside every
 * categorization prompt, making results a function of an unrelated repo's
 * config), and `--tools ""` removes the tool definitions *and* the agent's
 * ability to touch the filesystem - closing the path from attacker-authored
 * bookmark text to file reads. `--max-turns 1` keeps it single-shot.
 * Measured effect: ~29.7k -> ~3.9k tokens of context per call, no behavior loss.
 */
const HARDENING_ARGS = ['--safe-mode', '--tools', '', '--max-turns', '1'];

/** Normalize a requested effort level; an unknown one falls back rather than failing the run. */
function normalizeEffort(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim().toLowerCase();
  if (!value) return undefined;
  return VALID_EFFORTS.has(value) ? value : DEFAULT_EFFORT;
}

/**
 * Make an adapter failure safe to show a user: no secrets, bounded length.
 * CLI stderr is untrusted output that reaches the viewer through the summary
 * endpoint, so it is scrubbed here rather than at the call site.
 */
export function redactError(raw: string): string {
  return raw
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, '[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

/** The message a failed call surfaces - actionable, and identical wherever it is shown. */
function callFailureMessage(detail: string): string {
  const suffix = 'Make sure the `claude` CLI is installed and logged in (`claude` once, interactively).';
  const redacted = redactError(detail);
  return redacted ? `Couldn't reach Claude: ${redacted}. ${suffix}` : `Couldn't reach Claude. ${suffix}`;
}

function binFrom(cfg: ResolvedProviderConfig): string {
  return cfg.get(CLAUDE_BIN_KEY)?.trim() || 'claude';
}

/**
 * Build the child environment.
 *
 * `process.env` is inherited so the CLI finds PATH/HOME and its own logged-in
 * session, but `ANTHROPIC_API_KEY` is stripped: this adapter is
 * subscription-only by construction, and a stray key must never be able to
 * cause paid billing.
 */
function childEnv(cfg: ResolvedProviderConfig): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  const token = cfg.get(CLAUDE_TOKEN_KEY);
  if (token) env[CLAUDE_TOKEN_KEY] = token;
  return env;
}

/**
 * Availability is "does the binary resolve and run" - NOT "is a token set".
 * A CLI the owner logged into interactively needs no token at all, so keying
 * availability on `CLAUDE_CODE_OAUTH_TOKEN` reports a false negative (issue #35).
 * This probe spends no quota.
 */
async function checkClaudeCli(cfg: ResolvedProviderConfig): Promise<Health> {
  const claudeBin = binFrom(cfg);
  return new Promise<Health>((resolve) => {
    let settled = false;
    const done = (health: Health) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(health);
    };

    const child = spawn(claudeBin, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      child.kill();
      done({
        state: 'unavailable',
        detail: `\`${claudeBin} --version\` did not respond within ${VERSION_PROBE_TIMEOUT_MS / 1000}s.`,
      });
    }, VERSION_PROBE_TIMEOUT_MS);

    let stderr = '';
    child.stderr?.on('data', (d) => (stderr += d.toString()));
    child.on('error', () => done({ state: 'unconfigured', detail: NOT_INSTALLED_DETAIL }));
    child.on('close', (code) => {
      if (code === 0) {
        done({ state: 'ok', detail: 'The `claude` CLI is available (Claude subscription).' });
        return;
      }
      done({
        state: 'unavailable',
        detail: `\`${claudeBin} --version\` exited with code ${code}. ${redactError(stderr)}`.trim(),
      });
    });
  });
}

/** Run one prompt through `claude -p`, hardened, and return the envelope's text. */
function runPrompt(
  cfg: ResolvedProviderConfig,
  model: string,
  params: ProviderParams,
  req: CompletionRequest,
): Promise<string> {
  const claudeBin = binFrom(cfg);
  return new Promise<string>((resolve, reject) => {
    const args = ['-p', '--output-format', 'json', '--model', model, ...HARDENING_ARGS];
    const effort = normalizeEffort(params.effort);
    if (effort) args.push('--effort', effort);
    if (req.system) args.push('--system-prompt', req.system);

    const child = spawn(claudeBin, args, { env: childEnv(cfg), stdio: ['pipe', 'pipe', 'pipe'] });

    const onAbort = () => child.kill();
    req.signal?.addEventListener('abort', onAbort, { once: true });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => {
      req.signal?.removeEventListener('abort', onAbort);
      reject(new Error(callFailureMessage(`failed to launch "${claudeBin}" (${err.message})`)));
    });
    child.on('close', (code) => {
      req.signal?.removeEventListener('abort', onAbort);
      if (code !== 0) {
        reject(new Error(callFailureMessage(`the CLI exited with code ${code}: ${stderr.trim()}`)));
        return;
      }
      try {
        // `--output-format json` prints an envelope with the text in `result`.
        const envelope = JSON.parse(stdout) as { result?: unknown; is_error?: boolean };
        if (envelope.is_error) {
          reject(new Error(callFailureMessage(`the CLI reported an error: ${stdout.slice(0, 300)}`)));
          return;
        }
        if (typeof envelope.result === 'string') {
          resolve(envelope.result);
          return;
        }
        resolve(stdout);
      } catch {
        // Not JSON (older CLI or plain text) - use raw stdout.
        resolve(stdout);
      }
    });

    child.stdin.write(req.prompt);
    child.stdin.end();
  });
}

/**
 * The Claude Code subscription, driven through the local `claude` CLI in print
 * mode. Billing is `subscription`: calls consume the owner's Claude plan and
 * never the paid Anthropic API.
 */
export const claudeCliProvider: ProviderDefinition = {
  id: CLAUDE_CLI_PROVIDER_ID,
  label: 'Claude Code subscription (local `claude` CLI)',
  billing: 'subscription',
  configKeys: [
    {
      key: CLAUDE_TOKEN_KEY,
      required: false,
      description:
        'Claude subscription token. Optional - a CLI you have logged into interactively works without it.',
      secret: true,
    },
    {
      key: CLAUDE_BIN_KEY,
      required: false,
      description: 'Path to the `claude` binary when it is not on PATH.',
      secret: false,
    },
  ],
  models: [
    {
      id: 'claude-opus-4-8',
      label: 'Claude Opus 4.8',
      suggestedFor: ['taxonomy'],
      maxInputTokens: 200_000,
    },
    {
      id: 'claude-haiku-4-5',
      label: 'Claude Haiku 4.5',
      suggestedFor: ['assignment', 'summary', 'chat'],
      maxInputTokens: 200_000,
    },
  ],
  capabilities: { jsonMode: false, effort: true, temperature: false, streaming: false },
  check: checkClaudeCli,
  create(cfg, opts): LlmClient {
    const params = opts.params ?? {};
    return {
      providerId: CLAUDE_CLI_PROVIDER_ID,
      model: opts.model,
      billing: 'subscription',
      async complete(req): Promise<CompletionResult> {
        const text = await runPrompt(cfg, opts.model, params, req);
        return { text, model: opts.model, providerId: CLAUDE_CLI_PROVIDER_ID };
      },
    };
  },
};
