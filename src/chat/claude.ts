import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpSdkServerConfigWithInstance, Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { MCP_TOOL_NAMES, type McpToolName } from '../mcp/tools';
import type { ChatEffort } from './catalog';

/**
 * The in-app "Ask Claude" chat's one model call: Claude Code, driven through
 * the Claude Agent SDK, on the owner's Claude SUBSCRIPTION login - Anthropic's
 * own binary, like the `claude-cli` provider (`AGENTS.md`'s hard constraints).
 *
 * Everything that makes a reply a function of this app alone is set here and
 * pinned by `claude.test.ts`: no settings, CLAUDE.md, skills or MCP servers of
 * the owner's own Claude Code are loaded (`settingSources: []`,
 * `strictMcpConfig: true`), none of Claude Code's built-in tools is offered
 * (`tools: []` - no shell, files or web), the ONLY tools are this app's MCP
 * tools served in-process, each pre-approved by name, and anything else is
 * denied without asking (`permissionMode: 'dontAsk'`) because there is no one
 * to ask.
 */

/** The SDK's `query`, injectable so tests (and the offline demo) drive the chat without starting Claude Code. */
export type QueryFn = (params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => AsyncIterable<SDKMessage>;

/**
 * API-billing settings removed from Claude Code's environment so it always
 * runs on the owner's subscription login: with any of them set, Claude Code
 * would bill per token instead - through an API key, a cloud provider
 * (Bedrock, Vertex, Foundry) or another gateway. The OAuth login on disk and
 * `CLAUDE_CODE_OAUTH_TOKEN` are kept, because they ARE the subscription.
 */
export const API_CREDENTIAL_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
] as const;

/**
 * The environment for the Claude Code child. The SDK's `env` option REPLACES
 * the inherited environment, so this is a full copy minus the API
 * credentials; `process.env` itself is never touched. A subscription token
 * the credential chain resolved (`.env`, keychain, ...) is passed on the same
 * way the `claude-cli` adapter passes it.
 */
export function subscriptionEnv(env: NodeJS.ProcessEnv = process.env, oauthToken?: string): Record<string, string> {
  const blocked = new Set<string>(API_CREDENTIAL_ENV_VARS);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !blocked.has(name)) out[name] = value;
  }
  if (oauthToken) out.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
  out.CLAUDE_AGENT_SDK_CLIENT_APP = 'x-bookmarks-organizer';
  return out;
}

/** The name Claude Code knows the in-process server by; its tools are `mcp__xbookmarks__<tool>`. */
export const CHAT_MCP_SERVER = 'xbookmarks';
const TOOL_PREFIX = `mcp__${CHAT_MCP_SERVER}__`;

/** Every tool the chat may call without asking: exactly the MCP endpoint's tools, nothing of Claude Code's own. */
export const CHAT_ALLOWED_TOOLS: readonly string[] = MCP_TOOL_NAMES.map((name) => `${TOOL_PREFIX}${name}`);

/**
 * A guard against a runaway tool loop: a reply that has not answered after
 * this many model turns is cut off rather than burning the owner's quota.
 */
export const CHAT_MAX_TURNS = 30;

export type ChatErrorKind = 'login' | 'not-installed' | 'model' | 'limit' | 'unavailable' | 'failed' | 'stopped';

/** A failed reply, worded for the owner: what went wrong and how to fix it. `detail` is for the server log only. */
export class ChatError extends Error {
  constructor(
    readonly kind: ChatErrorKind,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'ChatError';
  }
}

export const CHAT_LOGIN_MESSAGE =
  'Claude Code is not logged in, or its login has expired. Open a terminal, run "claude", type /login and sign in ' +
  'with your Claude subscription, then send your message again.';

/** One of the app's tools as the chat shows it: a chip under the reply. */
export interface ChatToolActivity {
  tool: McpToolName;
  label: string;
  status: 'done' | 'failed';
  /** The list `show_in_app` created, so the chip can open it. */
  listId?: number;
}

