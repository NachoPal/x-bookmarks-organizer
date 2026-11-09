import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { Database } from '../db/database';
import { createMcpServer, MCP_TOOL_NAMES, searchBookmarks } from '../mcp/tools';
import {
  API_CREDENTIAL_ENV_VARS,
  CHAT_ALLOWED_TOOLS,
  CHAT_LOGIN_MESSAGE,
  ChatError,
  replyOptions,
  streamReply,
  subscriptionEnv,
  type ChatToolActivity,
  type QueryFn,
  type ReplyRequest,
} from './claude';
import { scriptedQuery } from './scripted-query';
import type { RawBookmark } from '../types';

const bm = (postId: string, text: string): RawBookmark => ({
  postId,
  authorUsername: `user${postId}`,
  authorName: `User ${postId}`,
  text,
  url: `https://x.com/user${postId}/status/${postId}`,
  postCreatedAt: '2024-05-01T10:00:00.000Z',
});

/** A query that yields exactly these messages. */
function fixed(messages: unknown[]): QueryFn {
  return () =>
    (async function* () {
      for (const m of messages) yield m as SDKMessage;
    })();
}

/** A query whose process fails to start. */
function throwing(error: Error): QueryFn {
  return () =>
    // eslint-disable-next-line require-yield
    (async function* () {
      throw error;
    })();
}

