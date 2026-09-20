import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";

// Drives the REAL app.js + index.html in jsdom with a stubbed fetch, to pin
// the issue #33 behavior: a cached category+filter view is re-shown from its
// still-mounted pane (no re-fetch, same DOM nodes), and a real load shows the
// spinner placeholder instead of an empty pane. Also covers the Favorites
// tab (issue #63) sharing that cache: a star toggle must invalidate a stale
// cached Favorites view and keep every surviving cached card in step.

const dir = __dirname;
const read = (f: string) => readFileSync(join(dir, f), "utf8");

const bm = (id: number, isRead: boolean, isFavorite = false) => ({
  id,
  postId: `p${id}`,
  text: `post ${id}`,
  read: isRead,
  readAt: null,
  favorite: isFavorite,
  categoryIds: [1],
  url: `https://x.com/i/status/${id}`,
  authorName: "a",
  authorUsername: "a",
  createdAt: "2024-01-01T00:00:00Z",
});
const rows = () => [bm(1, false), bm(2, true), bm(3, false, true)];

async function boot() {
  const calls: string[] = [];
  const DATA = rows();
  const dom = new JSDOM(read("index.html").replace(/<script[^>]*><\/script>/g, ""), {
    runScripts: "outside-only",
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  const w = dom.window as any;
  w.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
  w.IntersectionObserver = class { observe() {} disconnect() {} unobserve() {} };
  let release: (() => void) | null = null;
  w.fetch = async (url: string) => {
    calls.push(url);
    const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    if (url.startsWith("/api/tree")) {
      return json({
        tree: [{ id: 1, parentId: null, name: "Cat", path: ["Cat"], total: 3, unread: 2, directTotal: 3, children: [] }],
      });
    }
    if (url.startsWith("/api/setup")) {
      // A configured, already-populated library: the guided flow stays shut.
      return json({
        bookmarkCount: 3,
        configured: true,
        settings: { categorizer: "claude-cli", provider: "claude-cli" },
        catalog: { methods: [], providers: [] },
        credentials: {
          xClientId: { present: true },
          xClientSecret: { present: true },
          typesafeApiKey: { present: false },
        },
        x: { connected: true, canConnect: true, login: { state: "idle", error: null } },
        sync: { available: true, lastSyncedAt: null, status: null },
      });
    }
    if (/\/read$/.test(url)) return json({ bookmark: { read: true, readAt: "2024-01-02T00:00:00Z" } });
    if (/\/favorite$/.test(url)) {
      const id = Number(url.match(/bookmarks\/(\d+)\//)![1]);
      const row = DATA.find((b) => b.id === id)!;
      row.favorite = !row.favorite;
      return json({ bookmark: { favorite: row.favorite } });
    }
    const m = url.match(/^\/api\/categories\/1\/bookmarks\?filter=(\w+)/);
    if (m) {
      if (release === null && (w as any).__hold) await new Promise<void>((r) => (release = r));
      const f = m[1];
      const matching = DATA.filter((b) => {
        if (f === "all") return true;
        if (f === "unread") return !b.read;
        if (f === "read") return b.read;
        return b.favorite;
      });
      return json({
        bookmarks: matching,
        offset: 0,
        hasMore: false,
        counts: { total: 3, unread: 2, favorite: DATA.filter((b) => b.favorite).length },
      });
    }
    return json({});
  };
  for (const f of ["tree-counts.js", "read-toggle.js", "filter-cache.js", "theme.js", "post-scale.js", "sidebar-state.js", "tree-color.js", "categorization.js", "app.js"]) {
    w.eval(read(f));
  }
  await new Promise((r) => setTimeout(r, 50));
  const doc = w.document as Document;
  const tab = (v: string) => doc.querySelector(`.filter-tab[data-filter=${v}]`) as HTMLElement;
  const change = (v: string) => tab(v).click();
  return { w, calls, doc, tab, change, hold: (v: boolean) => ((w as any).__hold = v), release: () => release?.() };
}

const tick = () => new Promise((r) => setTimeout(r, 30));

describe("filter cache reuses rendered panes", () => {
  it("re-shows a cached filter view with the same nodes and no re-fetch", async () => {
    const { doc, calls, change } = await boot();
    (doc.querySelector(".tree-node") as HTMLElement).click();
    await tick();
    const firstCard = doc.querySelector(".bookmark-card")!;
    change("unread");
    await tick();
    const fetchesBefore = calls.filter((c) => c.includes("/bookmarks?")).length;
    change("all");
    await tick();
    expect(calls.filter((c) => c.includes("/bookmarks?")).length).toBe(fetchesBefore);
    const visible = Array.from(doc.querySelectorAll(".view-pane")).filter((p) => !(p as HTMLElement).hidden);
    expect(visible).toHaveLength(1);
    expect(visible[0].querySelector(".bookmark-card")).toBe(firstCard); // same node, never detached
    expect(firstCard.isConnected).toBe(true);
  });

  it("shows the spinner placeholder during a real load, never an empty pane", async () => {
    const { doc, hold, release } = await boot();
    hold(true);
    (doc.querySelector(".tree-node") as HTMLElement).click();
    await tick();
    const loading = doc.querySelector(".view-pane:not([hidden]) .state-loading");
    expect(loading).not.toBeNull();
    expect(loading!.querySelector(".list-spinner")).not.toBeNull();
    release();
    await tick();
    expect(doc.querySelector(".state-loading")).toBeNull();
    expect(doc.querySelectorAll(".bookmark-card").length).toBeGreaterThan(0);
  });

  it("invalidates a stale cached Unread pane after a read toggle and releases its DOM", async () => {
    const { doc, calls, change } = await boot();
    (doc.querySelector(".tree-node") as HTMLElement).click();
    await tick();
    change("unread");
    await tick();
    change("all");
    await tick();
    expect(doc.querySelectorAll(".view-pane").length).toBe(2);
    (doc.querySelector(".bookmark-card .read-pill") as HTMLElement).click(); // mark unread post 1 as read
    await tick();
    expect(doc.querySelectorAll(".view-pane").length).toBe(1); // stale Unread pane released
    const before = calls.filter((c) => c.includes("filter=unread")).length;
    change("unread");
    await tick();
    expect(calls.filter((c) => c.includes("filter=unread")).length).toBe(before + 1); // fetched fresh
  });
});

describe("favorites share the filter cache (issue #63)", () => {
  const cardIds = (doc: Document) =>
    Array.from(doc.querySelectorAll(".view-pane:not([hidden]) .bookmark-card")).map(
      (c) => (c as HTMLElement).dataset.bookmarkId,
    );

  it("the Favorites tab lists only starred posts", async () => {
    const { doc, change } = await boot();
    (doc.querySelector(".tree-node") as HTMLElement).click();
    await tick();
    change("favorite");
    await tick();
    expect(cardIds(doc)).toEqual(["3"]);
  });

  it("marks the active tab and labels the panel with it", async () => {
    const { doc, tab, change } = await boot();
    (doc.querySelector(".tree-node") as HTMLElement).click();
    await tick();
    change("favorite");
    await tick();
    expect(tab("favorite").getAttribute("aria-selected")).toBe("true");
    expect(tab("all").getAttribute("aria-selected")).toBe("false");
    expect(doc.getElementById("bookmark-list")!.getAttribute("aria-labelledby")).toBe(
      "filter-tab-favorite",
    );
  });

  it("starring a post invalidates the stale cached Favorites view", async () => {
    const { doc, calls, change } = await boot();
    (doc.querySelector(".tree-node") as HTMLElement).click();
    await tick();
    change("favorite");
    await tick();
    change("all");
    await tick();
    expect(doc.querySelectorAll(".view-pane").length).toBe(2);

    // Star post 1 from the All view: the cached Favorites list no longer
    // matches, so its pane must be released and re-fetched on the next visit.
    (doc.querySelector(
      '.view-pane:not([hidden]) .bookmark-card[data-bookmark-id="1"] .fav-btn',
    ) as HTMLElement).click();
    await tick();
    expect(doc.querySelectorAll(".view-pane").length).toBe(1);
    const before = calls.filter((c) => c.includes("filter=favorite")).length;
    change("favorite");
    await tick();
    expect(calls.filter((c) => c.includes("filter=favorite")).length).toBe(before + 1);
    expect(cardIds(doc).sort()).toEqual(["1", "3"]);
  });

  it("unstarring inside the Favorites tab drops the card out of it", async () => {
    const { doc, change } = await boot();
    (doc.querySelector(".tree-node") as HTMLElement).click();
    await tick();
    change("favorite");
    await tick();
    (doc.querySelector(
      ".view-pane:not([hidden]) .bookmark-card .fav-btn",
    ) as HTMLElement).click();
    await tick();
    expect(cardIds(doc)).toEqual([]);
    expect(doc.querySelector(".view-pane:not([hidden]) .state-empty")).not.toBeNull();
  });

  it("keeps a surviving cached view's star in step with the toggle", async () => {
    const { doc, change } = await boot();
    (doc.querySelector(".tree-node") as HTMLElement).click();
    await tick();
    change("unread"); // caches the Unread view, which holds post 3 (unread + starred)
    await tick();
    change("all");
    await tick();
    (doc.querySelector(
      '.view-pane:not([hidden]) .bookmark-card[data-bookmark-id="3"] .fav-btn',
    ) as HTMLElement).click();
    await tick();

    // The cached Unread pane keeps post 3 (its read state did not change),
    // so its star must have been patched rather than left stale.
    change("unread");
    await tick();
    const star = doc.querySelector(
      '.view-pane:not([hidden]) .bookmark-card[data-bookmark-id="3"] .fav-btn',
    ) as HTMLElement;
    expect(star.getAttribute("aria-pressed")).toBe("false");
  });
});
