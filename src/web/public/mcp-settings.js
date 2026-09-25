"use strict";

/**
 * Pure helpers behind Settings > "AI assistants (MCP)": the ready-to-paste
 * config for each AI tool, and the status line.
 *
 * The DOM-free half, in the same style as `paid-spend.js`: `app.js` owns the
 * markup, this module owns the words and the snippets and is unit-tested
 * offline. The server shape is `GET /api/mcp` (`src/mcp/http.ts`):
 * `{ enabled, hasToken, tokenHint, tokenCreatedAt, url }`, plus `token` on the
 * one response that generated it.
 *
 * A snippet is built from the URL the SERVER reports (the port it actually
 * bound), never from `location`, and carries the real token only when the page
 * still holds it - otherwise {@link TOKEN_PLACEHOLDER}, which is never a
 * working value.
 *
 * Browser global (no modules in this viewer) + CommonJS export for the test.
 */
(function (root) {
  /** The name the snippets register the server under. */
  var SERVER_NAME = "xbookmarks";
  /** Codex reads the token from this environment variable rather than from its config file. */
  var TOKEN_ENV_VAR = "XBOOKMARKS_MCP_TOKEN";
  var TOKEN_PLACEHOLDER = "<your-token>";

  var CLIENTS = [
    {
      id: "claude-code",
      label: "Claude Code",
      note:
        "Run it in a terminal. --scope user makes it available in every project; leave it out to add it to " +
        "the current project only. Avoid --scope project: it writes the token into .mcp.json, which gets committed.",
    },
    {
      id: "codex",
      label: "Codex",
      note:
        "Add the block to ~/.codex/config.toml (every project) or a project's .codex/config.toml, and put the " +
        "export line in your shell profile so the token stays out of the config file.",
    },
    {
      id: "json",
      label: "Other (JSON config)",
      note:
        "For tools configured with an mcpServers JSON file. Prefer the tool's user-level file, so the token " +
        "never lands in a repository.",
    },
  ];

  function clientById(id) {
    for (var i = 0; i < CLIENTS.length; i++) if (CLIENTS[i].id === id) return CLIENTS[i];
    return CLIENTS[0];
  }

  /** The config text for `clientId`, with `token` or the placeholder when the page no longer holds it. */
  function snippet(clientId, url, token) {
    var secret = token || TOKEN_PLACEHOLDER;
    var id = clientById(clientId).id;
    if (id === "codex") {
      return (
        "[mcp_servers." + SERVER_NAME + "]\n" +
        'url = "' + url + '"\n' +
        'bearer_token_env_var = "' + TOKEN_ENV_VAR + '"\n\n' +
        "# In your shell profile:\n" +
        "export " + TOKEN_ENV_VAR + '="' + secret + '"'
      );
    }
    if (id === "json") {
      var config = { mcpServers: {} };
      config.mcpServers[SERVER_NAME] = {
        type: "http",
        url: url,
        headers: { Authorization: "Bearer " + secret },
      };
      return JSON.stringify(config, null, 2);
    }
    return (
      "claude mcp add --transport http --scope user " + SERVER_NAME + " " + url +
      ' --header "Authorization: Bearer ' + secret + '"'
    );
  }

  function formatDate(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toISOString().slice(0, 10);
  }

  /** One sentence for the status line under the switch. */
  function statusText(state) {
    if (!state || !state.enabled) {
      return "Off. Assistants cannot reach your bookmarks.";
    }
    var token = state.tokenHint ? "token ending " + state.tokenHint : "a token";
    var created = state.tokenCreatedAt ? formatDate(state.tokenCreatedAt) : "";
    return "On at " + state.url + ", " + token + (created ? " (created " + created + ")" : "") + ".";
  }

  /** What to say beside the snippet when the page does not hold the token. */
  var LOST_TOKEN_TEXT =
    "The token is only shown once, when it is generated. Paste yours in place of " + TOKEN_PLACEHOLDER +
    ", or regenerate one - the old token then stops working.";

  var api = {
    SERVER_NAME: SERVER_NAME,
    TOKEN_ENV_VAR: TOKEN_ENV_VAR,
    TOKEN_PLACEHOLDER: TOKEN_PLACEHOLDER,
    CLIENTS: CLIENTS,
    LOST_TOKEN_TEXT: LOST_TOKEN_TEXT,
    clientById: clientById,
    snippet: snippet,
    statusText: statusText,
  };

  root.XBOMcpSettings = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
