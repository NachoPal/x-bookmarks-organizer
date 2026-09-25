import type { AddressInfo } from 'node:net';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildServer, CROSS_ORIGIN_MESSAGE, UNEXPECTED_HOST_MESSAGE } from '../web/server';
import { Database } from '../db/database';
import { writeSettings } from '../settings/settings';
import { MCP_ACCESS_KEY, readMcpAccess, regenerateMcpToken, setMcpEnabled, verifyMcpToken } from './access';
import { MCP_DISABLED_MESSAGE } from './http';
import {
  ARTICLE_TEXT_CHARS,
  LIST_TEXT_CHARS,
  MAX_ASSISTANT_LISTS,
  SHOW_MAX_POSTS,
  SHOW_NOTE_MAX_CHARS,
  SHOW_TITLE_MAX_CHARS,
} from './tools';
import type { RawBookmark } from '../types';

const WHEN = '2024-06-01T00:00:00.000Z';
const REFRESH_TOKEN = 'x-refresh-token-SECRET-1234';

const bm = (postId: string, text: string, extra: Partial<RawBookmark> = {}): RawBookmark => ({
  postId,
  authorUsername: `user${postId}`,
  authorName: `User ${postId}`,
  text,
  url: `https://x.com/user${postId}/status/${postId}`,
  postCreatedAt: `2024-0${postId}-01T00:00:00.000Z`,
  ...extra,
});

/** A small library with every kind of content a tool can return, plus secrets it must never return. */
function seed(db: Database): void {
  const ai = db.getOrCreateCategory('AI', null, WHEN, 'Machine learning and agents').id;
  const agents = db.getOrCreateCategory('Agents', ai, WHEN, 'Autonomous tool-using systems').id;
  const cooking = db.getOrCreateCategory('Cooking', null, WHEN).id;
  const home: Record<string, number[]> = { '1': [agents], '2': [ai], '3': [cooking], '4': [agents, cooking] };
  db.saveArticleLinkMetadata({
    url: 'https://t.co/link1',
    status: 'ok',
    title: 'Building effective agent harnesses',
    description: 'A field guide',
    image: null,
    siteName: 'Example Blog',
    resolvedUrl: 'https://example.com/harnesses',
    fetchedAt: WHEN,
  });
  db.storeCategorizedBatch(
    [
      bm('1', 'Great read on harness design https://t.co/link1'),
      bm('2', 'Scaling laws revisited'),
      bm('3', 'Sourdough starter tips'),
      bm('4', 'An agent that cooks: tool use in the kitchen'),
    ],
    (b) => home[b.postId]!,
    WHEN,
  );
  const first = db.getBookmarkByPostId('1')!.id;
  db.saveArticle({
    bookmarkId: first,
    url: 'https://t.co/link1',
    status: 'ok',
    title: 'Building effective agent harnesses',
    contentHtml: `<p>${'Evaluation loops matter. '.repeat(2000)}</p>`,
    excerpt: null,
    siteName: null,
    reason: null,
    fetchedAt: WHEN,
  });
  db.saveSummary({ bookmarkId: first, summary: 'How to structure an **agent harness**.', generatedAt: WHEN });
  db.markRead(db.getBookmarkByPostId('2')!.id, WHEN);
  db.setLastSyncedAt(WHEN);
  // Secrets that live in the same database and must never leave through a tool.
  db.setRefreshToken(REFRESH_TOKEN);
  writeSettings(db, { categorizer: 'claude-cli', configuredAt: WHEN } as never);
}

