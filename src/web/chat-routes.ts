import type { FastifyInstance } from 'fastify';
import type { AssistantList, ChatConversation, ChatMessage, Database } from '../db/database';
import { CHAT_EFFORTS, DEFAULT_CHAT_EFFORT, DEFAULT_CHAT_MODEL, chatModels, isChatEffort } from '../chat/catalog';
import { ChatError, streamReply, type ChatToolActivity, type QueryFn } from '../chat/claude';
import { chatReplyPrompt, chatSystemPrompt } from '../chat/prompt';
import { MCP_SERVER_VERSION } from '../mcp/http';
import { createMcpServer } from '../mcp/tools';

/**
 * The in-app "Ask Claude" chat's routes (top bar, left of the gear).
 *
 * Conversations live in the app's own database (`chat_conversations` /
 * `chat_messages`), so the read routes and delete need nothing but `db` and
 * are live on a test-built `buildServer(db)`. Sending a message needs the
 * wiring (`ChatWiring.run`, Claude Code through the Agent SDK); without it the
 * send answers 503 with {@link CHAT_UNAVAILABLE_MESSAGE}.
 *
 * The chat's tools are the MCP endpoint's own server (`createMcpServer`),
 * built fresh per reply and handed to Claude Code IN-PROCESS - so they work
 * whether or not the external `/mcp` endpoint is switched on, need no token,
 * and cannot diverge from what an outside assistant gets. `show_in_app`
 * publishes to the same `onListCreated` the endpoint does, which is what puts
 * the "Your assistant sent…" toast and the Lists page in front of the owner.
 *
 * Every write is a POST/DELETE, so the viewer's Origin guard covers it.
 */

export const CHAT_UNAVAILABLE_MESSAGE =
  'The chat is not wired into this viewer. Start it with `xbo serve` (or `npm run serve`) to ask Claude.';

export const CHAT_MAX_MESSAGE_CHARS = 20_000;

export interface ChatWiring {
  /** Runs Claude Code - `sdkQuery`; tests and the offline demo pass a fake. */
  run: QueryFn;
  /** `CLAUDE_CODE_OAUTH_TOKEN` through the credential chain, read per reply; absent for a CLI logged in interactively. */
  oauthToken?: () => string | undefined;
}

export interface ChatRouteOptions {
  chat?: ChatWiring;
  /** Whether Claude Code can run right now: the `claude-cli` availability probe the settings form already trusts. */
  status: () => Promise<{ available: boolean; reason?: string }>;
  /** A `show_in_app` list was stored. */
  onListCreated: (list: AssistantList) => void;
}

/**
 * One server-sent event of a reply's stream (`data: <json>\n\n`):
 * - `text`: the next piece of the reply as Claude writes it;
 * - `step`: what Claude is doing now ("Searching bookmarks…");
 * - `tool`: a tool call finished (its chip);
 * - `done`: the saved exchange, and the conversation, new or updated;
 * - `error`: the reply failed and nothing was saved; `message` says how to fix it.
 */
export type ChatStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'step'; step: string }
  | { type: 'tool'; tool: ChatToolActivity }
  | { type: 'done'; conversation: ChatConversation; messages: ChatMessage[] }
  | { type: 'error'; error: { kind: string; message: string } };

function parseId(raw: string): number | null {
  const id = Number.parseInt(raw, 10);
  return Number.isInteger(id) && id > 0 && String(id) === raw ? id : null;
}

