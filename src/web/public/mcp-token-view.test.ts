import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { buildSettingsCatalog } from "../../settings/catalog";

/**
 * Drives the REAL app.js + index.html in jsdom to pin issue #141: the MCP
 * token is shown exactly once, in the response flow that generated it, and
 * never again - not after "Done", not after closing and reopening Settings,
 * not after a reload - while the Connect-from snippets stay copyable at any
 * time with a `<YOUR_TOKEN>` placeholder instead of the real value.
 *
 * `fetch` is a fixture standing in for `src/mcp/http.ts`'s routes and holds
 * the server's state across "reloads" (a new JSDOM over the same fixture), so
 * a reload sees exactly what a real one would: whatever `GET /api/mcp` says.
 */

const dir = __dirname;
const read = (f: string) => readFileSync(join(dir, f), "utf8");
const URL = "http://127.0.0.1:5199/mcp";

function fakeServer(initial: { enabled: boolean; hasToken: boolean; tokenHint: string | null; tokenCreatedAt: string | null }) {
  let access = { ...initial };
  let counter = 0;
  const issued: string[] = [];
  const generate = () => {
    counter += 1;
    const token = `xbo_mcp_SECRETtoken${counter}${"x".repeat(20)}tail${counter}`;
    issued.push(token);
    access = {
      ...access,
      hasToken: true,
      tokenHint: `xbo_mcp_SECR…ail${counter}`,
      tokenCreatedAt: "2026-09-25T10:00:00.000Z",
    };
    return token;
  };
  async function handle(url: string, method: string, body: any) {
    if (url === "/api/mcp" && method === "GET") return { ...access, url: URL };
    if (url === "/api/mcp" && method === "PUT") {
      const hadToken = access.hasToken;
      access = { ...access, enabled: body.enabled };
      const token = body.enabled && !hadToken ? generate() : undefined;
      return { ...access, url: URL, ...(token ? { token } : {}) };
    }
    if (url === "/api/mcp/token" && method === "POST") {
      const token = generate();
      return { ...access, url: URL, token };
    }
    return null;
  }
  return { handle, issued };
}

type Server = ReturnType<typeof fakeServer>;