export interface ReplyRequest {
  prompt: string;
  systemPrompt: string;
  model: string;
  effort: ChatEffort;
  /** The app's MCP server (`createMcpServer`), served to Claude Code in-process - one fresh instance per reply. */
  mcpServer: McpServer;
  signal: AbortSignal;
  /** The environment the child inherits from; defaults to `process.env`. A test seam. */
  env?: NodeJS.ProcessEnv;
  /** `CLAUDE_CODE_OAUTH_TOKEN` as the credential chain resolved it, when it did. */
  oauthToken?: string;
  onText: (text: string) => void;
  /** What Claude is doing right now ("Searching bookmarks…"), for the working indicator. */
  onStep?: (step: string) => void;
  /** Called once each tool call has its answer. */
  onTool?: (activity: ChatToolActivity) => void;
}

/** What the working indicator says while a tool call runs. */
export function toolStep(name: string): string {
  switch (name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name) {
    case 'search_bookmarks':
      return 'Searching bookmarks…';
    case 'get_bookmark':
      return 'Reading a post…';
    case 'list_categories':
      return 'Reading your categories…';
    case 'list_category_bookmarks':
      return 'Reading a category…';
    case 'library_stats':
      return 'Counting your library…';
    case 'list_lists':
    case 'get_list':
      return 'Reading your lists…';
    case 'show_in_app':
      return 'Showing posts in the app…';
    default:
      return 'Working…';
  }
}

function quoted(raw: unknown): string {
  const line = String(raw ?? '').replace(/\s+/g, ' ').trim();
  return `"${line.length > 60 ? `${line.slice(0, 59)}…` : line}"`;
}

/** The chip's words for a finished call, from what Claude asked for. */
function toolLabel(tool: McpToolName, input: Record<string, unknown>): string {
  switch (tool) {
    case 'search_bookmarks':
      return typeof input.query === 'string' && input.query.trim()
        ? `Searched bookmarks for ${quoted(input.query)}`
        : 'Searched bookmarks';
    case 'get_bookmark':
      return 'Read a post';
    case 'list_categories':
      return 'Read your categories';
    case 'list_category_bookmarks':
      return input.category !== undefined ? `Read category ${quoted(input.category)}` : 'Read a category';
    case 'library_stats':
      return 'Counted your library';
    case 'list_lists':
      return 'Read your lists';
    case 'get_list':
      return 'Read a list';
    case 'show_in_app': {
      const n = Array.isArray(input.postIds) ? input.postIds.length : 0;
      const title = typeof input.title === 'string' && input.title.trim() ? ` as ${quoted(input.title)}` : '';
      return `Showing ${n} post${n === 1 ? '' : 's'} in the app${title}`;
    }
  }
}

function toolOf(name: string): McpToolName | null {
  if (!name.startsWith(TOOL_PREFIX)) return null;
  const tool = name.slice(TOOL_PREFIX.length);
  return (MCP_TOOL_NAMES as readonly string[]).includes(tool) ? (tool as McpToolName) : null;
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => ((part as { type?: unknown }).type === 'text' ? String((part as { text?: unknown }).text ?? '') : ''))
    .join('');
}

