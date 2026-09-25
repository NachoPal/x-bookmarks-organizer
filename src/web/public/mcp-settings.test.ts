import { describe, it, expect } from 'vitest';

// Plain browser JS, required directly (not compiled by tsc).
const XBO = require('./mcp-settings.js');

const URL = 'http://127.0.0.1:5199/mcp';
const TOKEN = 'xbo_mcp_abc123';

describe('XBOMcpSettings.snippet', () => {
  it('builds the Claude Code command with the real URL and the placeholder, at user scope', () => {
    expect(XBO.snippet('claude-code', URL)).toBe(
      `claude mcp add --transport http --scope user xbookmarks ${URL} --header "Authorization: Bearer <YOUR_TOKEN>"`,
    );
  });

  it('builds a Codex block that reads the token from an environment variable', () => {
    const text = XBO.snippet('codex', URL);
    expect(text).toContain('[mcp_servers.xbookmarks]');
    expect(text).toContain(`url = "${URL}"`);
    expect(text).toContain('bearer_token_env_var = "XBOOKMARKS_MCP_TOKEN"');
    expect(text).toContain('export XBOOKMARKS_MCP_TOKEN="<YOUR_TOKEN>"');
  });

  it('builds valid JSON with url + headers', () => {
    expect(JSON.parse(XBO.snippet('json', URL))).toEqual({
      mcpServers: { xbookmarks: { type: 'http', url: URL, headers: { Authorization: 'Bearer <YOUR_TOKEN>' } } },
    });
  });

  it('never carries a token, even when one is passed (issue #141)', () => {
    expect(XBO.TOKEN_PLACEHOLDER).toBe('<YOUR_TOKEN>');
    for (const client of XBO.CLIENTS) {
      const text = XBO.snippet(client.id, URL, TOKEN);
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain('xbo_mcp_');
      expect(text).toContain(XBO.TOKEN_PLACEHOLDER);
    }
  });

  it('falls back to the first client for an unknown id', () => {
    expect(XBO.snippet('nope', URL)).toBe(XBO.snippet('claude-code', URL));
  });
});

describe('XBOMcpSettings.statusText', () => {
  it('reads off, or on with the URL - and never names the token', () => {
    expect(XBO.statusText({ enabled: false })).toMatch(/^Off\./);
    expect(XBO.statusText(null)).toMatch(/^Off\./);
    expect(XBO.statusText({ enabled: true, url: URL, tokenHint: 'xbo_mcp_ab12\u20269f3c' })).toBe(`On at ${URL}.`);
  });
});

describe('XBOMcpSettings.tokenLine', () => {
  const created = '2026-09-25T10:00:00.000Z';

  it('identifies the live token by its masked hint and creation date', () => {
    expect(XBO.tokenLine({ hasToken: true, tokenHint: 'xbo_mcp_ab12\u20269f3c', tokenCreatedAt: created })).toBe(
      'Active token xbo_mcp_ab12\u20269f3c, created 2026-09-25.',
    );
  });

  it('falls back to the date alone for a token stored without a hint', () => {
    expect(XBO.tokenLine({ hasToken: true, tokenHint: null, tokenCreatedAt: created })).toBe(
      'Active token created 2026-09-25.',
    );
  });

  it('splits the line so the page can set the hint in code type', () => {
    expect(XBO.tokenLineParts({ hasToken: true, tokenHint: 'xbo_mcp_ab12\u20269f3c', tokenCreatedAt: created })).toEqual({
      lead: 'Active token ',
      hint: 'xbo_mcp_ab12\u20269f3c',
      trail: ', created 2026-09-25.',
    });
    expect(XBO.tokenLineParts({ hasToken: false })).toBeNull();
  });

  it('says nothing when there is no token', () => {
    expect(XBO.tokenLine({ hasToken: false, tokenHint: null, tokenCreatedAt: null })).toBe('');
    expect(XBO.tokenLine(null)).toBe('');
  });
});