describe('the MCP endpoint', () => {
  let db: Database;
  let app: FastifyInstance;
  let base: string;
  let token: string;

  beforeEach(async () => {
    db = new Database(':memory:');
    seed(db);
    app = buildServer(db);
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    token = setMcpEnabled(db, true).token!;
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  async function connect(bearer: string = token): Promise<Client> {
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
      }),
    );
    return client;
  }

  async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { type: string; text: string }[])[0]!.text;
    return { isError: result.isError === true, text, json: () => JSON.parse(text) };
  }

  it('lists five read-only tools and one non-destructive write, show_in_app', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'get_bookmark',
      'library_stats',
      'list_categories',
      'list_category_bookmarks',
      'search_bookmarks',
      'show_in_app',
    ]);
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBe(tool.name !== 'show_in_app');
      expect(tool.annotations?.destructiveHint).toBe(false);
    }
    expect(tools.find((t) => t.name === 'show_in_app')!.description).toMatch(/only creates that list/);
    for (const name of ['search_bookmarks', 'get_bookmark', 'list_category_bookmarks']) {
      expect(tools.find((t) => t.name === name)!.description).toMatch(/untrusted third-party content/);
    }
    expect(client.getInstructions()).toMatch(/untrusted/);
    await client.close();
  });

  it('search_bookmarks finds a post by its linked article, with a snippet, url and categories', async () => {
    const client = await connect();
    const answer = (await call(client, 'search_bookmarks', { query: 'harnesses' })).json();
    expect(answer.total).toBe(1);
    expect(answer.results[0]).toMatchObject({
      postId: '1',
      url: 'https://x.com/user1/status/1',
      author: '@user1 (User 1)',
      categories: ['AI > Agents'],
      hasSummary: true,
    });
    expect(answer.results[0].match).toContain('«');
    await client.close();
  });

  it('search_bookmarks filters by category path, date window and read state', async () => {
    const client = await connect();
    const inAi = (await call(client, 'search_bookmarks', { category: 'AI' })).json();
    expect(inAi.results.map((r: { postId: string }) => r.postId).sort()).toEqual(['1', '2', '4']);
    const byPath = (await call(client, 'search_bookmarks', { query: 'agent', category: 'ai / agents' })).json();
    expect(byPath.results.map((r: { postId: string }) => r.postId).sort()).toEqual(['1', '4']);
    const window = (await call(client, 'search_bookmarks', { after: '2024-02-01', before: '2024-03-01' })).json();
    // Both ends inclusive, newest post first.
    expect(window.results.map((r: { postId: string }) => r.postId)).toEqual(['3', '2']);
    const read = (await call(client, 'search_bookmarks', { status: 'read' })).json();
    expect(read.results.map((r: { postId: string }) => r.postId)).toEqual(['2']);
    await client.close();
  });

  it('search_bookmarks answers an unknown category or a bad date as a tool error the model can fix', async () => {
    const client = await connect();
    const unknown = await call(client, 'search_bookmarks', { category: 'Gardening' });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toMatch(/list_categories/);
    const badDate = await call(client, 'search_bookmarks', { after: 'last week' });
    expect(badDate.isError).toBe(true);
    await client.close();
  });

  it('get_bookmark returns the post in full, its article text (capped) and its summary', async () => {
    const client = await connect();
    const answer = (await call(client, 'get_bookmark', { postId: 'https://x.com/user1/status/1' })).json();
    expect(answer).toMatchObject({
      postId: '1',
      url: 'https://x.com/user1/status/1',
      author: { username: 'user1', name: 'User 1' },
      categories: ['AI > Agents'],
      summary: 'How to structure an **agent harness**.',
      linkedArticle: {
        url: 'https://example.com/harnesses',
        title: 'Building effective agent harnesses',
        textTruncated: true,
      },
    });
    expect(answer.linkedArticle.text.length).toBeLessThanOrEqual(ARTICLE_TEXT_CHARS + 1);
    const missing = await call(client, 'get_bookmark', { postId: '404' });
    expect(missing.isError).toBe(true);
    await client.close();
  });

  it('list_categories returns the tree with descriptions and rolled-up counts', async () => {
    const client = await connect();
    const { categories } = (await call(client, 'list_categories')).json();
    const ai = categories.find((c: { name: string }) => c.name === 'AI');
    expect(ai).toMatchObject({ description: 'Machine learning and agents', total: 3, unread: 2 });
    expect(ai.children[0]).toMatchObject({ name: 'Agents', total: 2 });
    await client.close();
  });

  it('list_category_bookmarks pages a category and its sub-categories', async () => {
    const client = await connect();
    const page = (await call(client, 'list_category_bookmarks', { category: 'AI', limit: 2 })).json();
    expect(page.category).toMatchObject({ path: 'AI', total: 3, unread: 2 });
    expect(page).toMatchObject({ total: 3, offset: 0, hasMore: true });
    expect(page.bookmarks).toHaveLength(2);
    const rest = (await call(client, 'list_category_bookmarks', { category: 'AI', limit: 2, offset: 2 })).json();
    expect(rest.hasMore).toBe(false);
    for (const entry of [...page.bookmarks, ...rest.bookmarks]) expect(entry.text.length).toBeLessThanOrEqual(LIST_TEXT_CHARS + 1);
    await client.close();
  });

  it('library_stats counts the library and says when it last synced', async () => {
    const client = await connect();
    expect((await call(client, 'library_stats')).json()).toEqual({
      bookmarks: 4,
      unread: 3,
      read: 1,
      favorites: 0,
      withSummary: 1,
      categories: 3,
      oldestPostAt: '2024-01-01T00:00:00.000Z',
      newestPostAt: '2024-04-01T00:00:00.000Z',
      lastSyncedAt: WHEN,
    });
    await client.close();
  });

  it('writes nothing and never returns a credential, a setting or run_state', async () => {
    const dump = () =>
      JSON.stringify([
        db.getAllBookmarks(),
        db.getAllCategories(),
        db.getSummaryForBookmark(db.getBookmarkByPostId('1')!.id),
        readMcpAccess(db),
      ]);
    const before = dump();
    const client = await connect();
    const answers: string[] = [];
    answers.push((await call(client, 'search_bookmarks', { query: 'agent' })).text);
    answers.push((await call(client, 'search_bookmarks', {})).text);
    for (const id of ['1', '2', '3', '4']) answers.push((await call(client, 'get_bookmark', { postId: id })).text);
    answers.push((await call(client, 'list_categories')).text);
    answers.push((await call(client, 'list_category_bookmarks', { category: 'Cooking' })).text);
    answers.push((await call(client, 'library_stats')).text);
    await client.close();

    expect(dump()).toBe(before);
    const everything = answers.join('\n');
    for (const secret of [REFRESH_TOKEN, token, db.getState(MCP_ACCESS_KEY)!, 'claude-cli', 'configuredAt', 'tokenHash']) {
      expect(everything).not.toContain(secret);
    }
  });

  describe('show_in_app', () => {
    const dumpLibrary = () =>
      JSON.stringify([
        db.getAllBookmarks(),
        db.getAllCategories(),
        [...db.getCategoryIdsForBookmarks(db.getAllBookmarks().map((b) => b.id))],
      ]);

    it('creates a named list in the order given, and touches nothing else', async () => {
      const before = dumpLibrary();
      const client = await connect();
      const res = await call(client, 'show_in_app', {
        postIds: ['3', 'https://x.com/user1/status/1', '1', 'x.com/user4/status/4?s=20'],
        title: '  Eval \n harnesses ',
        note: 'Posts about how to\r\nevaluate agents.',
      });
      await client.close();
      expect(res.isError).toBe(false);
      const answer = res.json();
      expect(answer).toMatchObject({ title: 'Eval harnesses', shown: 3 });
      expect(answer.notFound).toBeUndefined();
      expect(answer.message).toMatch(/3 posts/);
      const list = db.getAssistantList(answer.listId)!;
      expect(list).toMatchObject({ title: 'Eval harnesses', note: 'Posts about how to\nevaluate agents.', count: 3 });
      // Duplicates collapse to the first mention; URLs resolve like get_bookmark's.
      expect(db.getAssistantListBookmarks(list.id).map((b) => b.postId)).toEqual(['3', '1', '4']);
      expect(dumpLibrary()).toBe(before);
    });

    it('reports posts that are not in the library and leaves them out', async () => {
      const client = await connect();
      const answer = (await call(client, 'show_in_app', { postIds: ['2', '404', 'not-a-post'], title: 'Mixed' })).json();
      expect(answer).toMatchObject({ shown: 1, notFound: ['404', 'not-a-post'] });
      expect(answer.message).toMatch(/Left out 2 not in the library: 404, not-a-post/);
      await client.close();
    });

    it('creates nothing when none of the posts is in the library', async () => {
      const client = await connect();
      const res = await call(client, 'show_in_app', { postIds: ['404', '405'], title: 'Nothing' });
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/no list was created/);
      expect(db.getAssistantLists()).toEqual([]);
      await client.close();
    });

    it('enforces its caps: post count, title and note length, empty title', async () => {
      const client = await connect();
      const tooMany = await call(client, 'show_in_app', {
        postIds: Array.from({ length: SHOW_MAX_POSTS + 1 }, () => '1'),
        title: 'Too many',
      });
      expect(tooMany.isError).toBe(true);
      const exactly = await call(client, 'show_in_app', {
        postIds: Array.from({ length: SHOW_MAX_POSTS }, () => '1'),
        title: 'At the cap',
      });
      expect(exactly.json()).toMatchObject({ shown: 1 });
      expect((await call(client, 'show_in_app', { postIds: ['1'], title: 'x'.repeat(SHOW_TITLE_MAX_CHARS + 1) })).isError).toBe(true);
      expect((await call(client, 'show_in_app', { postIds: ['1'], title: '   ' })).isError).toBe(true);
      expect(
        (await call(client, 'show_in_app', { postIds: ['1'], title: 'Long note', note: 'n'.repeat(SHOW_NOTE_MAX_CHARS + 1) }))
          .isError,
      ).toBe(true);
      expect((await call(client, 'show_in_app', { postIds: [], title: 'Empty' })).isError).toBe(true);
      expect(db.getAssistantLists().map((l) => l.title)).toEqual(['At the cap']);
      await client.close();
    });

    it('refuses a new list once the app holds the maximum, and says how to make room', async () => {
      const id = db.getBookmarkByPostId('1')!.id;
      for (let i = 0; i < MAX_ASSISTANT_LISTS; i += 1) db.createAssistantList({ title: `L${i}`, note: null, bookmarkIds: [id] });
      const client = await connect();
      const res = await call(client, 'show_in_app', { postIds: ['1'], title: 'One more' });
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/delete some/);
      expect(db.countAssistantLists()).toBe(MAX_ASSISTANT_LISTS);
      await client.close();
    });

    it('is guarded by the token: a call without it or with a wrong one writes nothing', async () => {
      const showCall = (headers: Record<string, string>) =>
        fetch(`${base}/mcp`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'show_in_app', arguments: { postIds: ['1'], title: 'Sneaky' } },
          }),
        });
      expect((await showCall({})).status).toBe(401);
      expect((await showCall({ authorization: `Bearer ${token}x` })).status).toBe(401);
      setMcpEnabled(db, false);
      expect((await showCall({ authorization: `Bearer ${token}` })).status).toBe(404);
      expect(db.getAssistantLists()).toEqual([]);
      // The same raw call with the live token does write - so the refusals above are the guard, not a broken request.
      setMcpEnabled(db, true);
      const ok = await showCall({ authorization: `Bearer ${token}` });
      expect(ok.status).toBe(200);
      expect(db.getAssistantLists().map((l) => l.title)).toEqual(['Sneaky']);
    });
  });

  describe('authentication', () => {
    const initialize = (headers: Record<string, string>) =>
      fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
        }),
      });

    it('accepts the live token', async () => {
      const res = await initialize({ authorization: `Bearer ${token}` });
      expect(res.status).toBe(200);
    });

    it('refuses a request with no token or a wrong one', async () => {
      const none = await initialize({});
      expect(none.status).toBe(401);
      expect(none.headers.get('www-authenticate')).toMatch(/^Bearer/);
      expect((await initialize({ authorization: `Bearer ${token}x` })).status).toBe(401);
      expect((await initialize({ authorization: token })).status).toBe(401);
      await expect(connect('nope')).rejects.toThrow();
    });

    it('stops accepting the old token once it is regenerated', async () => {
      const fresh = regenerateMcpToken(db).token;
      expect((await initialize({ authorization: `Bearer ${token}` })).status).toBe(401);
      expect((await initialize({ authorization: `Bearer ${fresh}` })).status).toBe(200);
    });

    it('is not there at all while turned off, even with the right token', async () => {
      setMcpEnabled(db, false);
      const res = await initialize({ authorization: `Bearer ${token}` });
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: { message: string } }).error.message).toBe(MCP_DISABLED_MESSAGE);
      // Turning it back on keeps the token an assistant was configured with.
      setMcpEnabled(db, true);
      expect((await initialize({ authorization: `Bearer ${token}` })).status).toBe(200);
    });

    it('answers GET and DELETE with 405 (stateless, no stream to open)', async () => {
      const res = await fetch(`${base}/mcp`, { headers: { authorization: `Bearer ${token}` } });
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('POST');
    });
  });

  describe('browser protections', () => {
    const port = () => (app.server.address() as AddressInfo).port;

    it('refuses a cross-site or same-site browser request, even with the token', async () => {
      for (const site of ['cross-site', 'same-site']) {
        const res = await app.inject({
          method: 'POST',
          url: '/mcp',
          headers: { host: `127.0.0.1:${port()}`, authorization: `Bearer ${token}`, 'sec-fetch-site': site },
          payload: {},
        });
        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual({ error: CROSS_ORIGIN_MESSAGE });
      }
    });

    it('refuses a foreign Host (DNS rebinding) and a foreign Origin', async () => {
      const rebound = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { host: `evil.example:${port()}`, authorization: `Bearer ${token}` },
        payload: {},
      });
      expect(rebound.statusCode).toBe(403);
      expect(rebound.json()).toEqual({ error: UNEXPECTED_HOST_MESSAGE });
      const foreign = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { host: `127.0.0.1:${port()}`, origin: 'https://evil.example', authorization: `Bearer ${token}` },
        payload: {},
      });
      expect(foreign.statusCode).toBe(403);
    });
  });
});

