import type { FastifyInstance } from 'fastify';
import type { ServerResponse } from 'node:http';
import type { AssistantList, Database } from '../db/database';
import type { StoredBookmark } from '../types';

/**
 * Assistant result lists in the viewer: the routes the sidebar's "Lists" page
 * reads, marks viewed and deletes through, and the live stream that puts a
 * list an assistant just sent (MCP `show_in_app`, `src/mcp/tools.ts`) in front
 * of the owner without a reload.
 *
 * A list is a VIEW. Nothing here files, moves or deletes a post: deleting a
 * list removes the list and nothing else.
 */

/** What the live stream announces. `changed` = a list was deleted or viewed; re-read the index. */
export type AssistantListEvent = { type: 'created'; list: AssistantList } | { type: 'changed' };

/**
 * The in-process fan-out from the MCP endpoint (and the delete routes) to
 * every open app tab's event stream. One per server.
 */
export class AssistantListEvents {
  private readonly listeners = new Set<(event: AssistantListEvent) => void>();

  subscribe(listener: (event: AssistantListEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: AssistantListEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  get size(): number {
    return this.listeners.size;
  }
}

/** Where the live stream lives. */
export const ASSISTANT_LIST_EVENTS_PATH = '/api/assistant-lists/events';

/** A comment line every so often, so an idle stream is not dropped by anything in between. */
const HEARTBEAT_MS = 25_000;

function parseId(raw: string): number | null {
  const id = Number.parseInt(raw, 10);
  return Number.isInteger(id) && String(id) === raw ? id : null;
}

/**
 * Serve the lists. `toBookmarks` turns stored rows into the viewer's card
 * shape (the same one a category page ships), so a list's cards behave like
 * every other card.
 */
export function installAssistantListRoutes(
  app: FastifyInstance,
  db: Database,
  events: AssistantListEvents,
  toBookmarks: (bookmarks: StoredBookmark[]) => unknown[],
): void {
  app.get('/api/assistant-lists', async () => ({ lists: db.getAssistantLists() }));

  // Every post at once: a list holds at most `SHOW_MAX_POSTS`, so there is no paging.
  app.get<{ Params: { id: string } }>('/api/assistant-lists/:id', async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return reply.code(400).send({ error: 'invalid list id' });
    const list = db.getAssistantList(id);
    if (!list) return reply.code(404).send({ error: 'list not found' });
    return { list, bookmarks: toBookmarks(db.getAssistantListBookmarks(id)) };
  });

  // The owner opened the list. A POST, not a side effect of the GET above:
  // no route that writes may be a GET (the Origin guard skips GET/HEAD).
  // Only a real change is announced, so every open tab's "Lists" count
  // follows it without re-reading on every repeat open.
  app.post<{ Params: { id: string } }>('/api/assistant-lists/:id/viewed', async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return reply.code(400).send({ error: 'invalid list id' });
    const changed = db.markAssistantListViewed(id);
    if (changed === undefined) return reply.code(404).send({ error: 'list not found' });
    if (changed) events.publish({ type: 'changed' });
    return { list: db.getAssistantList(id) };
  });

  app.delete<{ Params: { id: string } }>('/api/assistant-lists/:id', async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return reply.code(400).send({ error: 'invalid list id' });
    if (!db.deleteAssistantList(id)) return reply.code(404).send({ error: 'list not found' });
    events.publish({ type: 'changed' });
    return reply.code(204).send();
  });

  // `{ ids: [...] }` deletes exactly those (what the app sends, so a list that
  // arrived while "Clear all" waited out its undo window is not swept up);
  // no body deletes every list.
  app.delete<{ Body?: { ids?: unknown } }>('/api/assistant-lists', async (req, reply) => {
    const ids = req.body?.ids;
    if (ids !== undefined && !(Array.isArray(ids) && ids.every((id) => Number.isInteger(id)))) {
      return reply.code(400).send({ error: 'Send { "ids": [<list id>, …] }, or no body to delete every list.' });
    }
    const deleted =
      ids === undefined
        ? db.clearAssistantLists()
        : (ids as number[]).filter((id) => db.deleteAssistantList(id)).length;
    if (deleted > 0) events.publish({ type: 'changed' });
    return { deleted };
  });

  // The live stream (Server-Sent Events). Same-origin by construction: it sits
  // under `/api/`, so the Host/Origin/Sec-Fetch-Site guard covers it like every
  // other route, and a browser's `EventSource` reconnects on its own after a
  // restart - the client re-reads the index on every (re)connect, so a list
  // sent while it was away is never missed.
  const open = new Set<ServerResponse>();
  app.get(ASSISTANT_LIST_EVENTS_PATH, (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    res.write('retry: 3000\n\n');
    const unsubscribe = events.subscribe((event) => {
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.type === 'created' ? event.list : {})}\n\n`);
    });
    const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
    heartbeat.unref();
    open.add(res);
    req.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      open.delete(res);
    });
  });

  // An open stream is a live connection, which would hold `app.close()` open forever.
  app.addHook('preClose', (done) => {
    for (const res of open) res.end();
    done();
  });
}
