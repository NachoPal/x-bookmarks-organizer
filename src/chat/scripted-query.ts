import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { CHAT_MCP_SERVER, type QueryFn } from './claude';
import type { McpToolName } from '../mcp/tools';

/**
 * An OFFLINE stand-in for the Agent SDK's `query`: it plays a script of text
 * and tool calls as Claude Code's message stream would, and runs every tool
 * call against the REAL in-process MCP server it was handed (through an
 * in-memory MCP client) - so a `show_in_app` really creates a list. No model,
 * no network, no subscription quota.
 *
 * Used by the chat tests and by `scripts/serve-chat-demo.js`, the way to
 * drive the chat UI end to end. Never wired by `cmdServe`.
 */
export type ScriptedTurn =
  | { text: string }
  | { tool: McpToolName; input: Record<string, unknown> }
  | { error: string };

export interface ScriptedQueryOptions {
  /** Delay between streamed pieces, so a browser can watch the reply arrive. */
  delayMs?: number;
}

/** Every call the fake received, for a test to inspect. */
export interface ScriptedCall {
  prompt: string;
  options: Options;
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Claude Code process aborted by user'));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('Claude Code process aborted by user'));
      },
      { once: true },
    );
  });
}

/** The text in pieces of a few words, as a stream delivers it. */
function pieces(text: string): string[] {
  return text.match(/\S+\s*|\s+/g) ?? [];
}

export function scriptedQuery(
  script: (prompt: string, options: Options) => ScriptedTurn[],
  opts: ScriptedQueryOptions = {},
): QueryFn & { calls: ScriptedCall[] } {
  const calls: ScriptedCall[] = [];
  const run = (params: Parameters<QueryFn>[0]): AsyncIterable<SDKMessage> => {
    const prompt = typeof params.prompt === 'string' ? params.prompt : '';
    const options = params.options ?? {};
    calls.push({ prompt, options });
    return play(script(prompt, options), options, opts.delayMs ?? 0);
  };
  return Object.assign(run, { calls });
}

async function* play(turns: ScriptedTurn[], options: Options, delayMs: number): AsyncGenerator<SDKMessage> {
  const signal = options.abortController?.signal;
  const config = options.mcpServers?.[CHAT_MCP_SERVER];
  const instance = config && 'instance' in config ? (config.instance as unknown as McpServer) : undefined;
  let client: Client | undefined;
  const base = { session_id: 'scripted', uuid: '00000000-0000-0000-0000-000000000000', parent_tool_use_id: null };
  let last = '';
  let n = 0;
  try {
    for (const turn of turns) {
      n += 1;
      if ('error' in turn) throw new Error(turn.error);
      if ('text' in turn) {
        yield { ...base, type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } } as unknown as SDKMessage;
        for (const piece of pieces(turn.text)) {
          await sleep(delayMs, signal);
          yield { ...base, type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } } } as unknown as SDKMessage;
        }
        last = turn.text;
        continue;
      }
      const name = `mcp__${CHAT_MCP_SERVER}__${turn.tool}`;
      const id = `toolu_${n}`;
      yield { ...base, type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } } } as unknown as SDKMessage;
      await sleep(delayMs * 4, signal);
      yield { ...base, type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input: turn.input }] } } as unknown as SDKMessage;
      if (!options.allowedTools?.includes(name)) {
        yield { ...base, type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: 'Permission denied.' }] } } as unknown as SDKMessage;
        continue;
      }
      if (!client) {
        if (!instance) throw new Error(`No "${CHAT_MCP_SERVER}" MCP server was given.`);
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        await instance.connect(serverSide);
        client = new Client({ name: 'scripted-query', version: '0.0.0' });
        await client.connect(clientSide);
      }
      const result = await client.callTool({ name: turn.tool, arguments: turn.input });
      yield { ...base, type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: result.isError === true, content: result.content }] } } as unknown as SDKMessage;
    }
    yield { ...base, type: 'result', subtype: 'success', is_error: false, result: last } as unknown as SDKMessage;
  } finally {
    await client?.close();
  }
}
