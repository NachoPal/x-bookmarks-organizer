import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Database } from '../db/database';
import { readMcpAccess, regenerateMcpToken, setMcpEnabled, verifyMcpToken } from './access';
import { createMcpServer } from './tools';
import { PACKAGE_ROOT } from '../paths';

/** Where the endpoint lives on the viewer. */
export const MCP_PATH = '/mcp';

export const MCP_DISABLED_MESSAGE =
  'The MCP endpoint is turned off. Turn it on in the app: Settings > AI assistants (MCP).';
export const MCP_UNAUTHORIZED_MESSAGE =
  'Missing or wrong token. Send "Authorization: Bearer <token>" with the token from Settings > AI assistants (MCP).';

/** The app's own package version, reported to MCP clients. */
const VERSION = (JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { version: string })
  .version;

function jsonRpcError(reply: FastifyReply, code: number, message: string) {
  return reply.code(code).send({ jsonrpc: '2.0', error: { code: -32000, message }, id: null });
}

/**
 * The URL an assistant should connect to: the loopback address and port this
 * server ACTUALLY bound, so an overridden `XBOOKMARKS_WEB_PORT` is reflected
 * in every copied snippet. `127.0.0.1` rather than `localhost`, which can
 * resolve to `::1` first and miss a server bound to IPv4 only. A server that
 * is not listening (tests driving `app.inject()`) falls back to the Host the
 * request was addressed to.
 */
function endpointUrl(app: FastifyInstance, req: FastifyRequest): string {
  const address = app.server.address();
  if (address && typeof address === 'object') return `http://127.0.0.1:${address.port}${MCP_PATH}`;
  return `http://${req.headers.host ?? '127.0.0.1'}${MCP_PATH}`;
}

/**
 * Serve the read-only MCP endpoint at {@link MCP_PATH}, plus the Settings
 * panel's routes that switch it on and issue its token.
 *
 * Order of refusals on `/mcp`, each before any tool code runs: the viewer's
 * Host/Origin/Sec-Fetch-Site guard (`installLocalOriginGuard`, which covers
 * this path like `/api/`), then 404 while the endpoint is off - it does not
 * exist until the owner turns it on - then 401 without the live bearer token.
 *
 * Stateless: every POST gets a fresh `McpServer` + transport that live for
 * that one request, so there is no session to hijack or leak between clients,
 * and nothing is kept once the answer is sent. There is no server-to-client
 * stream to open, so GET and DELETE answer 405, as the Streamable HTTP spec
 * allows for a server without one.
 */
export function installMcpEndpoint(app: FastifyInstance, db: Database): void {
  const gate = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!readMcpAccess(db).enabled) return jsonRpcError(reply, 404, MCP_DISABLED_MESSAGE);
    const header = req.headers.authorization ?? '';
    const token = /^Bearer\s+(\S+)\s*$/i.exec(header)?.[1] ?? '';
    if (!verifyMcpToken(db, token)) {
      reply.header('WWW-Authenticate', 'Bearer realm="x-bookmarks-organizer"');
      return jsonRpcError(reply, 401, MCP_UNAUTHORIZED_MESSAGE);
    }
    return undefined;
  };

  app.post(MCP_PATH, async (req, reply) => {
    const refused = await gate(req, reply);
    if (refused) return refused;

    const server = createMcpServer(db, VERSION);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req.raw, reply.raw, req.body);
    } catch {
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'content-type': 'application/json' });
        reply.raw.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null }));
      }
    }
  });

  const notAllowed = async (req: FastifyRequest, reply: FastifyReply) => {
    const refused = await gate(req, reply);
    if (refused) return refused;
    reply.header('Allow', 'POST');
    return jsonRpcError(reply, 405, 'Method not allowed: this server is stateless and answers POST only.');
  };
  app.get(MCP_PATH, notAllowed);
  app.delete(MCP_PATH, notAllowed);

  // ---- Settings > AI assistants (MCP) -----------------------------------
  // The token's plaintext appears in exactly two responses - the one that
  // turns the endpoint on for the first time, and "Regenerate" - and nowhere
  // else, ever (`access.ts`).

  app.get('/api/mcp', async (req) => ({ ...readMcpAccess(db), url: endpointUrl(app, req) }));

  app.put<{ Body?: { enabled?: unknown } }>('/api/mcp', async (req, reply) => {
    const enabled = (req.body ?? {}).enabled;
    if (typeof enabled !== 'boolean') return reply.code(400).send({ error: 'Send { "enabled": true } or { "enabled": false }.' });
    const { token, access } = setMcpEnabled(db, enabled);
    return { ...access, url: endpointUrl(app, req), ...(token ? { token } : {}) };
  });

  app.post('/api/mcp/token', async (req) => {
    const { token, access } = regenerateMcpToken(db);
    return { ...access, url: endpointUrl(app, req), token };
  });
}
