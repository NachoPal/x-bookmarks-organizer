import { spawn, spawnSync } from 'node:child_process';
import type { ArticleContext } from '../articles/link-metadata';
import type { Assignment, RawBookmark } from '../types';
import { buildExtendPrompt, buildPrompt, parseAssignments } from './prompt';

/**
 * How the assignment pass treats the tree it is given:
 * - `strict`: the tree is fixed (designed by pass 1); off-tree paths are dropped.
 * - `extend`: incremental runs may create a new node when nothing existing fits.
 */
export type AssignMode = 'strict' | 'extend';

/**
 * A function that runs a single prompt against an LLM and returns its raw text
 * response. Abstracted so the real `claude` CLI can be swapped for a fake in
 * tests (no network, no subscription usage).
 */
export type LlmRunner = (prompt: string) => Promise<string>;

export interface CategorizerOptions {
  model: string;
  maxDepth: number;
}

/**
 * Turns a batch of bookmarks into category assignments against the current tree.
 * The ingestion loop depends on this interface so a fake can be injected in
 * tests with no network and no subscription usage.
 */
export interface BatchCategorizer {
  categorizeBatch(
    bookmarks: RawBookmark[],
    treeText: string,
    mode?: AssignMode,
    articleContext?: Map<string, ArticleContext>,
  ): Promise<Assignment[]>;
}

/**
 * Run a prompt through the `claude` CLI in headless/print mode.
 *
 * Authentication is the Claude *subscription* via `CLAUDE_CODE_OAUTH_TOKEN`
 * (inherited from the environment) - NOT the paid Anthropic API. We never set
 * `ANTHROPIC_API_KEY`; to be safe we strip it from the child environment so a
 * stray value can never cause paid billing.
 */
export interface ClaudeCliOptions {
  /**
   * Reasoning effort for this call, passed through as the CLI `--effort` flag
   * (low|medium|high|xhigh|max). Omitted when undefined so the CLI default
   * applies.
   */
  effort?: string;
  /** Override the `claude` binary (defaults to `claude` on PATH). */
  claudeBin?: string;
}

/**
 * Cheap capability probe: does the `claude` binary resolve on PATH and run at
 * all? This only proves the binary is present and executable - not that it is
 * authenticated. A user with the CLI installed has, by definition, logged in
 * to it already; a genuine auth failure still surfaces at call time with a
 * clear error rather than being pre-guessed here.
 */
export function isClaudeCliAvailable(claudeBin = 'claude'): boolean {
  const result = spawnSync(claudeBin, ['--version'], { stdio: 'ignore', timeout: 5000 });
  return result.error === undefined && result.status === 0;
}

/**
 * Whether Claude is usable at all right now: either a token is configured
 * (for a headless box with no interactive `claude` login), or the CLI itself
 * resolves and runs. This is the single gate every LLM feature (summaries,
 * categorization, future features) should check instead of requiring a token
 * outright.
 */
export function isClaudeAvailable(
  config: { claudeToken?: string },
  probe: () => boolean = isClaudeCliAvailable,
): boolean {
  return Boolean(config.claudeToken) || probe();
}

export function createClaudeCliRunner(model: string, options: ClaudeCliOptions = {}): LlmRunner {
  const claudeBin = options.claudeBin ?? 'claude';
  return (prompt: string) =>
    new Promise<string>((resolve, reject) => {
      const env = { ...process.env };
      delete env.ANTHROPIC_API_KEY;

      const args = ['-p', '--output-format', 'json', '--model', model];
      if (options.effort) args.push('--effort', options.effort);

      const child = spawn(claudeBin, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d.toString()));
      child.stderr.on('data', (d) => (stderr += d.toString()));
      child.on('error', (err) =>
        reject(new Error(`Failed to launch "${claudeBin}": ${err.message}`)),
      );
      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`claude CLI exited with code ${code}: ${stderr.trim()}`));
          return;
        }
        try {
          // `--output-format json` prints an envelope with the text in `result`.
          const envelope = JSON.parse(stdout) as { result?: unknown; is_error?: boolean };
          if (envelope.is_error) {
            reject(new Error(`claude CLI reported an error: ${stdout.slice(0, 300)}`));
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

      child.stdin.write(prompt);
      child.stdin.end();
    });
}

/**
 * Turns batches of bookmarks into category assignments by prompting an LLM.
 * Pure orchestration around an injected {@link LlmRunner}.
 */
export class Categorizer implements BatchCategorizer {
  constructor(
    private readonly runner: LlmRunner,
    private readonly options: CategorizerOptions,
  ) {}

  /**
   * Categorize a batch of bookmarks against the current tree (rendered as
   * text). Returns one assignment per bookmark the model classified. `mode`
   * selects the strict (fixed-tree) or extend (reuse-or-create) prompt.
   */
  async categorizeBatch(
    bookmarks: RawBookmark[],
    treeText: string,
    mode: AssignMode = 'strict',
    articleContext?: Map<string, ArticleContext>,
  ): Promise<Assignment[]> {
    if (bookmarks.length === 0) return [];
    const prompt =
      mode === 'extend'
        ? buildExtendPrompt(bookmarks, treeText, this.options.maxDepth, articleContext)
        : buildPrompt(bookmarks, treeText, this.options.maxDepth, articleContext);
    const response = await this.runner(prompt);
    const validIds = new Set(bookmarks.map((b) => b.postId));
    return parseAssignments(response, validIds, this.options.maxDepth);
  }
}
