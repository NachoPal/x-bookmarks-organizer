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
 * bound), never from `location`, and NEVER carries the token (issue #141): it
 * always holds {@link TOKEN_PLACEHOLDER}, so the setup stays copyable at any
 * time while Settings, a screenshot or a screen share never shows a working
 * credential. The token itself is shown once, in its own card, and only by
 * the response that generated it.
 *
 * Browser global (no modules in this viewer) + CommonJS export for the test.
 */
(function (root) {
  /** The name the snippets register the server under. */
  var SERVER_NAME = "xbookmarks";
  /** Codex reads the token from this environment variable rather than from its config file. */
  var TOKEN_ENV_VAR = "XBOOKMARKS_MCP_TOKEN";
  var TOKEN_PLACEHOLDER = "<YOUR_TOKEN>";

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
        "Add the block to ~/.codex/config.toml (every project) or a project's .codex/config.toml, and set " +
        TOKEN_ENV_VAR + " to your token in your shell profile, so the token stays out of the config file.",
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

  /** The config text for `clientId`. Takes no token on purpose: every snippet carries the placeholder. */
  function snippet(clientId, url) {
    var secret = TOKEN_PLACEHOLDER;
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
    return "On at " + state.url + ".";
  }

  /**
   * Which token is live, without revealing it, as `{ lead, hint, trail }` so
   * the page can set the masked hint in code type: `Active token ` +
   * `xbo_mcp_ab12…9f3c` + `, created 2026-09-25.` A token stored before hints
   * existed has only its date (`hint` null); no token at all, null.
   */
  function tokenLineParts(state) {
    if (!state || !state.hasToken) return null;
    var created = state.tokenCreatedAt ? formatDate(state.tokenCreatedAt) : "";
    if (state.tokenHint) {
      return { lead: "Active token ", hint: state.tokenHint, trail: (created ? ", created " + created : "") + "." };
    }
    return { lead: created ? "Active token created " + created + "." : "A token is active.", hint: null, trail: "" };
  }

  /** {@link tokenLineParts} as one sentence. */
  function tokenLine(state) {
    var parts = tokenLineParts(state);
    return parts ? parts.lead + (parts.hint || "") + parts.trail : "";
  }

  /** What to say beside the snippet: where the real token goes, and what to do without it. */
  var PLACEHOLDER_TEXT =
    "Replace " + TOKEN_PLACEHOLDER + " with the token you copied when it was generated. It is never shown " +
    "again - if you lost it, regenerate one.";

  var api = {
    SERVER_NAME: SERVER_NAME,
    TOKEN_ENV_VAR: TOKEN_ENV_VAR,
    TOKEN_PLACEHOLDER: TOKEN_PLACEHOLDER,
    CLIENTS: CLIENTS,
    PLACEHOLDER_TEXT: PLACEHOLDER_TEXT,
    clientById: clientById,
    snippet: snippet,
    statusText: statusText,
    tokenLine: tokenLine,
    tokenLineParts: tokenLineParts,
  };

  root.XBOMcpSettings = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