describe('the Settings routes for the MCP endpoint', () => {
  let db: Database;
  let app: FastifyInstance;

  beforeEach(() => {
    db = new Database(':memory:');
    app = buildServer(db);
  });
  afterEach(async () => {
    await app.close();
    db.close();
  });

  it('is off by default, with no token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/mcp', headers: { host: '127.0.0.1:5173' } });
    expect(res.json()).toEqual({
      enabled: false,
      hasToken: false,
      tokenHint: null,
      tokenCreatedAt: null,
      url: 'http://127.0.0.1:5173/mcp',
    });
    const post = await app.inject({ method: 'POST', url: '/mcp', payload: {} });
    expect(post.statusCode).toBe(404);
  });

  it('shows the token once when turning on, and never again', async () => {
    const on = (await app.inject({ method: 'PUT', url: '/api/mcp', payload: { enabled: true } })).json();
    expect(on.enabled).toBe(true);
    expect(on.token).toMatch(/^xbo_mcp_/);
    expect(verifyMcpToken(db, on.token)).toBe(true);
    expect(on.tokenHint).toBe(on.token.slice(-4));

    const read = (await app.inject({ method: 'GET', url: '/api/mcp' })).json();
    expect(read.token).toBeUndefined();
    expect(JSON.stringify(read)).not.toContain(on.token);
    const setup = await app.inject({ method: 'GET', url: '/api/setup' });
    expect(setup.body).not.toContain(on.token);
    // Only a hash is stored.
    expect(db.getState(MCP_ACCESS_KEY)).not.toContain(on.token);

    const off = (await app.inject({ method: 'PUT', url: '/api/mcp', payload: { enabled: false } })).json();
    expect(off).toMatchObject({ enabled: false, hasToken: true });
    expect(off.token).toBeUndefined();
    const again = (await app.inject({ method: 'PUT', url: '/api/mcp', payload: { enabled: true } })).json();
    expect(again.token).toBeUndefined();
    expect(verifyMcpToken(db, on.token)).toBe(true);
  });

  it('regenerates the token, invalidating the old one', async () => {
    const first = (await app.inject({ method: 'PUT', url: '/api/mcp', payload: { enabled: true } })).json().token;
    const second = (await app.inject({ method: 'POST', url: '/api/mcp/token' })).json().token;
    expect(second).not.toBe(first);
    expect(verifyMcpToken(db, first)).toBe(false);
    expect(verifyMcpToken(db, second)).toBe(true);
  });

  it('refuses a malformed toggle', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/mcp', payload: { enabled: 'yes' } });
    expect(res.statusCode).toBe(400);
  });

  it('fails closed on an unreadable access row', () => {
    db.setState(MCP_ACCESS_KEY, '{not json');
    expect(readMcpAccess(db)).toMatchObject({ enabled: false, hasToken: false });
    expect(verifyMcpToken(db, '')).toBe(false);
  });
});
