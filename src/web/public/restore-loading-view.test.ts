import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";

/**
 * Drives the REAL index.html + #xbo-preboot + app.js in jsdom through a
 * reload. The owner's report: a refresh showed the "Nothing selected yet"
 * landing, with the filter tabs, for a moment before the view they had open
 * came back. While a saved view is being restored the pane must show a
 * loading state instead, and the landing must appear only when there is
 * genuinely nothing to restore (a first visit, or a saved category that no
 * longer exists).
 *
 * `/api/tree` is held open, so the test can look at the page mid-restore -
 * the moment the flash used to be on screen. Offline end to end: `fetch` is
 * a fixture.
 */

const dir = __dirname;
const read = (f: string) => readFileSync(join(dir, f), "utf8");
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

const bm = (id: number) => ({
  id,
  postId: `p${id}`,
  text: `post ${id}`,
  read: false,
  readAt: null,
  favorite: false,
  categoryIds: [1],
  url: `https://x.com/i/status/${id}`,
  authorName: "a",
  authorUsername: "a",
  createdAt: "2024-01-01T00:00:00Z",
  hasSummary: false,
  score: null,
  xArticle: null,
});

function prebootSource(html: string): string {
  const match = html.match(/<script id="xbo-preboot">([\s\S]*?)<\/script>/);
  if (!match) throw new Error("index.html no longer carries the #xbo-preboot inline script");
  return match[1];
}

async function boot(stored: Record<string, string>) {
  const html = read("index.html");
  // The stylesheet is inlined so `getComputedStyle` answers what the owner
  // would actually see; the inline preboot is run by hand below, after
  // storage is seeded, exactly as the parser would run it on a reload.
  const page = html
    .replace(/<script[^>]*><\/script>/g, "")
    .replace(/<script id="xbo-preboot">[\s\S]*?<\/script>/, "")
    .replace('<link rel="stylesheet" href="styles.css" />', `<style>${read("styles.css")}</style>`);
  const dom = new JSDOM(page, { runScripts: "outside-only", url: "http://localhost/", pretendToBeVisual: true });
  const w = dom.window as any;
  for (const [k, v] of Object.entries(stored)) w.localStorage.setItem(k, v);
  w.eval(prebootSource(html));

  w.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
  w.IntersectionObserver = class {
    observe() {}
    disconnect() {}
    unobserve() {}
  };
  w.EventSource = class {
    addEventListener() {}
    close() {}
  };
  let releaseTree!: () => void;
  const treeHeld = new Promise<void>((r) => (releaseTree = r));
  w.fetch = async (url: string) => {
    const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
    if (url.startsWith("/api/tree")) {
      await treeHeld;
      return json({
        tree: [{ id: 1, parentId: null, name: "Cat", path: ["Cat"], total: 2, unread: 2, directTotal: 2, children: [] }],
      });
    }
    if (url.startsWith("/api/setup")) {
      return json({
        bookmarkCount: 2,
        configured: true,
        settings: { categorizer: "claude-cli", provider: "claude-cli" },
        catalog: { methods: [], providers: [] },
        credentials: { xClientId: { present: true }, xClientSecret: { present: true }, typesafeApiKey: { present: false } },
        x: { connected: true, canConnect: true, login: { state: "idle", error: null } },
        sync: { available: true, lastSyncedAt: null, status: null },
      });
    }
    if (url === "/api/assistant-lists") {
      return json({
        lists: [{ position: 0, id: 5, title: "Saved list", note: null, createdAt: new Date().toISOString(), count: 2, unread: 2, viewed: true }],
      });
    }
    if (/^\/api\/assistant-lists\/5\b/.test(url)) {
      return json({
        list: { position: 0, id: 5, title: "Saved list", note: null, createdAt: new Date().toISOString(), count: 2, unread: 2, viewed: true },
        bookmarks: [bm(1), bm(2)],
      });
    }
    if (/^\/api\/categories\/1\/bookmarks/.test(url)) {
      return json({ bookmarks: [bm(1), bm(2)], offset: 0, hasMore: false, counts: { total: 2, unread: 2, favorite: 0 } });
    }
    return json({});
  };
  for (const f of [
    "tree-counts.js",
    "sort-order.js",
    "read-toggle.js",
    "filter-cache.js",
    "theme.js",
    "embed-theme.js",
    "post-scale.js",
    "sidebar-state.js",
    "tree-color.js",
    "view-persist.js",
    "breadcrumb.js",
    "tree-move.js",
    "card-drag.js",
    "categorization.js",
    "assistant-lists.js",
    "sidebar-nav.js",
    "app.js",
  ]) {
    w.eval(read(f));
  }
  await tick();
  const doc = w.document as Document;
  const shown = (sel: string) => {
    const node = doc.querySelector(sel);
    if (!node) return false;
    for (let n: Element | null = node; n; n = n.parentElement) {
      const style = w.getComputedStyle(n);
      if (style.display === "none" || style.visibility === "hidden") return false;
    }
    return true;
  };
  return {
    doc,
    shown,
    restoring: () => doc.body.hasAttribute("data-restoring"),
    releaseTree: async () => {
      releaseTree();
      await tick(120);
    },
  };
}

