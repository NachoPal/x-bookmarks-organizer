import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { Database } from '../db/database';
import { buildCategoryTree } from '../categorize/tree';

/** Directory holding the built static viewer assets (relative to this file). */
const PUBLIC_DIR = path.join(__dirname, 'public');

/**
 * Build the local web viewer server. All state comes from the injected
 * {@link Database}; the server itself is stateless and safe to restart.
 */
export function buildServer(db: Database): FastifyInstance {
  const app = Fastify({ logger: false });

  app.register(fastifyStatic, { root: PUBLIC_DIR });

  // The category tree with rolled-up total/unread counts per node.
  app.get('/api/tree', async () => ({ tree: buildCategoryTree(db) }));

  // Direct bookmarks of one category node.
  app.get<{ Params: { id: string } }>('/api/categories/:id/bookmarks', async (req, reply) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'invalid category id' });
    return { bookmarks: db.getBookmarksForCategory(id) };
  });

  // Mark a bookmark read (records the timestamp the first time only).
  app.post<{ Params: { id: string } }>('/api/bookmarks/:id/read', async (req, reply) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'invalid bookmark id' });
    const updated = db.markRead(id);
    if (!updated) return reply.code(404).send({ error: 'bookmark not found' });
    return { bookmark: updated };
  });

  return app;
}

/** Start the viewer and return the running instance. */
export async function startServer(db: Database, port: number, host = '127.0.0.1'): Promise<FastifyInstance> {
  const app = buildServer(db);
  await app.listen({ port, host });
  return app;
}
