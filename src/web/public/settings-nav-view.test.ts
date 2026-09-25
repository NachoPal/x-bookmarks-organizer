import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { buildSettingsCatalog } from "../../settings/catalog";

/**
 * Drives the REAL app.js + index.html in jsdom to pin issue #142's Settings
 * drill-down: the panel opens at a root menu with one row per section, a row
 * slides into that section's sub-page (focus on its heading), and Back or
 * Escape returns ONE level (focus on the row it came from) - a second Escape
 * at the root closes the panel. Leaving a sub-page does what closing Settings
 * has always done (drop unsaved categorization edits and a revealed MCP
 * token), and Settings always reopens at the root.
 *
 * Offline end to end: `fetch` is a fixture, so nothing here reaches a real
 * server or spends anything.
 */

const dir = __dirname;
const read = (f: string) => readFileSync(join(dir, f), "utf8");
const MCP_URL = "http://127.0.0.1:5199/mcp";
const SECTIONS = ["post-size", "categorization", "mcp"] as const;

async function boot(opts: { mcpEnabled?: boolean } = {}) {
  const settings = { categorizer: "claude-cli", taxonomyProvider: "claude-cli", assignmentProvider: "claude-cli" };
  let mcp = { enabled: !!opts.mcpEnabled, hasToken: !!opts.mcpEnabled, tokenHint: null, tokenCreatedAt: null };
  let issued = 0;
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
  w.fetch = async (url: string, init?: { method?: string; body?: string }) => {
    const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
    const method = (init && init.method) || "GET";
    if (url === "/api/mcp" && method === "GET") return json({ ...mcp, url: MCP_URL });
    if (url === "/api/mcp" && method === "PUT") {
      mcp = { ...mcp, enabled: JSON.parse(init!.body!).enabled };
      return json({ ...mcp, url: MCP_URL });
    }
    if (url === "/api/mcp/token" && method === "POST") {
      issued += 1;
      mcp = { ...mcp, hasToken: true };
      return json({ ...mcp, url: MCP_URL, token: `xbo_mcp_NAVtoken${issued}${"z".repeat(24)}` });
    }
    if (url.startsWith("/api/tree")) return json({ tree: [] });
    if (url.startsWith("/api/setup")) {
      return json({
        bookmarkCount: 3,
        configured: true,
        settings,
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

  for (const f of [
    "tree-counts.js",
    "filter-cache.js",
    "theme.js",
    "post-scale.js",
    "sort-order.js",
    "categorization.js",
    "ranking.js",
    "mcp-settings.js",
  ]) {
    w.eval(read(f));
  }
  w.eval(read("app.js"));
  await tick();
  const doc = w.document as Document;
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => doc.getElementById(id) as T;
  const row = (section: string) => doc.querySelector<HTMLButtonElement>(`[data-settings-section="${section}"]`)!;
  const page = (section: string) => $(`settings-section-${section}`);
  const backIn = (section: string) => page(section).querySelector<HTMLButtonElement>("[data-settings-back]")!;
  /** Escape from wherever focus is, bubbling to the document like a real key press. */
  function escape() {
    const target = doc.activeElement || doc.body;
    const ev = new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    target.dispatchEvent(ev);
    return ev;
  }
  function change(id: string, value: string) {
    const select = $<HTMLSelectElement>(id);
    select.value = value;
    select.dispatchEvent(new w.Event("change", { bubbles: true }));
  }
  const openSettings = () => $("settings-toggle").click();
  const panelOpen = () => !$("settings-panel").hidden;
  /** Only ONE view is ever shown, so Tab can never reach an off-screen page. */
  const visibleViews = () =>
    [$("settings-root"), ...SECTIONS.map(page)].filter((v) => !v.hidden).map((v) => v.id);
  return { w, doc, $, row, page, backIn, escape, change, openSettings, panelOpen, visibleViews };
}

const tick = () => new Promise((r) => setTimeout(r, 120));

describe("Settings drill-down (issue #142)", () => {
  it("opens at the root: one row per section, each a button ending in a chevron", async () => {
    const { doc, $, row, openSettings, visibleViews } = await boot();
    openSettings();
    expect(visibleViews()).toEqual(["settings-root"]);
    expect($("settings-panel-title").textContent).toBe("Settings");

    const rows = [...doc.querySelectorAll<HTMLButtonElement>("#settings-root .settings-row")];
    expect(rows.map((r) => r.querySelector(".settings-row-label")!.textContent)).toEqual([
      "Post size",
      "Categorization",
      "AI assistants (MCP)",
    ]);
    for (const r of rows) {
      expect(r.tagName).toBe("BUTTON");
      expect(r.type).toBe("button");
      expect(r.querySelector("svg.settings-row-chevron")!.getAttribute("aria-hidden")).toBe("true");
    }
    expect(doc.activeElement).toBe(row("post-size"));
  });

  it("each row opens its own sub-page with a Back control and a title, and focus lands on the title", async () => {
    const { doc, $, row, page, backIn, openSettings, visibleViews } = await boot();
    openSettings();
    const titles = { "post-size": "Post size", categorization: "Categorization", mcp: "AI assistants (MCP)" };
    for (const section of SECTIONS) {
      row(section).click();
      expect(visibleViews()).toEqual([`settings-section-${section}`]);
      const heading = page(section).querySelector<HTMLElement>(".settings-subpage-title")!;
      expect(heading.textContent).toBe(titles[section]);
      expect(page(section).getAttribute("aria-labelledby")).toBe(heading.id);
      expect(doc.activeElement).toBe(heading);
      expect(page(section).getAttribute("data-enter")).toBe("forward");
      expect(backIn(section).getAttribute("aria-label")).toBe("Back to Settings");

      backIn(section).click();
      expect(visibleViews()).toEqual(["settings-root"]);
      expect($("settings-root").getAttribute("data-enter")).toBe("back");
      expect(doc.activeElement).toBe(row(section));
    }
    // The section controls live on their pages, not at the root.
    expect(page("post-size").contains($("post-scale"))).toBe(true);
    expect(page("categorization").contains($("settings-save"))).toBe(true);
    expect(page("mcp").contains($("mcp-toggle"))).toBe(true);
  });

  it("Escape goes back one level; a second Escape at the root closes the panel", async () => {
    const { doc, $, row, escape, openSettings, panelOpen, visibleViews } = await boot();
    openSettings();
    row("categorization").click();

    const first = escape();
    expect(first.defaultPrevented).toBe(true);
    expect(panelOpen()).toBe(true);
    expect(visibleViews()).toEqual(["settings-root"]);
    expect(doc.activeElement).toBe(row("categorization"));

    escape();
    expect(panelOpen()).toBe(false);
    expect(doc.activeElement).toBe($("settings-toggle"));
  });

  it("closing Settings from a sub-page reopens at the root", async () => {
    const { doc, row, openSettings, panelOpen, visibleViews } = await boot();
    openSettings();
    row("mcp").click();
    openSettings(); // the gear toggles it shut
    expect(panelOpen()).toBe(false);
    openSettings();
    expect(visibleViews()).toEqual(["settings-root"]);
    expect(doc.activeElement).toBe(row("post-size"));
  });

  it("an Escape the model picker handles stays inside the Categorization page", async () => {
    const { $, row, escape, change, openSettings, visibleViews } = await boot();
    openSettings();
    row("categorization").click();
    change("settings-taxonomyProvider", "pi-ai");
    change("settings-taxonomySource", "opencode");
    await tick();
    const input = $<HTMLInputElement>("settings-taxonomyModelSearch");
    input.focus();
    input.value = "zzz";
    input.dispatchEvent(new (input.ownerDocument.defaultView as any).Event("input", { bubbles: true }));
    escape();
    expect(visibleViews()).toEqual(["settings-section-categorization"]);
  });

  it("leaving the Categorization page drops its unsaved edits, the same as closing Settings", async () => {
    const { $, row, backIn, change, openSettings } = await boot();
    openSettings();
    row("categorization").click();
    change("settings-effort", "high");
    expect($<HTMLButtonElement>("settings-save").disabled).toBe(false);

    backIn("categorization").click();
    row("categorization").click();
    expect($<HTMLSelectElement>("settings-effort").value).toBe("");
    expect($<HTMLButtonElement>("settings-save").disabled).toBe(true);
  });

  it("drops a revealed MCP token on Back and on closing Settings from its page (issue #141)", async () => {
    const { doc, $, row, backIn, openSettings } = await boot({ mcpEnabled: true });
    openSettings();
    row("mcp").click();
    $("mcp-regenerate").click();
    await tick();
    const token = $("mcp-token-value").textContent!;
    expect(token).toMatch(/^xbo_mcp_NAVtoken1/);
    expect($("mcp-token").hidden).toBe(false);

    backIn("mcp").click();
    expect(doc.body.innerHTML).not.toContain(token);
    row("mcp").click();
    expect($("mcp-token").hidden).toBe(true);

    $("mcp-regenerate").click();
    await tick();
    const second = $("mcp-token-value").textContent!;
    expect(second).toMatch(/^xbo_mcp_NAVtoken2/);
    openSettings(); // closes it, straight from the MCP page
    expect(doc.body.innerHTML).not.toContain(second);
    openSettings();
    row("mcp").click();
    expect($("mcp-token").hidden).toBe(true);
  });

  it("shows each root row's current value, kept in step with the section's control", async () => {
    const { w, $, row, openSettings } = await boot();
    openSettings();
    expect($("settings-row-value-post-size").textContent).toBe("Small");
    expect($("settings-row-value-mcp").textContent).toBe("Off");

    row("post-size").click();
    const large = $("post-scale").querySelector<HTMLInputElement>('input[value="large"]')!;
    large.checked = true;
    large.dispatchEvent(new w.Event("change", { bubbles: true }));
    expect($("settings-row-value-post-size").textContent).toBe("Large");
    expect(w.localStorage.getItem("xbo:post-scale")).toBe("large");

    row("mcp").click();
    $("mcp-toggle").click();
    await tick();
    expect($("settings-row-value-mcp").textContent).toBe("On");
    // The value is part of the row's name, so a screen reader hears it too.
    expect(row("mcp").textContent!.replace(/\s+/g, " ").trim()).toBe("AI assistants (MCP) On");
  });
});