/** `show_in_app`'s answer names the list it made (`listId`); anything unreadable is no list. */
function madeListId(content: unknown): number | undefined {
  try {
    const id = (JSON.parse(resultText(content)) as { listId?: unknown }).listId;
    return typeof id === 'number' && Number.isInteger(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

/** The SDK options for one reply. Exported so the test pins every one of them. */
export function replyOptions(request: ReplyRequest, abortController: AbortController, stderr: string[]): Options {
  return {
    model: request.model,
    effort: request.effort,
    systemPrompt: request.systemPrompt,
    // None of Claude Code's own tools: no shell, no files, no web.
    tools: [],
    settingSources: [],
    persistSession: false,
    includePartialMessages: true,
    maxTurns: CHAT_MAX_TURNS,
    mcpServers: {
      [CHAT_MCP_SERVER]: {
        type: 'sdk',
        name: CHAT_MCP_SERVER,
        // The same class from the SDK's CommonJS build, which TypeScript tells
        // apart from its ESM twin by a private field; the Agent SDK only calls
        // `instance.connect(transport)` on it.
        instance: request.mcpServer as unknown as McpSdkServerConfigWithInstance['instance'],
      },
    },
    // Only the server given here: none of the owner's own Claude Code MCP servers.
    strictMcpConfig: true,
    allowedTools: [...CHAT_ALLOWED_TOOLS],
    // A tool that is not pre-approved is denied, never asked about.
    permissionMode: 'dontAsk',
    env: subscriptionEnv(request.env, request.oauthToken),
    abortController,
    stderr: (line) => {
      stderr.push(line);
      if (stderr.length > 30) stderr.shift();
    },
  };
}

/**
 * Ask Claude Code for one reply, streaming its text through `onText` as it is
 * written, and return the whole reply. Throws a {@link ChatError} on any
 * failure, including `stopped` when `signal` aborts.
 */
export async function streamReply(run: QueryFn, request: ReplyRequest): Promise<string> {
  if (request.signal.aborted) throw new ChatError('stopped', 'Stopped.');
  const abortController = new AbortController();
  const abort = () => abortController.abort();
  request.signal.addEventListener('abort', abort, { once: true });
  const stderr: string[] = [];
  try {
    return await runReply(run, request, replyOptions(request, abortController, stderr), stderr);
  } finally {
    request.signal.removeEventListener('abort', abort);
  }
}

async function runReply(run: QueryFn, request: ReplyRequest, options: Options, stderr: string[]): Promise<string> {
  let streamed = '';
  /** Text that came in several blocks (tool calls between them), which `result` alone would cut to the last one. */
  let separated = false;
  let assistantError: string | undefined;
  /** Tool calls waiting for their answer, by tool use id. */
  const calls = new Map<string, { tool: McpToolName; label: string }>();
  try {
    for await (const message of run({ prompt: request.prompt, options })) {
      if (message.type === 'stream_event') {
        if (message.parent_tool_use_id) continue;
        const event = message.event;
        if (event.type === 'content_block_start') {
          const kind = event.content_block.type;
          if (kind === 'thinking' || kind === 'redacted_thinking') request.onStep?.('Thinking…');
          else if (kind === 'text') request.onStep?.('Writing…');
          else if (kind === 'tool_use' || kind === 'server_tool_use' || kind === 'mcp_tool_use') {
            request.onStep?.(toolStep((event.content_block as { name?: string }).name ?? ''));
          }
          if (kind === 'text' && streamed) {
            // Text written after a tool call is a new paragraph, not a continuation.
            separated = true;
            streamed += '\n\n';
            request.onText('\n\n');
          }
        } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          streamed += event.delta.text;
          request.onText(event.delta.text);
        }
      } else if (message.type === 'assistant') {
        if (message.error) assistantError = message.error;
        if (message.parent_tool_use_id) continue;
        for (const block of message.message.content) {
          if (block.type !== 'tool_use') continue;
          const tool = toolOf(block.name);
          if (tool) calls.set(block.id, { tool, label: toolLabel(tool, (block.input ?? {}) as Record<string, unknown>) });
        }
      } else if (message.type === 'user' && Array.isArray(message.message.content)) {
        if (message.parent_tool_use_id) continue;
        let answered = false;
        for (const block of message.message.content) {
          if (block.type !== 'tool_result') continue;
          answered = true;
          const call = calls.get(block.tool_use_id);
          if (!call) continue;
          calls.delete(block.tool_use_id);
          const failed = block.is_error === true;
          const listId = !failed && call.tool === 'show_in_app' ? madeListId(block.content) : undefined;
          request.onTool?.({ ...call, status: failed ? 'failed' : 'done', ...(listId !== undefined ? { listId } : {}) });
        }
        // A tool answered: Claude reads it before writing or calling the next one.
        if (answered) request.onStep?.('Thinking…');
      } else if (message.type === 'auth_status' && message.error) {
        throw new ChatError('login', CHAT_LOGIN_MESSAGE, message.error);
      } else if (message.type === 'result') {
        if (message.subtype === 'success' && !message.is_error) {
          if (request.signal.aborted) throw new ChatError('stopped', 'Stopped.');
          return separated ? streamed : message.result || streamed;
        }
        if (message.subtype === 'error_max_turns') {
          throw new ChatError(
            'failed',
            `Claude took more than ${CHAT_MAX_TURNS} steps without finishing, so the reply was stopped. Try a narrower question.`,
          );
        }
        const reason = message.subtype === 'success' ? message.result : message.errors.join('; ');
        throw resultError(assistantError, reason, request.model);
      }
    }
  } catch (error) {
    if (error instanceof ChatError) throw error;
    if (request.signal.aborted) throw new ChatError('stopped', 'Stopped.');
    throw processError(error, stderr);
  }
  if (request.signal.aborted) throw new ChatError('stopped', 'Stopped.');
  throw new ChatError('failed', 'Claude Code ended without a reply. Try sending your message again.');
}

const LOGIN_PATTERN = /not logged in|please run \/login|invalid api key|oauth token|authentication/i;

/** Maps a reply Claude Code ended with an error to what the owner should do about it. */
function resultError(assistantError: string | undefined, reason: string, model: string): ChatError {
  const text = reason.trim();
  if (assistantError === 'authentication_failed' || LOGIN_PATTERN.test(text)) {
    return new ChatError('login', CHAT_LOGIN_MESSAGE, text);
  }
  if (assistantError === 'oauth_org_not_allowed' || assistantError === 'account_on_hold' || assistantError === 'verification_required') {
    return new ChatError(
      'login',
      `Claude Code's account cannot be used right now (${assistantError.replaceAll('_', ' ')}). Check your account at claude.ai, then try again.`,
      text,
    );
  }
  if (assistantError === 'billing_error') {
    return new ChatError(
      'login',
      'Claude Code reported a billing problem with its login. Make sure it is signed in with your Claude subscription (run "claude", then /login), then try again.',
      text,
    );
  }
  if (assistantError === 'model_not_found' || /model.*(not found|not available|does not exist|invalid)|unknown model/i.test(text)) {
    return new ChatError('model', `Claude Code does not accept the model "${model}". Pick another model and send again.`, text);
  }
  if (assistantError === 'rate_limit' || /usage limit|rate limit/i.test(text)) {
    return new ChatError('limit', 'Your Claude subscription has reached its usage limit for now. Try again later, or pick a smaller model.', text);
  }
  if (assistantError === 'overloaded' || assistantError === 'server_error' || /overloaded/i.test(text)) {
    return new ChatError('unavailable', 'Claude is busy or unavailable right now. Wait a moment and send again.', text);
  }
  return new ChatError('failed', `Claude Code could not answer${text ? `: ${text}` : '.'}`, text);
}

/** Maps a failure to start or talk to the Claude Code process. */
function processError(error: unknown, stderr: string[]): ChatError {
  const message = error instanceof Error ? error.message : String(error);
  const detail = [message, ...stderr.slice(-10)].join('\n').trim();
  if (/ENOENT|not found|could not find|executable/i.test(message) && /claude/i.test(message)) {
    return new ChatError(
      'not-installed',
      'Claude Code could not be started. Reinstall the app\'s dependencies with "npm install", then try again.',
      detail,
    );
  }
  if (LOGIN_PATTERN.test(detail)) return new ChatError('login', CHAT_LOGIN_MESSAGE, detail);
  return new ChatError('failed', `Claude Code stopped unexpectedly: ${message}`, detail);
}

/**
 * The real `query`. The SDK ships ESM-only, so it is loaded with a real
 * dynamic `import()` on first use, like pi-ai (`tsconfig.json`'s Node20
 * module setting keeps the `import()` in the CommonJS output).
 */
export const sdkQuery: QueryFn = (params) =>
  (async function* () {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    yield* query(params);
  })();