describe("reloading onto a saved view (refresh flash)", () => {
  it("shows a loading state, never the empty landing or its tabs, while a saved category is restored", async () => {
    const app = await boot({ "xbo:selection": JSON.stringify({ categoryId: 1, filter: "all" }) });
    // Mid-restore: the tree is still on its way.
    expect(app.restoring()).toBe(true);
    expect(app.shown("#bookmark-list .state-restoring")).toBe(true);
    expect(app.shown("#bookmark-list .state-welcome")).toBe(false);
    expect(app.shown("#toolbar")).toBe(false);
    expect(app.shown(".topbar-prompt")).toBe(false);

    await app.releaseTree();
    expect(app.restoring()).toBe(false);
    expect(app.doc.querySelector(".state-welcome")).toBeNull();
    expect(app.doc.getElementById("content-title")!.textContent).toContain("Cat");
    expect(app.shown("#toolbar")).toBe(true);
    expect(app.doc.querySelectorAll(".bookmark-card:not([hidden])").length).toBe(2);
  });

  it("shows the same loading state while a saved assistant list is restored", async () => {
    const app = await boot({ "xbo:assistant-list": "5" });
    expect(app.restoring()).toBe(true);
    expect(app.shown("#bookmark-list .state-restoring")).toBe(true);
    expect(app.shown("#bookmark-list .state-welcome")).toBe(false);
    expect(app.shown("#toolbar")).toBe(false);

    await app.releaseTree();
    expect(app.restoring()).toBe(false);
    expect(app.doc.querySelector(".state-welcome")).toBeNull();
    expect(app.doc.getElementById("content-title")!.textContent).toContain("Saved list");
  });

  it("shows the empty landing, and no tabs, from the start on a first visit", async () => {
    const app = await boot({});
    expect(app.restoring()).toBe(false);
    expect(app.shown("#bookmark-list .state-welcome")).toBe(true);
    expect(app.shown("#bookmark-list .state-restoring")).toBe(false);
    expect(app.shown(".topbar-prompt")).toBe(true);
    // The tabs are views OF a category: never painted, not even before the
    // first /api/setup answer.
    expect(app.shown("#toolbar")).toBe(false);

    await app.releaseTree();
    expect(app.shown("#bookmark-list .state-welcome")).toBe(true);
    expect(app.shown("#toolbar")).toBe(false);
  });

  it("falls back to the empty landing when the saved category no longer exists", async () => {
    const app = await boot({ "xbo:selection": JSON.stringify({ categoryId: 99, filter: "unread" }) });
    expect(app.restoring()).toBe(true);
    expect(app.shown("#bookmark-list .state-welcome")).toBe(false);

    await app.releaseTree();
    expect(app.restoring()).toBe(false);
    expect(app.shown("#bookmark-list .state-welcome")).toBe(true);
    expect(app.shown("#bookmark-list .state-restoring")).toBe(false);
    expect(app.shown(".topbar-prompt")).toBe(true);
    expect(app.shown("#toolbar")).toBe(false);
  });
});
