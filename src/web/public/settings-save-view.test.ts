import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { buildSettingsCatalog } from "../../settings/catalog";

/**
 * Drives the REAL app.js + index.html in jsdom to pin issue #122's Settings
 * panel Save behaviour, which the pure `categorization.js` unit tests
 * (`isUnchanged`, and its composition into `passProblems`/`hasSaveBlocker`)
 * cannot reach on their own since they never touch the DOM:
 *
 *   1. Save is DISABLED whenever the current selection equals the saved
 *      configuration - composing with #120/#121's existing disable reasons,
 *      not replacing them - and re-enables the instant any field changes,
 *      then disables again on a revert to the saved values.
 *   2. A successful save CLOSES the Settings popover and confirms through the
 *      app's existing toast system, updating the baseline so Save reads
 *      disabled ("no changes") the moment the panel reopens. A FAILED save
 *      keeps the panel open with the error inline and never touches the
 *      owner's selection.
 *
 * Offline end to end: `fetch` is a fixture, so nothing here reaches a real
 * server or spends anything.
 */

const dir = __dirname;
const read = (f: string) => readFileSync(join(dir, f), "utf8");

interface Sent {
  method: string;
  url: string;
  body: any;
}

async function boot(opts: { failSave?: string } = {}) {
  const sent: Sent[] = [];
  let settings: Record<string, unknown> = {
    categorizer: "claude-cli",
    taxonomyProvider: "claude-cli",
    assignmentProvider: "claude-cli",
  };
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
      if (opts.failSave) return json({ error: opts.failSave }, 400);
      settings = JSON.parse(init!.body!);
      return json({ settings });
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
          providerKeys: { ANTHROPIC_API_KEY: { present: true, source: "env" } },
          providerAvailability: { "claude-cli": { available: true } },
        },
        x: { connected: true, canConnect: true, login: { state: "idle", error: null } },
        sync: { available: true, lastSyncedAt: null, status: null },
        ranking: { scored: 0, total: 3, available: false, blocker: null, pending: 0, status: null },
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

  function change(id: string, value: string) {
    const select = $<HTMLSelectElement>(id);
    select.value = value;
    select.dispatchEvent(new w.Event("change", { bubbles: true }));
  }
  function openSettings() {
    $("settings-toggle").click();
  }
  function toastMessages() {
    return [...doc.querySelectorAll("#toast-container .toast-msg")].map((n) => n.textContent);
  }

  return { w, doc, $, sent, change, openSettings, toastMessages };
}

const tick = () => new Promise((r) => setTimeout(r, 120));

describe("Settings panel Save (issue #122)", () => {
  it("disables Save with a visible 'No changes to save' reason when the selection matches the saved config", async () => {
    const { $, openSettings } = await boot();
    openSettings();
    const saveBtn = $<HTMLButtonElement>("settings-save");
    expect(saveBtn.disabled).toBe(true);
    expect($("settings-categorization-note").hidden).toBe(false);
    expect($("settings-categorization-note").textContent).toContain("No changes to save.");
    expect(saveBtn.getAttribute("aria-describedby")).toBe("settings-categorization-note");
  });

  it("enables Save the instant a field changes, and disables it again on a revert", async () => {
    const { $, change, openSettings } = await boot();
    openSettings();
    const saveBtn = $<HTMLButtonElement>("settings-save");
    expect(saveBtn.disabled).toBe(true);

    change("settings-effort", "high");
    await tick();
    expect(saveBtn.disabled).toBe(false);
    expect($("settings-categorization-note").textContent).not.toContain("No changes to save.");

    change("settings-effort", "");
    await tick();
    expect(saveBtn.disabled).toBe(true);
    expect($("settings-categorization-note").textContent).toContain("No changes to save.");
  });

  it("closes the panel and shows a saved toast on success, leaving Save disabled again on reopen", async () => {
    const { $, change, openSettings, sent, toastMessages } = await boot();
    openSettings();
    expect($("settings-panel").hidden).toBe(false);

    change("settings-effort", "high");
    await tick();
    const saveBtn = $<HTMLButtonElement>("settings-save");
    expect(saveBtn.disabled).toBe(false);

    saveBtn.click();
    await tick();

    expect(sent.some((s) => s.method === "PUT" && s.url === "/api/settings")).toBe(true);
    expect($("settings-panel").hidden).toBe(true);
    expect(toastMessages()).toContain("Settings saved.");
    // The toast is the one confirmation now - no leftover inline status.
    expect($("settings-save-status").textContent).toBe("");

    openSettings();
    expect($<HTMLButtonElement>("settings-save").disabled).toBe(true);
    expect($("settings-categorization-note").textContent).toContain("No changes to save.");
  });

  it("keeps the panel open with the error inline on a failed save, and never touches the selection", async () => {
    const { $, change, openSettings, sent, toastMessages } = await boot({
      failSave: "Could not save these settings.",
    });
    openSettings();
    change("settings-effort", "high");
    await tick();
    const saveBtn = $<HTMLButtonElement>("settings-save");
    saveBtn.click();
    await tick();

    expect(sent.some((s) => s.method === "PUT" && s.url === "/api/settings")).toBe(true);
    expect($("settings-panel").hidden).toBe(false);
    expect($("settings-save-status").textContent).toBe("Could not save these settings.");
    expect($("settings-save-status").getAttribute("data-state")).toBe("error");
    expect(toastMessages()).not.toContain("Settings saved.");
    expect($<HTMLSelectElement>("settings-effort").value).toBe("high");
    // Still differs from the (unsaved) baseline, so Save stays enabled for a retry.
    expect(saveBtn.disabled).toBe(false);
  });
});
