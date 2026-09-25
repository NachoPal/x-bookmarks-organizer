import { describe, it, expect } from 'vitest';

// Plain browser JS, required directly (not compiled by tsc).
const XBO = require('./mcp-settings.js');

const URL = 'http://127.0.0.1:5199/mcp';
const TOKEN = 'xbo_mcp_abc123';

describe('XBOMcpSettings.snippet', () => {
  it('builds the Claude Code command with the real URL and token, at user scope', () => {
    expect(XBO.snippet('claude-code', URL, TOKEN)).toBe(
      `claude mcp add --transport http --scope user xbookmarks ${URL} --header "Authorization: Bearer ${TOKEN}"`,
    );
  });

  it('builds a Codex block that reads the token from an environment variable', () => {
    const text = XBO.snippet('codex', URL, TOKEN);
    expect(text).toContain('[mcp_servers.xbookmarks]');
    expect(text).toContain(`url = "${URL}"`);
    expect(text).toContain('bearer_token_env_var = "XBOOKMARKS_MCP_TOKEN"');
    expect(text).toContain(`export XBOOKMARKS_MCP_TOKEN="${TOKEN}"`);
    // The token is never written into the TOML itself.
    expect(text.split('# In your shell profile:')[0]).not.toContain(TOKEN);
  });

  it('builds valid JSON with url + headers', () => {
    expect(JSON.parse(XBO.snippet('json', URL, TOKEN))).toEqual({
      mcpServers: { xbookmarks: { type: 'http', url: URL, headers: { Authorization: `Bearer ${TOKEN}` } } },
    });
  });

  it('uses a placeholder, never a working value, once the page no longer holds the token', () => {
    for (const client of XBO.CLIENTS) {
      expect(XBO.snippet(client.id, URL, null)).toContain(XBO.TOKEN_PLACEHOLDER);
    }
  });

  it('falls back to the first client for an unknown id', () => {
    expect(XBO.snippet('nope', URL, TOKEN)).toBe(XBO.snippet('claude-code', URL, TOKEN));
  });
});

describe('XBOMcpSettings.statusText', () => {
  it('reads off, and on with the URL and which token is live', () => {
    expect(XBO.statusText({ enabled: false })).toMatch(/^Off\./);
    expect(XBO.statusText(null)).toMatch(/^Off\./);
    expect(
      XBO.statusText({ enabled: true, url: URL, tokenHint: 'wxyz', tokenCreatedAt: '2026-09-25T10:00:00.000Z' }),
    ).toBe(`On at ${URL}, token ending wxyz (created 2026-09-25).`);
  });
});