describe('chat: Claude Code on the subscription', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    const ai = db.getOrCreateCategory('AI', null, '2024-06-01T00:00:00.000Z').id;
    db.storeCategorizedBatch(
      [bm('1', 'agent harness evaluation notes'), bm('2', 'sourdough bread'), bm('3', 'eval harness for agents')],
      (b) => (b.postId === '2' ? [] : [ai]),
      '2024-06-01T00:00:00.000Z',
    );
  });

  afterEach(() => db.close());

  function request(overrides: Partial<ReplyRequest> = {}): ReplyRequest & { texts: string[]; steps: string[]; tools: ChatToolActivity[] } {
    const texts: string[] = [];
    const steps: string[] = [];
    const tools: ChatToolActivity[] = [];
    return {
      prompt: 'hi',
      systemPrompt: 'system',
      model: 'claude-sonnet-5-5',
      effort: 'medium',
      mcpServer: createMcpServer(db, '0.0.0'),
      signal: new AbortController().signal,
      onText: (t) => texts.push(t),
      onStep: (s) => steps.push(s),
      onTool: (t) => tools.push(t),
      texts,
      steps,
      tools,
      ...overrides,
    };
  }

  describe('subscriptionEnv', () => {
    it('strips every API-billing variable and keeps the rest, without touching the input', () => {
      const env: NodeJS.ProcessEnv = { PATH: '/bin', HOME: '/home/me', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-x' };
      for (const name of API_CREDENTIAL_ENV_VARS) env[name] = 'set';
      const out = subscriptionEnv(env);
      for (const name of API_CREDENTIAL_ENV_VARS) expect(out).not.toHaveProperty(name);
      expect(out.PATH).toBe('/bin');
      expect(out.HOME).toBe('/home/me');
      expect(out.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat-x');
      expect(env.ANTHROPIC_API_KEY).toBe('set');
    });

    it('covers the key, the gateway and every cloud provider', () => {
      expect([...API_CREDENTIAL_ENV_VARS].sort()).toEqual(
        [
          'ANTHROPIC_API_KEY',
          'ANTHROPIC_AUTH_TOKEN',
          'ANTHROPIC_BASE_URL',
          'CLAUDE_CODE_USE_BEDROCK',
          'CLAUDE_CODE_USE_FOUNDRY',
          'CLAUDE_CODE_USE_VERTEX',
        ].sort(),
      );
    });

    it('passes on a subscription token the credential chain resolved', () => {
      expect(subscriptionEnv({ PATH: '/bin' }, 'sk-ant-oat-chain').CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat-chain');
    });
  });

  describe('replyOptions', () => {
    it('loads nothing of the owner\'s Claude Code and offers only the app\'s tools, pre-approved, denying the rest', () => {
      const req = request({ env: { PATH: '/bin', ANTHROPIC_API_KEY: 'sk-ant-api-leak' } });
      const options = replyOptions(req, new AbortController(), []);
      expect(options.settingSources).toEqual([]);
      expect(options.strictMcpConfig).toBe(true);
      expect(options.permissionMode).toBe('dontAsk');
      expect(options.tools).toEqual([]);
      expect(options.persistSession).toBe(false);
      expect(options.includePartialMessages).toBe(true);
      expect(Object.keys(options.mcpServers ?? {})).toEqual(['xbookmarks']);
      expect(options.mcpServers?.xbookmarks).toMatchObject({ type: 'sdk', name: 'xbookmarks', instance: req.mcpServer });
      expect(options.allowedTools).toEqual(MCP_TOOL_NAMES.map((t) => `mcp__xbookmarks__${t}`));
      expect(options.env).not.toHaveProperty('ANTHROPIC_API_KEY');
      expect(options.model).toBe('claude-sonnet-5-5');
      expect(options.effort).toBe('medium');
      expect(options.systemPrompt).toBe('system');
    });

    it('allows exactly the eight MCP tools - one of them, show_in_app, the only write', () => {
      expect(CHAT_ALLOWED_TOOLS).toHaveLength(8);
      expect(CHAT_ALLOWED_TOOLS.some((t) => !t.startsWith('mcp__xbookmarks__'))).toBe(false);
    });
  });

  describe('streamReply', () => {
    it('streams the text, and a search runs the very handler the MCP endpoint runs', async () => {
      let seenOptions: Options | undefined;
      const run = scriptedQuery((_prompt, options) => {
        seenOptions = options;
        return [{ tool: 'search_bookmarks', input: { query: 'harness' } }, { text: 'Found two posts about harnesses.' }];
      });
      const req = request();
      const reply = await streamReply(run, req);
      expect(reply).toBe('Found two posts about harnesses.');
      expect(req.texts.join('')).toContain('Found two posts about harnesses.');
      expect(req.steps).toContain('Searching bookmarks…');
      expect(req.tools).toEqual([{ tool: 'search_bookmarks', label: 'Searched bookmarks for "harness"', status: 'done' }]);
      expect(seenOptions?.permissionMode).toBe('dontAsk');
      // The fake ran the tool through the real server; its answer is the plain handler's.
      expect(searchBookmarks(db, { query: 'harness' }).total).toBe(2);
    });

    it('show_in_app creates a real assistant list, announced through onListCreated, and the chip names it', async () => {
      const created: number[] = [];
      const run = scriptedQuery(() => [
        { tool: 'show_in_app', input: { postIds: ['1', '3'], title: 'Eval harnesses', note: 'Two posts.' } },
        { text: 'Sent them to the app.' },
      ]);
      const req = request({ mcpServer: createMcpServer(db, '0.0.0', { onListCreated: (l) => created.push(l.id) }) });
      await streamReply(run, req);
      const lists = db.getAssistantLists();
      expect(lists).toHaveLength(1);
      expect(lists[0]).toMatchObject({ title: 'Eval harnesses', count: 2 });
      expect(created).toEqual([lists[0]!.id]);
      expect(req.tools).toEqual([
        { tool: 'show_in_app', label: 'Showing 2 posts in the app as "Eval harnesses"', status: 'done', listId: lists[0]!.id },
      ]);
    });

    it('marks a tool call that answered with an error as failed', async () => {
      const run = scriptedQuery(() => [{ tool: 'get_bookmark', input: { postId: '999' } }, { text: 'Not there.' }]);
      const req = request();
      await streamReply(run, req);
      expect(req.tools).toEqual([{ tool: 'get_bookmark', label: 'Read a post', status: 'failed' }]);
    });

    it('keeps text written on both sides of a tool call as separate paragraphs', async () => {
      const run = scriptedQuery(() => [{ text: 'Looking.' }, { tool: 'library_stats', input: {} }, { text: 'You have 3.' }]);
      expect(await streamReply(run, request())).toBe('Looking.\n\nYou have 3.');
    });

    it('turns "not logged in" into the login fix', async () => {
      const run = fixed([{ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' }]);
      await expect(streamReply(run, request())).rejects.toMatchObject({ kind: 'login', message: CHAT_LOGIN_MESSAGE });
    });

    it('turns an auth_status error and an authentication_failed reply into the login fix', async () => {
      await expect(streamReply(fixed([{ type: 'auth_status', error: 'expired' }]), request())).rejects.toMatchObject({ kind: 'login' });
      const authFailed = fixed([
        { type: 'assistant', parent_tool_use_id: null, error: 'authentication_failed', message: { content: [] } },
        { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['401'] },
      ]);
      await expect(streamReply(authFailed, request())).rejects.toMatchObject({ kind: 'login' });
    });

    it('says what to do when Claude Code cannot start, and when the usage limit is hit', async () => {
      await expect(streamReply(throwing(new Error('spawn claude ENOENT')), request())).rejects.toMatchObject({ kind: 'not-installed' });
      const limited = fixed([{ type: 'result', subtype: 'success', is_error: true, result: 'Claude usage limit reached' }]);
      await expect(streamReply(limited, request())).rejects.toMatchObject({ kind: 'limit' });
    });

    it('stops when the signal aborts, passing the abort on to Claude Code', async () => {
      const controller = new AbortController();
      let childSignal: AbortSignal | undefined;
      const run = scriptedQuery(
        (_p, options) => {
          childSignal = options.abortController?.signal;
          return [{ text: 'one two three four five six seven eight nine ten' }];
        },
        { delayMs: 20 },
      );
      const req = request({
        signal: controller.signal,
        onText: () => controller.abort(),
      });
      const failure = await streamReply(run, req).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(ChatError);
      expect((failure as ChatError).kind).toBe('stopped');
      expect(childSignal?.aborted).toBe(true);
    });
  });
});
