import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { buildSettingsCatalog } from "../../settings/catalog";

/**
 * Drives the REAL app.js + index.html in jsdom to pin where security finding
 * #8's warning surfaces: the server logs it at startup, but an owner who never
 * reads that log must still see that `.env` is readable by other users - in
 * the Settings panel always, and on the never-synced landing too. Offline:
 * `fetch` is a fixture.
 */

const dir = __dirname;
const read = (f: string) => readFileSync(join(dir, f), "utf8");
const tick = () => new Promise((r) => setTimeout(r, 120));

const EXPOSURE = { file: "/home/owner/x-bookmarks-organizer/.env", mode: "644" };

async function boot(opts: { dotenvExposure: typeof EXPOSURE | null; bookmarkCount: number }) {
  const setup = () => ({
    bookmarkCount: opts.bookmarkCount,
    configured: opts.bookmarkCount > 0,
    settings: { categorizer: "claude-cli", taxonomyProvider: "claude-cli", assignmentProvider: "claude-cli" },
    catalog: buildSettingsCatalog(),
    credentials: {
      xClientId: { present: true, source: "dotenv" },
      xClientSecret: { present: true, source: "dotenv" },
      typesafeApiKey: { present: false },
      providerKeys: {},
      providerAvailability: { "claude-cli": { available: true } },
      dotenvExposure: opts.dotenvExposure,
    },
    x: { connected: true, canConnect: true, login: { state: "idle", error: null } },
    sync: { available: true, lastSyncedAt: null, status: null },
    ranking: { scored: 0, total: opts.bookmarkCount, available: false, blocker: null, pending: 0, status: null },
  });
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
  w.fetch = async (url: string) => {
    const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    if (url.startsWith("/api/tree")) return json({ tree: [] });
    if (url.startsWith("/api/setup")) return json(setup());
    return json({});
  };
  for (const f of [
    "tree-counts.js",
    "filter-cache.js",
    "theme.js",
    "sort-order.js",
    "categorization.js",
    "ranking.js",
    "missing-credentials.js",
  ]) {
    w.eval(read(f));
  }
  w.eval(read("app.js"));
  await tick();
  return w.document as Document;
}

describe(".env permission warning in the viewer (security finding #8)", () => {
  it("shows the server's report in the Settings panel as a labelled status, with the fix", async () => {
    const doc = await boot({ dotenvExposure: EXPOSURE, bookmarkCount: 3 });
    const host = doc.getElementById("settings-dotenv-warning")!;
    expect(host.hidden).toBe(false);
    expect(host.getAttribute("role")).toBe("status");
    const title = doc.getElementById(host.getAttribute("aria-labelledby")!)!;
    expect(title.textContent).toBe("Your .env file is readable by other users");
    expect(host.textContent).toContain("Security");
    expect(host.textContent).toContain("mode is 644");
    expect(host.querySelector("code.dotenv-warning-fix")!.textContent).toBe(
      "chmod 600 /home/owner/x-bookmarks-organizer/.env",
    );
  });

  it("also shows it on the never-synced landing", async () => {
    const doc = await boot({ dotenvExposure: EXPOSURE, bookmarkCount: 0 });
    const landing = doc.querySelector(".first-run .dotenv-warning") as HTMLElement;
    expect(landing).not.toBeNull();
    expect(landing.hidden).toBe(false);
    expect(landing.textContent).toContain("chmod 600");
  });

  it("renders nothing when the server reports no warning", async () => {
    const doc = await boot({ dotenvExposure: null, bookmarkCount: 0 });
    const host = doc.getElementById("settings-dotenv-warning")!;
    expect(host.hidden).toBe(true);
    expect(host.childElementCount).toBe(0);
    const landing = doc.querySelector(".first-run .dotenv-warning") as HTMLElement;
    expect(landing.hidden).toBe(true);
  });
});