export function installChatRoutes(app: FastifyInstance, db: Database, opts: ChatRouteOptions): void {
  const models = chatModels();
  const modelIds = new Set(models.map((m) => m.id));
  /** Replies being written, by the client's request id, so Stop can end one. */
  const running = new Map<string, { controller: AbortController; conversationId: number | null }>();

  app.get('/api/chat', async () => {
    const status = opts.chat ? await opts.status() : { available: false, reason: CHAT_UNAVAILABLE_MESSAGE };
    return {
      available: status.available,
      ...(status.reason ? { reason: status.reason } : {}),
      models,
      efforts: CHAT_EFFORTS,
      defaults: { model: DEFAULT_CHAT_MODEL, effort: DEFAULT_CHAT_EFFORT },
    };
  });

  app.get('/api/chat/conversations', async () => ({ conversations: db.listChatConversations() }));

  app.get<{ Params: { id: string } }>('/api/chat/conversations/:id', async (req, reply) => {
    const id = parseId(req.params.id);
    const conversation = id === null ? undefined : db.getChatConversation(id);
    if (!conversation) return reply.code(404).send({ error: 'That conversation no longer exists.' });
    return { conversation, messages: db.getChatMessages(conversation.id) };
  });

  app.delete<{ Params: { id: string } }>('/api/chat/conversations/:id', async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return reply.code(400).send({ error: 'invalid conversation id' });
    // A reply still being written into it would only fail to save: stop it now.
    for (const run of running.values()) if (run.conversationId === id) run.controller.abort();
    if (!db.deleteChatConversation(id)) return reply.code(404).send({ error: 'That conversation no longer exists.' });
    return reply.code(204).send();
  });

  app.post<{ Params: { requestId: string } }>('/api/chat/replies/:requestId/stop', async (req, reply) => {
    const run = running.get(req.params.requestId);
    if (!run) return reply.code(404).send({ error: 'That reply has already finished.' });
    run.controller.abort();
    return reply.code(204).send();
  });

  app.post('/api/chat/messages', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) return reply.code(400).send({ error: 'Write a message first.' });
    if (text.length > CHAT_MAX_MESSAGE_CHARS) {
      return reply
        .code(400)
        .send({ error: `A message can be at most ${CHAT_MAX_MESSAGE_CHARS.toLocaleString('en-US')} characters.` });
    }
    const model = typeof body.model === 'string' && modelIds.has(body.model) ? body.model : undefined;
    if (!model) return reply.code(400).send({ error: 'Pick a model from the list.' });
    if (!isChatEffort(body.effort)) return reply.code(400).send({ error: `effort must be one of ${CHAT_EFFORTS.join(', ')}.` });
    const effort = body.effort;
    const conversationId = body.conversationId ?? null;
    if (conversationId !== null && (typeof conversationId !== 'number' || !db.getChatConversation(conversationId))) {
      return reply.code(404).send({ error: 'That conversation no longer exists.' });
    }
    const requestId = typeof body.requestId === 'string' && /^[\w-]{1,100}$/.test(body.requestId) ? body.requestId : null;
    if (requestId === null) return reply.code(400).send({ error: 'requestId is required.' });
    if (running.has(requestId)) return reply.code(409).send({ error: 'That reply is already running.' });
    if (conversationId !== null && [...running.values()].some((r) => r.conversationId === conversationId)) {
      return reply.code(409).send({ error: 'Claude is still answering in this conversation. Wait, or press Stop.' });
    }

    const chat = opts.chat;
    if (!chat) return reply.code(503).send({ error: CHAT_UNAVAILABLE_MESSAGE });
    const status = await opts.status();
    if (!status.available) return reply.code(503).send({ error: status.reason ?? CHAT_UNAVAILABLE_MESSAGE });

    const history = conversationId === null ? [] : db.getChatMessages(conversationId);
    const controller = new AbortController();
    running.set(requestId, { controller, conversationId });

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-accel-buffering': 'no',
    });
    const send = (event: ChatStreamEvent) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    // Leaving the page (the request closing before the answer is complete) stops Claude Code.
    res.on('close', () => {
      if (!res.writableFinished) controller.abort();
    });

    const tools: ChatToolActivity[] = [];
    let streamed = '';
    let finished = false;
    try {
      let replyText: string | null = null;
      let stopped = false;
      try {
        replyText = await streamReply(chat.run, {
          prompt: chatReplyPrompt(history, text),
          systemPrompt: chatSystemPrompt(db),
          model,
          effort,
          mcpServer: createMcpServer(db, MCP_SERVER_VERSION, { onListCreated: opts.onListCreated }),
          signal: controller.signal,
          oauthToken: chat.oauthToken?.(),
          onText: (piece) => {
            streamed += piece;
            send({ type: 'text', text: piece });
          },
          onStep: (step) => send({ type: 'step', step }),
          onTool: (activity) => {
            if (finished) return;
            tools.push(activity);
            send({ type: 'tool', tool: activity });
          },
        });
      } catch (error) {
        const failure = error instanceof ChatError ? error : new ChatError('failed', `The reply failed: ${(error as Error).message}`);
        if (failure.kind === 'stopped' && (streamed.trim() || tools.length > 0)) {
          // What was written before Stop is kept, marked as stopped.
          replyText = streamed;
          stopped = true;
        } else {
          if (failure.kind !== 'stopped') console.warn(`Chat: reply failed (${failure.kind}): ${failure.detail ?? failure.message}`);
          send({ type: 'error', error: { kind: failure.kind, message: failure.message } });
        }
      }
      if (replyText !== null) {
        const exchange = db.saveChatExchange({ conversationId, userText: text, replyText, model, effort, stopped, tools });
        if (exchange) send({ type: 'done', ...exchange });
        else send({ type: 'error', error: { kind: 'failed', message: 'This conversation was deleted while Claude was answering.' } });
      }
    } catch (error) {
      console.error('Chat: the reply could not be saved', error);
      send({ type: 'error', error: { kind: 'failed', message: 'The reply could not be saved. Try sending it again.' } });
    } finally {
      finished = true;
      running.delete(requestId);
      res.end();
    }
  });
}
