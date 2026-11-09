import type { AddressInfo } from 'node:net';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer, CROSS_ORIGIN_MESSAGE } from './server';
import { CHAT_UNAVAILABLE_MESSAGE, type ChatStreamEvent } from './chat-routes';
import { Database } from '../db/database';
import { scriptedQuery, type ScriptedTurn } from '../chat/scripted-query';
import type { QueryFn } from '../chat/claude';
import type { RawBookmark } from '../types';

const bm = (postId: string, text: string): RawBookmark => ({
  postId,
  authorUsername: `user${postId}`,
  authorName: `User ${postId}`,
  text,
  url: `https://x.com/user${postId}/status/${postId}`,
  postCreatedAt: '2024-05-01T10:00:00.000Z',
});

/** The events of one SSE reply body. */
function events(body: string): ChatStreamEvent[] {
  return body
    .split('\n\n')
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice('data: '.length)) as ChatStreamEvent);
}

const send = (body: Record<string, unknown>) => ({
  model: 'claude-sonnet-5-5',
  effort: 'medium',
  requestId: `r-${Math.random().toString(36).slice(2)}`,
  ...body,
});

describe('"Ask Claude" chat routes', () => {
  let db: Database;
  let app: FastifyInstance;

  beforeEach(() => {
    db = new Database(':memory:');
    db.storeCategorizedBatch([bm('1', 'eval harness'), bm('2', 'agent harness')], () => [], '2024-06-01T00:00:00.000Z');
  });

  afterEach(async () => {
    await app?.close();
    db.close();
  });

  async function serve(run?: QueryFn, extra: Parameters<typeof buildServer>[1] = {}) {
    app = buildServer(db, { ...(run ? { chat: { run } } : {}), ...extra });
    await app.ready();
  }

  it('reports the model picker, defaulting to Sonnet 5.5 at medium effort', async () => {
    await serve(scriptedQuery(() => []));
    const body = (await app.inject({ method: 'GET', url: '/api/chat' })).json() as {
      available: boolean;
      models: { id: string }[];
      efforts: string[];
      defaults: { model: string; effort: string };
    };
    expect(body.available).toBe(true);
    expect(body.defaults).toEqual({ model: 'claude-sonnet-5-5', effort: 'medium' });
    expect(body.models.map((m) => m.id)).toContain('claude-sonnet-5-5');
    expect(body.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('degrades with 503 and the reason on a viewer without the chat wiring', async () => {
    await serve();
    const status = (await app.inject({ method: 'GET', url: '/api/chat' })).json() as { available: boolean; reason: string };
    expect(status).toMatchObject({ available: false, reason: CHAT_UNAVAILABLE_MESSAGE });
    const res = await app.inject({ method: 'POST', url: '/api/chat/messages', payload: send({ text: 'hi' }) });
    expect(res.statusCode).toBe(503);
    // The stored conversations stay readable.
    expect((await app.inject({ method: 'GET', url: '/api/chat/conversations' })).json()).toEqual({ conversations: [] });
  });

  it("uses the claude-cli availability probe: Claude Code that cannot run is refused with the probe's own words", async () => {
    const run = scriptedQuery(() => [{ text: 'never' }]);
    await serve(run, { claudeCliCheck: async () => ({ state: 'unconfigured', detail: 'The `claude` CLI was not found.' }) });
    const status = (await app.inject({ method: 'GET', url: '/api/chat' })).json() as { available: boolean; reason: string };
    expect(status).toMatchObject({ available: false, reason: 'The `claude` CLI was not found.' });
    const res = await app.inject({ method: 'POST', url: '/api/chat/messages', payload: send({ text: 'hi' }) });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'The `claude` CLI was not found.' });
    expect(run.calls).toHaveLength(0);
  });

  it('validates the message, the model, the effort and the conversation', async () => {
    await serve(scriptedQuery(() => []));
    const post = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/chat/messages', payload });
    expect((await post(send({ text: '  ' }))).statusCode).toBe(400);
    expect((await post(send({ text: 'hi', model: 'gpt-4' }))).statusCode).toBe(400);
    expect((await post(send({ text: 'hi', effort: 'turbo' }))).statusCode).toBe(400);
    expect((await post(send({ text: 'x'.repeat(20_001) }))).statusCode).toBe(400);
    expect((await post(send({ text: 'hi', conversationId: 99 }))).statusCode).toBe(404);
    expect((await post({ text: 'hi', model: 'claude-sonnet-5-5', effort: 'medium' })).statusCode).toBe(400);
  });

  it('streams a reply as server-sent events and stores the exchange, with tool chips, as a new conversation', async () => {
    const run = scriptedQuery(() => [{ tool: 'search_bookmarks', input: { query: 'harness' } }, { text: 'Two posts match.' }]);
    await serve(run);
    const res = await app.inject({ method: 'POST', url: '/api/chat/messages', payload: send({ text: 'What about harnesses?' }) });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    const stream = events(res.body);
    expect(stream.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('')).toBe('Two posts match.');
    expect(stream).toContainEqual({ type: 'step', step: 'Searching bookmarks…' });
    expect(stream).toContainEqual({
      type: 'tool',
      tool: { tool: 'search_bookmarks', label: 'Searched bookmarks for "harness"', status: 'done' },
    });
    const done = stream.at(-1) as Extract<ChatStreamEvent, { type: 'done' }>;
    expect(done.type).toBe('done');
    expect(done.conversation.title).toBe('What about harnesses?');
    expect(done.messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'What about harnesses?'],
      ['assistant', 'Two posts match.'],
    ]);

    const list = (await app.inject({ method: 'GET', url: '/api/chat/conversations' })).json() as { conversations: { id: number }[] };
    expect(list.conversations.map((c) => c.id)).toEqual([done.conversation.id]);
    const one = (await app.inject({ method: 'GET', url: `/api/chat/conversations/${done.conversation.id}` })).json() as {
      messages: { role: string; model: string | null; effort: string | null; tools: unknown[] }[];
    };
    expect(one.messages[1]).toMatchObject({ role: 'assistant', model: 'claude-sonnet-5-5', effort: 'medium' });
    expect(one.messages[1]!.tools).toHaveLength(1);
  });

  it('sends the stored history with a follow-up, and the system prompt describes the library and the search syntax', async () => {
    const run = scriptedQuery((prompt) => [{ text: prompt.includes('<conversation_so_far>') ? 'Follow-up answer.' : 'First answer.' }]);
    await serve(run);
    const first = events((await app.inject({ method: 'POST', url: '/api/chat/messages', payload: send({ text: 'First question' }) })).body);
    const conversationId = (first.at(-1) as Extract<ChatStreamEvent, { type: 'done' }>).conversation.id;
    await app.inject({ method: 'POST', url: '/api/chat/messages', payload: send({ text: 'And then?', conversationId }) });
    const followUp = run.calls[1]!;
    expect(followUp.prompt).toContain('<owner>\nFirst question\n</owner>');
    expect(followUp.prompt).toContain('<assistant>\nFirst answer.\n</assistant>');
    expect(followUp.prompt.endsWith('And then?')).toBe(true);
    const system = String(followUp.options.systemPrompt);
    expect(system).toContain('from:@user');
    expect(system).toContain('category:Name');
    expect(system).toContain('show_in_app');
    expect(system).toContain('2 bookmarks');
    expect(db.getChatMessages(conversationId)).toHaveLength(4);
  });

  it('show_in_app in a reply creates a list the Lists page and its live stream see, with or without the /mcp endpoint on', async () => {
    const run = scriptedQuery(() => [
      { tool: 'show_in_app', input: { postIds: ['1', '2'], title: 'Harnesses' } },
      { text: 'Sent.' },
    ]);
    await serve(run);
    const stream = events((await app.inject({ method: 'POST', url: '/api/chat/messages', payload: send({ text: 'Show me' }) })).body);
    const lists = (await app.inject({ method: 'GET', url: '/api/assistant-lists' })).json() as { lists: { id: number; title: string; viewed: boolean }[] };
    expect(lists.lists).toHaveLength(1);
    expect(lists.lists[0]).toMatchObject({ title: 'Harnesses', viewed: false });
    expect(stream).toContainEqual({
      type: 'tool',
      tool: { tool: 'show_in_app', label: 'Showing 2 posts in the app as "Harnesses"', status: 'done', listId: lists.lists[0]!.id },
    });
    // The external endpoint was never switched on.
    expect((await app.inject({ method: 'POST', url: '/mcp', payload: {} })).statusCode).toBe(404);
  });

  it('reports a failed reply as an error event and saves nothing', async () => {
    const run: QueryFn = () =>
      (async function* () {
        yield { type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' } as never;
      })();
    await serve(run);
    const stream = events((await app.inject({ method: 'POST', url: '/api/chat/messages', payload: send({ text: 'hi' }) })).body);
    expect(stream).toHaveLength(1);
    expect(stream[0]).toMatchObject({ type: 'error', error: { kind: 'login' } });
    expect((stream[0] as { error: { message: string } }).error.message).toContain('/login');
    expect(db.listChatConversations()).toEqual([]);
  });

  it('deletes a conversation with its messages', async () => {
    await serve(scriptedQuery(() => [{ text: 'ok' }]));
    const stream = events((await app.inject({ method: 'POST', url: '/api/chat/messages', payload: send({ text: 'hi' }) })).body);
    const id = (stream.at(-1) as Extract<ChatStreamEvent, { type: 'done' }>).conversation.id;
    expect((await app.inject({ method: 'DELETE', url: `/api/chat/conversations/${id}` })).statusCode).toBe(204);
    expect(db.getChatMessages(id)).toEqual([]);
    expect((await app.inject({ method: 'DELETE', url: `/api/chat/conversations/${id}` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/chat/conversations/${id}` })).statusCode).toBe(404);
  });

  describe('over a real socket', () => {
    let base: string;
    let host: string;

    async function listen(turns: ScriptedTurn[]) {
      const run = scriptedQuery(() => turns, { delayMs: 30 });
      app = buildServer(db, { chat: { run } });
      await app.listen({ port: 0, host: '127.0.0.1' });
      const { port } = app.server.address() as AddressInfo;
      host = `127.0.0.1:${port}`;
      base = `http://${host}`;
      return run;
    }

    /** Read the stream until `until` says stop; answers the events so far. */
    async function readUntil(res: Response, until: (seen: ChatStreamEvent[]) => boolean): Promise<ChatStreamEvent[]> {
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return events(buffer);
        buffer += decoder.decode(value, { stream: true });
        const seen = events(buffer.slice(0, buffer.lastIndexOf('\n\n') + 2));
        if (until(seen)) {
          void reader.cancel();
          return seen;
        }
      }
    }

    it('Stop ends the reply and keeps what was written, marked stopped', async () => {
      await listen([{ text: 'one two three four five six seven eight nine ten eleven twelve' }]);
      const body = send({ text: 'Count' });
      const res = await fetch(`${base}/api/chat/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify(body),
      });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let stopped = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (!stopped && buffer.includes('"type":"text"')) {
          stopped = true;
          const stop = await fetch(`${base}/api/chat/replies/${body.requestId as string}/stop`, { method: 'POST', headers: { origin: base } });
          expect(stop.status).toBe(204);
        }
      }
      const done = events(buffer).at(-1) as Extract<ChatStreamEvent, { type: 'done' }>;
      expect(done.type).toBe('done');
      expect(done.messages[1]!.stopped).toBe(true);
      expect(done.messages[1]!.text.length).toBeGreaterThan(0);
      expect(done.messages[1]!.text).not.toContain('twelve');
      const again = await fetch(`${base}/api/chat/replies/${body.requestId as string}/stop`, { method: 'POST', headers: { origin: base } });
      expect(again.status).toBe(404);
    });

    it('closing the request stops Claude Code', async () => {
      const run = await listen([{ text: 'one two three four five six seven eight nine ten eleven twelve' }]);
      const controller = new AbortController();
      const res = await fetch(`${base}/api/chat/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify(send({ text: 'Count' })),
        signal: controller.signal,
      });
      await readUntil(res, (seen) => seen.some((e) => e.type === 'text'));
      controller.abort();
      await expect.poll(() => run.calls[0]!.options.abortController!.signal.aborted).toBe(true);
    });

    it('is behind the local origin guard: a cross-site page cannot send or delete', async () => {
      await listen([{ text: 'never' }]);
      const crossOrigin = await fetch(`${base}/api/chat/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
        body: JSON.stringify(send({ text: 'hi' })),
      });
      expect(crossOrigin.status).toBe(403);
      expect(((await crossOrigin.json()) as { error: string }).error).toBe(CROSS_ORIGIN_MESSAGE);
      const crossSite = await fetch(`${base}/api/chat/conversations/1`, {
        method: 'DELETE',
        headers: { 'sec-fetch-site': 'cross-site' },
      });
      expect(crossSite.status).toBe(403);
      expect(host).toMatch(/^127\.0\.0\.1:/);
    });
  });
});
