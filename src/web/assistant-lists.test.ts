import type { AddressInfo } from 'node:net';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildServer, CROSS_ORIGIN_MESSAGE } from './server';
import { Database } from '../db/database';
import { setMcpEnabled } from '../mcp/access';
import { ASSISTANT_LIST_EVENTS_PATH } from './assistant-lists';
import type { RawBookmark } from '../types';

const WHEN = '2026-09-25T00:00:00.000Z';

const bm = (postId: string): RawBookmark => ({
  postId,
  authorUsername: `user${postId}`,
  authorName: `User ${postId}`,
  text: `post ${postId}`,
  url: `https://x.com/user${postId}/status/${postId}`,
  postCreatedAt: WHEN,
});

/** Read Server-Sent Events off a streaming fetch, one parsed event at a time. */
async function openStream(url: string) {
  const controller = new AbortController();
  const res = await fetch(url, { signal: controller.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  async function next(): Promise<{ event: string; data: string }> {
    for (;;) {
      const end = buffer.indexOf('\n\n');
      if (end !== -1) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const lines = block.split('\n');
        const event = lines.find((l) => l.startsWith('event: '))?.slice(7);
        const data = lines.find((l) => l.startsWith('data: '))?.slice(6);
        if (event) return { event, data: data ?? '' };
        continue; // a `retry:` line or a heartbeat comment
      }
      const { value, done } = await reader.read();
      if (done) throw new Error('stream closed');
      buffer += decoder.decode(value, { stream: true });
    }
  }
  return { res, next, close: () => controller.abort() };
}

describe('assistant result lists in the viewer', () => {
  let db: Database;
  let app: FastifyInstance;
  let base: string;
  let token: string;

  beforeEach(async () => {
    db = new Database(':memory:');
    const ai = db.getOrCreateCategory('AI', null, WHEN).id;
    db.storeCategorizedBatch(['1', '2', '3'].map(bm), () => [ai], WHEN);
    app = buildServer(db);
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    token = setMcpEnabled(db, true).token!;
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  async function showInApp(args: Record<string, unknown>) {
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    const result = await client.callTool({ name: 'show_in_app', arguments: args });
    await client.close();
    return JSON.parse((result.content as { text: string }[])[0]!.text);
  }

  const id = (postId: string) => db.getBookmarkByPostId(postId)!.id;

  it('lists newest first and serves a list as normal cards, in the assistant order', async () => {
    db.createAssistantList({ title: 'Older', note: null, bookmarkIds: [id('1')] }, WHEN);
    const { listId } = await showInApp({ postIds: ['3', '1'], title: 'Eval harnesses', note: 'Why' });

    const index = (await (await fetch(`${base}/api/assistant-lists`)).json()) as { lists: { title: string }[] };
    expect(index.lists.map((l) => l.title)).toEqual(['Eval harnesses', 'Older']);

    const res = await fetch(`${base}/api/assistant-lists/${listId}`);
    const body = (await res.json()) as { list: object; bookmarks: Record<string, unknown>[] };
    expect(body.list).toMatchObject({ id: listId, title: 'Eval harnesses', note: 'Why', count: 2 });
    expect(body.bookmarks.map((b) => b.postId)).toEqual(['3', '1']);
    // The same card shape a category page ships, so every card action works.
    expect(body.bookmarks[0]).toMatchObject({ categoryIds: [expect.any(Number)], hasSummary: false, score: null });
  });

  it('orders a list on request, the assistant order by default, and says which it used', async () => {
    const list = db.createAssistantList({ title: 'L', note: null, bookmarkIds: [id('2'), id('3'), id('1')] });
    const get = async (query: string) =>
      (await (await fetch(`${base}/api/assistant-lists/${list.id}${query}`)).json()) as {
        sort: string;
        dir: string;
        bookmarks: { postId: string }[];
      };
    const plain = await get('');
    expect([plain.sort, plain.dir, plain.bookmarks.map((b) => b.postId)]).toEqual(['list', 'desc', ['2', '3', '1']]);
    expect((await get('?sort=recent&dir=desc')).bookmarks.map((b) => b.postId)).toEqual(['3', '2', '1']);
    expect((await get('?sort=list&dir=asc')).bookmarks.map((b) => b.postId)).toEqual(['1', '3', '2']);
    expect((await get('?sort=nonsense')).sort).toBe('list');
  });

  it('streams a change when a listed post is read, unread or deleted - and only then', async () => {
    const list = db.createAssistantList({ title: 'L', note: null, bookmarkIds: [id('1'), id('2')] });
    const stream = await openStream(`${base}${ASSISTANT_LIST_EVENTS_PATH}`);
    const post = (bookmarkId: number, read: boolean) =>
      fetch(`${base}/api/bookmarks/${bookmarkId}/read`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ read }),
      });
    try {
      await post(id('3'), true); // in no list: nothing to announce
      await post(id('1'), true);
      expect((await stream.next()).event).toBe('changed');
      expect(db.getAssistantList(list.id)).toMatchObject({ count: 2, unread: 1 });
      await post(id('1'), false);
      expect((await stream.next()).event).toBe('changed');
      await fetch(`${base}/api/bookmarks/${id('2')}`, { method: 'DELETE' });
      expect((await stream.next()).event).toBe('changed');
      expect(db.getAssistantList(list.id)).toMatchObject({ count: 1, unread: 1 });
      // Nothing was queued for the unlisted post: the next event is this list.
      await showInApp({ postIds: ['3'], title: 'Next' });
      expect((await stream.next()).event).toBe('created');
    } finally {
      stream.close();
    }
  });

  it('answers 404 for an unknown list and 400 for a malformed id', async () => {
    expect((await fetch(`${base}/api/assistant-lists/999`)).status).toBe(404);
    expect((await fetch(`${base}/api/assistant-lists/abc`)).status).toBe(400);
    expect((await fetch(`${base}/api/assistant-lists/999`, { method: 'DELETE' })).status).toBe(404);
  });

  it('deletes one list or all of them, and never a post', async () => {
    const a = db.createAssistantList({ title: 'A', note: null, bookmarkIds: [id('1'), id('2')] });
    db.createAssistantList({ title: 'B', note: null, bookmarkIds: [id('3')] });
    expect((await fetch(`${base}/api/assistant-lists/${a.id}`, { method: 'DELETE' })).status).toBe(204);
    expect(db.getAssistantLists().map((l) => l.title)).toEqual(['B']);
    const cleared = await fetch(`${base}/api/assistant-lists`, { method: 'DELETE' });
    expect(await cleared.json()).toEqual({ deleted: 1 });
    expect(db.getAllBookmarks()).toHaveLength(3);
  });

  it('deletes exactly the ids it is sent, leaving a list that arrived meanwhile', async () => {
    const a = db.createAssistantList({ title: 'A', note: null, bookmarkIds: [id('1')] });
    const b = db.createAssistantList({ title: 'B', note: null, bookmarkIds: [id('2')] });
    db.createAssistantList({ title: 'Arrived later', note: null, bookmarkIds: [id('3')] });
    const del = (body: unknown) =>
      fetch(`${base}/api/assistant-lists`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect(await (await del({ ids: [a.id, b.id, 999] })).json()).toEqual({ deleted: 2 });
    expect(db.getAssistantLists().map((l) => l.title)).toEqual(['Arrived later']);
    expect((await del({ ids: ['x'] })).status).toBe(400);
  });

  it('a deleted post leaves the list it was in', async () => {
    const list = db.createAssistantList({ title: 'A', note: null, bookmarkIds: [id('1'), id('2')] });
    expect((await fetch(`${base}/api/bookmarks/${id('1')}`, { method: 'DELETE' })).status).toBe(204);
    const body = (await (await fetch(`${base}/api/assistant-lists/${list.id}`)).json()) as {
      list: { count: number };
      bookmarks: { postId: string }[];
    };
    expect(body.list.count).toBe(1);
    expect(body.bookmarks.map((b) => b.postId)).toEqual(['2']);
  });

  it('marks a list viewed on its first open only, and streams that as a change', async () => {
    const stream = await openStream(`${base}${ASSISTANT_LIST_EVENTS_PATH}`);
    try {
      const { listId } = await showInApp({ postIds: ['1'], title: 'Unopened' });
      expect((await stream.next()).event).toBe('created');
      const index = async () =>
        ((await (await fetch(`${base}/api/assistant-lists`)).json()) as { lists: { viewed: boolean }[] }).lists;
      expect((await index())[0]!.viewed).toBe(false);
      // Reading the list is not viewing it: a GET never writes.
      await fetch(`${base}/api/assistant-lists/${listId}`);
      expect((await index())[0]!.viewed).toBe(false);

      const res = await fetch(`${base}/api/assistant-lists/${listId}/viewed`, { method: 'POST' });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { list: object }).list).toMatchObject({ id: listId, viewed: true });
      expect((await index())[0]!.viewed).toBe(true);
      expect((await stream.next()).event).toBe('changed');

      // A repeat open changes nothing, so it announces nothing: the next
      // event on the stream is the following list, not a second `changed`.
      expect((await fetch(`${base}/api/assistant-lists/${listId}/viewed`, { method: 'POST' })).status).toBe(200);
      await showInApp({ postIds: ['2'], title: 'Next' });
      expect((await stream.next()).event).toBe('created');
    } finally {
      stream.close();
    }
    expect((await fetch(`${base}/api/assistant-lists/999/viewed`, { method: 'POST' })).status).toBe(404);
    expect((await fetch(`${base}/api/assistant-lists/abc/viewed`, { method: 'POST' })).status).toBe(400);
  });

  it('refuses a cross-origin page marking a list viewed', async () => {
    const list = db.createAssistantList({ title: 'A', note: null, bookmarkIds: [id('1')] });
    const res = await fetch(`${base}/api/assistant-lists/${list.id}/viewed`, {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);
    expect(db.getAssistantList(list.id)!.viewed).toBe(false);
  });

  it('streams a list to the open app the moment show_in_app creates it, and a delete as a change', async () => {
    const stream = await openStream(`${base}${ASSISTANT_LIST_EVENTS_PATH}`);
    expect(stream.res.headers.get('content-type')).toMatch(/^text\/event-stream/);
    try {
      const { listId } = await showInApp({ postIds: ['2'], title: 'Live one' });
      const created = await stream.next();
      expect(created.event).toBe('created');
      expect(JSON.parse(created.data)).toMatchObject({ id: listId, title: 'Live one', count: 1 });

      await fetch(`${base}/api/assistant-lists/${listId}`, { method: 'DELETE' });
      expect((await stream.next()).event).toBe('changed');
    } finally {
      stream.close();
    }
  });

  it('a refused show_in_app call streams nothing', async () => {
    const stream = await openStream(`${base}${ASSISTANT_LIST_EVENTS_PATH}`);
    try {
      const refused = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'show_in_app', arguments: { postIds: ['1'], title: 'No token' } },
        }),
      });
      expect(refused.status).toBe(401);
      // The next event must be the authorized one, proving nothing was published in between.
      await showInApp({ postIds: ['1'], title: 'With token' });
      expect(JSON.parse((await stream.next()).data).title).toBe('With token');
    } finally {
      stream.close();
    }
  });

  it('refuses the stream to a cross-site page', async () => {
    const res = await app.inject({
      method: 'GET',
      url: ASSISTANT_LIST_EVENTS_PATH,
      headers: { host: base.slice('http://'.length), 'sec-fetch-site': 'cross-site' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: CROSS_ORIGIN_MESSAGE });
  });

  it('closes cleanly with a stream still open', async () => {
    const stream = await openStream(`${base}${ASSISTANT_LIST_EVENTS_PATH}`);
    await app.close(); // must not hang on the live connection
    await expect(stream.next()).rejects.toThrow();
  });
});
