import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer, CROSS_ORIGIN_MESSAGE, UNEXPECTED_HOST_MESSAGE } from './server';
import { Database } from '../db/database';
import type { RawBookmark } from '../types';

/**
 * Security review finding 2: the viewer binds to `127.0.0.1`, which stops a LAN
 * peer but not DNS rebinding. A rebound page is SAME-ORIGIN with the viewer, so
 * CORS never enters into it and an unauthenticated local API - including the
 * irreversible `DELETE /api/categories/:id` - is fully reachable. The request
 * still carries the attacker's hostname in `Host`, which is what is checked.
 */

const bm = (postId: string): RawBookmark => ({
  postId,
  authorUsername: 'a',
  authorName: 'A',
  text: `t-${postId}`,
  url: `https://x.com/a/status/${postId}`,
  postCreatedAt: '',
});

describe('Host/Origin guard on the viewer (security review finding 2)', () => {
  let db: Database;
  let app: FastifyInstance;
  let port: number;
  let categoryId: number;

  beforeEach(async () => {
    db = new Database(':memory:');
    const when = new Date().toISOString();
    categoryId = db.getOrCreateCategory('Tech', null, when).id;
    db.storeCategorizedBatch([bm('1')], () => [categoryId], when);
    app = buildServer(db);
    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  const loopbackHost = () => `127.0.0.1:${port}`;

  it('refuses a request whose Host is not this server (the rebinding case)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/tree',
      headers: { host: `evil.example:${port}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: UNEXPECTED_HOST_MESSAGE });
  });

  it('refuses the irreversible category delete a rebound page would reach', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/categories/${categoryId}`,
      headers: { host: `evil.example:${port}`, origin: `http://evil.example:${port}` },
    });
    expect(res.statusCode).toBe(403);
    expect(db.getBookmarkCount()).toBe(1);
    expect(db.getAllCategories()).toHaveLength(1);
  });

  it('refuses a request with the right Host but a foreign Origin, whatever the method', async () => {
    for (const method of ['POST', 'PUT', 'DELETE'] as const) {
      const res = await app.inject({
        method,
        url: '/api/sync',
        headers: { host: loopbackHost(), origin: 'https://evil.example' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: CROSS_ORIGIN_MESSAGE });
    }
  });

  it('refuses an opaque ("null") Origin on a state-changing request', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sync',
      headers: { host: loopbackHost(), origin: 'null' },
    });
    expect(res.statusCode).toBe(403);
  });

  it.each(['127.0.0.1', 'localhost', '[::1]'])('accepts the loopback Host %s the app itself uses', async (name) => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/tree',
      headers: { host: `${name}:${port}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it("accepts the app's own same-origin state-changing call", async () => {
    // /api/sync has no wiring on a test-built server, so it answers 503 - the
    // point is that it reached the route at all rather than being refused 403.
    const res = await app.inject({
      method: 'POST',
      url: '/api/sync',
      headers: { host: loopbackHost(), origin: `http://127.0.0.1:${port}` },
    });
    expect(res.statusCode).not.toBe(403);
  });

  it('leaves a same-origin GET without an Origin header alone', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/tree', headers: { host: loopbackHost() } });
    expect(res.statusCode).toBe(200);
  });

  it('refuses over a real socket, exactly as a rebound browser would send it', async () => {
    const raw = (request: string) =>
      new Promise<string>((resolve) => {
        const socket = net.connect(port, '127.0.0.1', () => socket.write(request));
        let out = '';
        socket.on('data', (chunk) => (out += chunk));
        socket.on('end', () => resolve(out));
      });

    const refused = await raw(
      `DELETE /api/categories/${categoryId} HTTP/1.1\r\n` +
        `Host: evil.example:${port}\r\n` +
        `Origin: http://evil.example:${port}\r\n` +
        'Connection: close\r\n\r\n',
    );
    expect(refused.split('\r\n')[0]).toContain('403');
    expect(db.getBookmarkCount()).toBe(1);

    const allowed = await raw(`GET /api/tree HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    expect(allowed.split('\r\n')[0]).toContain('200');
  });
});

describe('the guard stands down for a server that never listened', () => {
  it('leaves an injected request on a buildServer(db) alone, so route tests keep working', async () => {
    const db = new Database(':memory:');
    const app = buildServer(db);
    await app.ready();
    try {
      // light-my-request's default Host is `localhost:80`, which matches no
      // bound port - and there is no socket to rebind, so nothing to refuse.
      const res = await app.inject({ method: 'GET', url: '/api/tree' });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
      db.close();
    }
  });
});
