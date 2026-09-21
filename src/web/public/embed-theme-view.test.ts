import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";

// Drives the REAL app.js + index.html in jsdom, with a stubbed widgets.js, to
// pin the issue #90 behavior: a post shown under a theme keeps that theme's
// embed MOUNTED (hidden) beside the other one, so toggling back to a theme
// already seen reveals it instantly instead of calling createTweet again.
// Only a theme a post has never been shown in costs a load.

const dir = __dirname;
const read = (f: string) => readFileSync(join(dir, f), "utf8");

const bm = (id: number, isRead = false, isFavorite = false) => ({
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

type Created = { postId: string; theme: string };

async function boot(opts: { maxEmbeds?: number } = {}) {
  const DATA = [bm(1), bm(2, true), bm(3, false, true)];
  const created: Created[] = [];
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
  // A widgets.js that always renders, so every card gets a real (stub) embed
  // rather than the text+link fallback - the fallback has its own reuse rule.
  w.twttr = {
    widgets: {
      createTweet(postId: string, host: HTMLElement, options: { theme: string }) {
        created.push({ postId, theme: options.theme });
        const frame = w.document.createElement("iframe");
        frame.dataset.tweet = postId;
        frame.dataset.theme = options.theme;
        host.appendChild(frame);
        return Promise.resolve(frame);
      },
    },
  };
  w.fetch = async (url: string) => {
    const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    if (url.startsWith("/api/tree")) {
      return json({
        tree: [
          { id: 1, parentId: null, name: "Cat", path: ["Cat"], total: 3, unread: 2, directTotal: 3, children: [] },
        ],
      });
    }
    if (url.startsWith("/api/setup")) {
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
  for (const f of [
    "tree-counts.js",
    "read-toggle.js",
    "filter-cache.js",
    "theme.js",
    "embed-theme.js",
    "post-scale.js",
    "sidebar-state.js",
    "tree-color.js",
    "categorization.js",
  ]) {
    w.eval(read(f));
  }
  // Shrinking the variant cap is how the LRU bound is exercised without
  // mounting 160 embeds; app.js reads it per call, so this takes effect for
  // every pass below.
  if (opts.maxEmbeds !== undefined) w.XBOEmbedTheme.MAX_POOLED_EMBEDS = opts.maxEmbeds;
  w.eval(read("app.js"));
  await tick();
  const doc = w.document as Document;
  (doc.querySelector(".tree-node") as HTMLElement).click();
  await tick();
  return {
    w,
    doc,
    created,
    toggleTheme: async () => {
      (doc.getElementById("theme-toggle") as HTMLElement).click();
      await tick();
    },
  };
}

// Longer than app.js's 60ms re-theme debounce.
const tick = () => new Promise((r) => setTimeout(r, 120));

const slots = (doc: Document) =>
  Array.from(doc.querySelectorAll(".bookmark-card:not([hidden]) .embed-slot")) as HTMLElement[];
const variants = (slot: HTMLElement) => Array.from(slot.querySelectorAll(".embed-variant")) as HTMLElement[];
const shownTheme = (slot: HTMLElement) => variants(slot).find((v) => !v.hidden)?.dataset.embedTheme;

describe("per-theme embed cache (issue #90)", () => {
  it("loads each theme once and REVEALS the cached variant when the theme comes back", async () => {
    const { doc, created, toggleTheme } = await boot();
    expect(created.map((c) => c.theme)).toEqual(["light", "light", "light"]);
    const lightFrames = Array.from(doc.querySelectorAll(".embed-variant iframe"));
    expect(lightFrames).toHaveLength(3);

    await toggleTheme(); // light -> dark: never seen, so it loads (once)
    expect(created.filter((c) => c.theme === "dark")).toHaveLength(3);
    expect(slots(doc).map(shownTheme)).toEqual(["dark", "dark", "dark"]);

    await toggleTheme(); // dark -> light: already built, so nothing loads
    expect(created).toHaveLength(6); // still 3 light + 3 dark
    expect(slots(doc).map(shownTheme)).toEqual(["light", "light", "light"]);
    // The very same iframes, never detached and re-attached (which reloads).
    expect(Array.from(doc.querySelectorAll('.embed-variant[data-embed-theme="light"] iframe'))).toEqual(
      lightFrames,
    );
    for (const frame of lightFrames) expect(frame.isConnected).toBe(true);
  });

  it("keeps exactly one variant visible per card, so a post never renders twice", async () => {
    const { doc, toggleTheme } = await boot();
    await toggleTheme();
    for (const slot of slots(doc)) {
      expect(variants(slot)).toHaveLength(2);
      expect(variants(slot).filter((v) => !v.hidden)).toHaveLength(1);
    }
  });

  it("a read or favorite toggle patches the shared card without reloading either variant", async () => {
    const { doc, created, toggleTheme } = await boot();
    await toggleTheme(); // both variants now exist for every card
    const before = created.length;
    const card = doc.querySelector('.bookmark-card[data-bookmark-id="1"]') as HTMLElement;
    const frames = Array.from(card.querySelectorAll("iframe"));
    expect(frames).toHaveLength(2);

    (card.querySelector(".read-pill") as HTMLElement).click();
    await tick();
    (card.querySelector(".fav-btn") as HTMLElement).click();
    await tick();

    expect(created).toHaveLength(before); // no embed was rebuilt
    expect(Array.from(card.querySelectorAll("iframe"))).toEqual(frames);
    expect(card.classList.contains("is-unread")).toBe(false);
    // ...and the card still carries one variant per theme, one of them shown.
    const slot = card.querySelector(".embed-slot") as HTMLElement;
    expect(variants(slot).map((v) => v.dataset.embedTheme).sort()).toEqual(["dark", "light"]);
    expect(shownTheme(slot)).toBe("dark");
  });

  it("bounds the mounted embeds: the coldest SPARE variant is released, never the visible one", async () => {
    // One variant per card and no more, so every spare has to go.
    const { doc, created, toggleTheme } = await boot({ maxEmbeds: 3 });
    expect(created).toHaveLength(3);

    await toggleTheme();
    for (const slot of slots(doc)) {
      // The light copy was evicted; the dark one being SHOWN is protected.
      expect(variants(slot)).toHaveLength(1);
      expect(shownTheme(slot)).toBe("dark");
    }

    await toggleTheme();
    expect(created).toHaveLength(9); // nothing was cached, so light loads again
    expect(slots(doc).map(shownTheme)).toEqual(["light", "light", "light"]);
  });

  it("releases every variant of a post dropped from the pool", async () => {
    const { doc, w, toggleTheme } = await boot();
    await toggleTheme();
    const card = doc.querySelector('.bookmark-card[data-bookmark-id="1"]') as HTMLElement;
    const frames = Array.from(card.querySelectorAll("iframe"));
    expect(frames).toHaveLength(2); // one embed per theme

    // Shrink the POST pool and leave a view that holds only post 2: posts 1
    // and 3 are no longer on screen, so the post LRU releases them.
    w.XBOFilterCache.MAX_POOLED_POSTS = 1;
    (doc.querySelector(".filter-tab[data-filter=read]") as HTMLElement).click();
    await tick();

    expect(doc.querySelector('.bookmark-card[data-bookmark-id="1"]')).toBeNull();
    for (const frame of frames) expect(frame.isConnected).toBe(false);
  });
});