async function boot(server: Server) {
  const dom = new JSDOM(read("index.html").replace(/<script[^>]*><\/script>/g, ""), {
    runScripts: "outside-only",
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  const w = dom.window as any;
  w.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
  w.IntersectionObserver = class {
    observe() {}
    disconnect() {}
    unobserve() {}
  };
  w.HTMLElement.prototype.scrollIntoView = function () {};
  const copied: string[] = [];
  Object.defineProperty(w.navigator, "clipboard", {
    value: { writeText: async (text: string) => void copied.push(text) },
  });
  w.fetch = async (url: string, init?: { method?: string; body?: string }) => {
    const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
    const method = (init && init.method) || "GET";
    const mcp = await server.handle(url, method, init && init.body ? JSON.parse(init.body) : null);
    if (mcp) return json(mcp);
    if (url.startsWith("/api/tree")) return json({ tree: [] });
    if (url.startsWith("/api/setup")) {
      return json({
        bookmarkCount: 3,
        configured: true,
        settings: { categorizer: "claude-cli", taxonomyProvider: "claude-cli", assignmentProvider: "claude-cli" },
        catalog: buildSettingsCatalog(),
        credentials: {
          xClientId: { present: true },
          xClientSecret: { present: true },
          typesafeApiKey: { present: false },
          providerKeys: {},
          providerAvailability: { "claude-cli": { available: true } },
        },
        x: { connected: true, canConnect: true, login: { state: "idle", error: null } },
        sync: { available: true, lastSyncedAt: null, status: null },
        ranking: { scored: 0, total: 3, available: false, blocker: null, pending: 0, status: null },
      });
    }
    return json({});
  };

  for (const f of ["tree-counts.js", "filter-cache.js", "theme.js", "sort-order.js", "categorization.js", "ranking.js", "mcp-settings.js"]) {
    w.eval(read(f));
  }
  w.eval(read("app.js"));
  await tick();
  const doc = w.document as Document;
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => doc.getElementById(id) as T;

  /** Every place the page could still be holding a token: the DOM, and both storages. */
  function pageHolds(token: string) {
    const storage = (s: Storage) => Array.from({ length: s.length }, (_, i) => `${s.key(i)}=${s.getItem(s.key(i)!)}`).join("\n");
    return (
      doc.documentElement.outerHTML.includes(token) ||
      doc.body.textContent!.includes(token) ||
      storage(w.localStorage).includes(token) ||
      storage(w.sessionStorage).includes(token)
    );
  }
  const openSettings = () => $("settings-toggle").click();
  const settingsOpen = () => !$("settings-panel").hidden;
  return { w, doc, $, copied, pageHolds, openSettings, settingsOpen };
}

const tick = () => new Promise((r) => setTimeout(r, 120));

describe("MCP token shown once (issue #141)", () => {
  it("reveals a regenerated token once, keeps snippets on the placeholder, and forgets it on close and reload", async () => {
    const server = fakeServer({ enabled: true, hasToken: true, tokenHint: "xbo_mcp_OLD1…old9", tokenCreatedAt: "2026-09-01T00:00:00.000Z" });
    const first = await boot(server);
    first.openSettings();

    // Before any generation: the hint identifies the live token, no reveal.
    expect(first.$("mcp-token").hidden).toBe(true);
    expect(first.$("mcp-token-hint").textContent).toBe("Active token xbo_mcp_OLD1…old9, created 2026-09-01.");
    expect(first.$("mcp-token-hint").querySelector("code.mcp-hint")!.textContent).toBe("xbo_mcp_OLD1…old9");
    expect(first.$("mcp-snippet").textContent).toContain("Bearer <YOUR_TOKEN>");
    expect(first.$("mcp-placeholder-note").hidden).toBe(false);
    expect(first.$("mcp-placeholder-note").textContent).toContain("<YOUR_TOKEN>");

    first.$("mcp-regenerate").click();
    await tick();
    const token = server.issued[0];
    expect(first.$("mcp-token").hidden).toBe(false);
    expect(first.$("mcp-token-value").textContent).toBe(token);
    expect(first.doc.activeElement).toBe(first.$("mcp-token-copy"));
    first.$("mcp-token-copy").click();
    await tick();
    expect(first.copied).toEqual([token]);

    // Every snippet, for every client, still carries the placeholder only - and stays copyable.
    const select = first.$<HTMLSelectElement>("mcp-client");
    for (const option of Array.from(select.options)) {
      select.value = option.value;
      select.dispatchEvent(new first.w.Event("change", { bubbles: true }));
      expect(first.$("mcp-snippet").textContent).toContain("<YOUR_TOKEN>");
      expect(first.$("mcp-snippet").textContent).not.toContain(token);
    }
    first.$("mcp-snippet-copy").click();
    await tick();
    expect(first.copied[1]).toContain("<YOUR_TOKEN>");
    expect(first.copied[1]).not.toContain(token);
    expect(first.$("mcp-token-hint").textContent).toBe("Active token xbo_mcp_SECR…ail1, created 2026-09-25.");

    // Closing Settings forgets it; reopening does not bring it back.
    first.openSettings();
    expect(first.settingsOpen()).toBe(false);
    expect(first.pageHolds(token)).toBe(false);
    first.openSettings();
    expect(first.settingsOpen()).toBe(true);
    expect(first.$("mcp-token").hidden).toBe(true);
    expect(first.pageHolds(token)).toBe(false);

    // A reload sees only what GET /api/mcp says: the hint, never the token.
    const reloaded = await boot(server);
    reloaded.openSettings();
    expect(reloaded.$("mcp-token").hidden).toBe(true);
    expect(reloaded.pageHolds(token)).toBe(false);
    expect(reloaded.$("mcp-token-hint").textContent).toBe("Active token xbo_mcp_SECR…ail1, created 2026-09-25.");
    expect(reloaded.$("mcp-snippet").textContent).toContain("<YOUR_TOKEN>");
  });

  it("reveals the token from the first switch-on, and 'Done' dismisses it for good", async () => {
    const server = fakeServer({ enabled: false, hasToken: false, tokenHint: null, tokenCreatedAt: null });
    const page = await boot(server);
    page.openSettings();
    expect(page.$("mcp-details").hidden).toBe(true);

    page.$("mcp-toggle").click();
    await tick();
    const token = server.issued[0];
    expect(page.$("mcp-details").hidden).toBe(false);
    expect(page.$("mcp-token-value").textContent).toBe(token);
    expect(page.$("mcp-snippet").textContent).not.toContain(token);

    page.$("mcp-token-done").click();
    expect(page.$("mcp-token").hidden).toBe(true);
    expect(page.pageHolds(token)).toBe(false);
    expect(page.doc.activeElement).toBe(page.$("mcp-snippet-copy"));
    // Still in the panel, still set up, still identified by the hint.
    expect(page.settingsOpen()).toBe(true);
    expect(page.$("mcp-token-hint").textContent).toContain("xbo_mcp_SECR…ail1");

    // Switching off and on again (the token survives server-side) never re-reveals it.
    page.$("mcp-toggle").click();
    await tick();
    page.$("mcp-toggle").click();
    await tick();
    expect(page.$("mcp-token").hidden).toBe(true);
    expect(page.pageHolds(token)).toBe(false);
  });

  it("shows only the creation date for a token stored without a hint", async () => {
    const server = fakeServer({ enabled: true, hasToken: true, tokenHint: null, tokenCreatedAt: "2026-09-01T00:00:00.000Z" });
    const page = await boot(server);
    page.openSettings();
    expect(page.$("mcp-token-hint").textContent).toBe("Active token created 2026-09-01.");
    expect(page.$("mcp-token-hint").querySelector("code")).toBeNull();
    expect(page.$("mcp-token").hidden).toBe(true);
  });
});
