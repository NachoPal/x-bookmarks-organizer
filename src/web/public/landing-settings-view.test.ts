import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { buildSettingsCatalog } from "../../settings/catalog";

/**
 * Drives the REAL app.js + index.html in jsdom through the owner's report: on
 * the never-synced landing they chose the Claude subscription for phase 1 and
 * Jev for phase 2, and every sync failed on a pi-ai model needing
 * ANTHROPIC_API_KEY.
 *
 * Reproduced: the combined "Filing method" selector kept a pi-ai filing
 * provider picked earlier as a hidden language model behind Jev, and the
 * landing's Sync saved it. Jev calls no language model now, so these pin that
 * no language-model field shows or is saved while Jev files, that a save
 * sends only what is on screen, and that the landing and the Settings panel
 * always show the same stored document after either one saves.
 *
 * Offline end to end: `fetch` is a fixture.
 */

const dir = __dirname;
const read = (f: string) => readFileSync(join(dir, f), "utf8");
const tick = () => new Promise((r) => setTimeout(r, 120));

interface Sent {
  method: string;
  url: string;
  body: any;
}

async function boot(initial: Record<string, unknown>) {
  const sent: Sent[] = [];
  let settings: Record<string, unknown> = { ...initial };
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
    sent.push({ method, url, body: init && init.body ? JSON.parse(init.body) : null });
    if (method === "PUT" && url === "/api/settings") {
      settings = { ...JSON.parse(init!.body!), configuredAt: "2026-09-24T00:00:00.000Z" };
      return json({ settings });
    }
    if (method === "POST" && url === "/api/sync") return json({ status: { state: "running", messages: [] } }, 202);
    if (url.startsWith("/api/tree")) return json({ tree: [] });
    if (url.startsWith("/api/setup")) {
      return json({
        bookmarkCount: 0,
        configured: !!settings.configuredAt,
        settings,
        catalog: buildSettingsCatalog(),
        credentials: {
          xClientId: { present: true },
          xClientSecret: { present: true },
          typesafeApiKey: { present: true, source: "env" },
          // The owner's `av inject`: no ANTHROPIC_API_KEY.
          providerKeys: { ANTHROPIC_API_KEY: { present: false }, OPENROUTER_API_KEY: { present: true, source: "env" } },
          providerAvailability: { "claude-cli": { available: true } },
        },
        x: { connected: true, canConnect: true, login: { state: "idle", error: null } },
        sync: { available: true, lastSyncedAt: null, status: null, paidPasses: [] },
        ranking: { scored: 0, total: 0, available: false, blocker: null, pending: 0, status: null },
      });
    }
    return json({});
  };

  for (const f of ["tree-counts.js", "filter-cache.js", "theme.js", "sort-order.js", "categorization.js", "ranking.js"]) {
    w.eval(read(f));
  }
  w.eval(read("app.js"));
  await tick();
  const doc = w.document as Document;
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => doc.getElementById(id) as T;
  const value = (id: string) => $<HTMLSelectElement>(id).value;
  async function change(id: string, next: string) {
    const select = $<HTMLSelectElement>(id);
    select.value = next;
    select.dispatchEvent(new w.Event("change", { bubbles: true }));
    await tick();
  }
  const puts = () => sent.filter((s) => s.method === "PUT" && s.url === "/api/settings").map((s) => s.body);
  const syncButton = () =>
    [...doc.querySelectorAll<HTMLButtonElement>(".first-run button")].find((b) => b.textContent === "Sync my bookmarks")!;
  /** Whether a form shows any field for a language model in phase 2. */
  const phase2Models = (prefix: string) =>
    [...doc.querySelectorAll<HTMLElement>(`[id^="${prefix}-"]`)].filter(
      (n) => /assignment|fallback/i.test(n.id) && n.closest(".field") && !(n.closest(".field") as HTMLElement).hidden,
    );
  return { $, value, change, puts, syncButton, phase2Models, doc, stored: () => settings };
}

describe("landing view + Settings: Jev needs no language model, and both forms agree", () => {
  it("shows the owner's saved document - an unseen pi-ai filer and an old fallback - as Jev alone", async () => {
    const { value, phase2Models, doc, $ } = await boot({
      categorizer: "typesafe",
      taxonomyProvider: "claude-cli",
      assignmentProvider: "pi-ai",
      fallbackProvider: "pi-ai",
      configuredAt: "2026-09-21T10:28:55.227Z",
    });
    for (const prefix of ["firstrun", "settings"]) {
      expect(value(`${prefix}-categorizer`)).toBe("typesafe");
      expect(phase2Models(prefix)).toEqual([]);
    }
    expect(doc.body.textContent).not.toMatch(/fallback language model/i);
    // Nothing blocks this selection.
    expect($("settings-categorization-note").hidden).toBe(true);
  });

  it("saves exactly what the landing shows when switching pi-ai -> Jev, and the sync starts on it", async () => {
    const { change, puts, syncButton, value, phase2Models } = await boot({
      categorizer: "claude-cli",
      taxonomyProvider: "claude-cli",
      assignmentProvider: "claude-cli",
    });
    expect(phase2Models("firstrun").length).toBeGreaterThan(0);
    // The owner's path: try pi-ai for filing, then settle on Jev.
    await change("firstrun-categorizer", "pi-ai");
    await change("firstrun-categorizer", "typesafe");
    expect(phase2Models("firstrun")).toEqual([]);

    syncButton().click();
    await tick();
    expect(puts()).toEqual([{ categorizer: "typesafe", taxonomyProvider: "claude-cli" }]);
    // The Settings panel shows the same stored choice.
    expect(value("settings-categorizer")).toBe("typesafe");
  });

  it("brings the landing to what Settings saved, even over an unsaved landing edit", async () => {
    const { change, value, $ } = await boot({ categorizer: "typesafe", taxonomyProvider: "claude-cli" });
    await change("firstrun-effort", "high");
    $("settings-toggle").click();
    await change("settings-effort", "low");
    $<HTMLButtonElement>("settings-save").click();
    await tick();
    expect(value("settings-effort")).toBe("low");
    expect(value("firstrun-effort")).toBe("low");
  });

  it("drops an unsaved Settings edit on close, so it reopens on the stored document", async () => {
    const { change, value, syncButton, $ } = await boot({ categorizer: "typesafe", taxonomyProvider: "claude-cli" });
    $("settings-toggle").click();
    await change("settings-effort", "max");
    $("settings-toggle").click();
    await tick();
    // The landing saves meanwhile; Settings must show THAT, not its abandoned edit.
    await change("firstrun-effort", "xhigh");
    syncButton().click();
    await tick();
    $("settings-toggle").click();
    expect(value("settings-effort")).toBe("xhigh");
    expect($<HTMLButtonElement>("settings-save").disabled).toBe(true);
  });
});
