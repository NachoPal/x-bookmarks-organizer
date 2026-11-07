import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";

/**
 * Drives the REAL app.js + index.html in jsdom to pin the top-bar search
 * bar: the magnifier toggles it (never the sidebar's own category filter),
 * typing/Enter runs a search against a stubbed `/api/search`, the results
 * header and the floating sort chip's "Relevance" option appear, the help
 * popover opens on hover/focus/tap and closes on Escape, and the from:/
 * category:/list: autocomplete offers and applies a suggestion.
 */

const dir = __dirname;
const read = (f: string) => readFileSync(join(dir, f), "utf8");

const bm = (id: number, text: string) => ({
  id,
  postId: `p${id}`,
  text,
  read: false,
  readAt: null,
  favorite: false,
  categoryIds: [],
  url: `https://x.com/i/status/${id}`,
  authorName: "a",
  authorUsername: "a",
  createdAt: "2024-01-01T00:00:00Z",
  hasSummary: false,
  score: null,
  xArticle: null,
});

interface Opts {
  searchResults?: ReturnType<typeof bm>[];
  authors?: string[];
  tree?: unknown[];
  lists?: { id: number; title: string }[];
}

async function boot(opts: Opts = {}) {
  const calls: { url: string; method: string }[] = [];
  const results = opts.searchResults ?? [bm(1, "agent harness evaluation")];
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
  w.EventSource = class {
    addEventListener() {}
  };
  w.fetch = async (url: string, init?: { method?: string }) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
    if (url.startsWith("/api/tree")) {
      return json({ tree: opts.tree ?? [{ id: 1, parentId: null, name: "AI", path: ["AI"], total: 1, unread: 1, directTotal: 1, children: [] }] });
    }
    if (url.startsWith("/api/setup")) {
      return json({
        bookmarkCount: 3,
        configured: true,
        settings: { categorizer: "claude-cli", provider: "claude-cli" },
        catalog: { methods: [], providers: [] },
        credentials: { xClientId: { present: true }, xClientSecret: { present: true }, typesafeApiKey: { present: false } },
        x: { connected: true, canConnect: true, login: { state: "idle", error: null } },
        sync: { available: true, lastSyncedAt: null, status: null },
      });
    }
    if (url === "/api/assistant-lists") return json({ lists: opts.lists ?? [] });
    if (url.startsWith("/api/search/authors")) return json({ authors: opts.authors ?? ["karpathy", "kagi"] });
    if (url.startsWith("/api/search")) {
      const q = new URL(url, "http://localhost").searchParams.get("q") ?? "";
      if (q.includes("category:Nope")) return json({ error: 'No category matches "Nope".' }, 400);
      return json({ bookmarks: results, query: q, mode: "all", offset: 0, limit: 20, sort: "relevance", dir: "desc", total: results.length, hasMore: false });
    }
    const m = url.match(/^\/api\/categories\/1\/bookmarks/);
    if (m) return json({ bookmarks: [], offset: 0, hasMore: false, counts: { total: 0, unread: 0, favorite: 0 } });
    return json({});
  };
  for (const f of [
    "tree-counts.js",
    "sort-order.js",
    "search-bar.js",
    "search-suggest.js",
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
  await tick(80);
  const doc = w.document as Document;
  return { w, doc, calls };
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const key = (w: any, target: EventTarget, k: string) =>
  target.dispatchEvent(new w.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));

describe("the search bar", () => {
  it("is closed by default and opened/closed by the magnifier, never the sidebar's category filter", async () => {
    const { doc } = await boot();
    const bar = doc.getElementById("search-bar") as HTMLElement;
    expect(bar.hidden).toBe(true);
    (doc.getElementById("search-open") as HTMLElement).click();
    expect(bar.hidden).toBe(false);
    expect(doc.activeElement!.id).toBe("search-bar-input");
    expect(doc.getElementById("search-open")!.getAttribute("aria-expanded")).toBe("true");
    // The sidebar's own filter was never touched.
    expect(doc.body.getAttribute("data-sidebar-page")).not.toBe("categories");

    (doc.getElementById("search-open") as HTMLElement).click();
    expect(bar.hidden).toBe(true);
    expect(doc.activeElement!.id).toBe("search-open");
  });

  it("Escape closes the bar and returns focus to the magnifier", async () => {
    const { doc, w } = await boot();
    (doc.getElementById("search-open") as HTMLElement).click();
    const input = doc.getElementById("search-bar-input") as HTMLInputElement;
    key(w, input, "Escape");
    expect((doc.getElementById("search-bar") as HTMLElement).hidden).toBe(true);
    expect(doc.activeElement!.id).toBe("search-open");
  });

  it("runs a search on Enter and shows the results header and posts", async () => {
    const { doc, w, calls } = await boot({ searchResults: [bm(1, "agent harness evaluation")] });
    (doc.getElementById("search-open") as HTMLElement).click();
    const input = doc.getElementById("search-bar-input") as HTMLInputElement;
    input.value = "evaluation";
    input.dispatchEvent(new w.Event("input", { bubbles: true }));
    key(w, input, "Enter");
    await tick();
    expect(calls.some((c) => c.url.startsWith("/api/search?q=evaluation"))).toBe(true);
    expect(doc.getElementById("search-results-header")!.hidden).toBe(false);
    expect(doc.getElementById("search-results-header")!.textContent).toContain("1 result for evaluation");
    expect(doc.querySelector('.bookmark-card[data-bookmark-id="1"]')).not.toBeNull();
  });

  it("debounces live typing without pressing Enter", async () => {
    const { doc, w, calls } = await boot();
    (doc.getElementById("search-open") as HTMLElement).click();
    const input = doc.getElementById("search-bar-input") as HTMLInputElement;
    input.value = "evaluation";
    input.dispatchEvent(new w.Event("input", { bubbles: true }));
    expect(calls.some((c) => c.url.startsWith("/api/search?"))).toBe(false);
    await tick(400);
    expect(calls.some((c) => c.url.startsWith("/api/search?q=evaluation"))).toBe(true);
  });

  it("offers Relevance as the default sort, with Newest/Top score alongside it, during a search", async () => {
    const { doc, w } = await boot();
    (doc.getElementById("search-open") as HTMLElement).click();
    const input = doc.getElementById("search-bar-input") as HTMLInputElement;
    input.value = "x";
    input.dispatchEvent(new w.Event("input", { bubbles: true }));
    key(w, input, "Enter");
    await tick();
    const visible = [...doc.querySelectorAll<HTMLInputElement>(".sort-opt-input")].filter((i) => !i.closest(".sort-opt")!.hidden);
    expect(visible.map((i) => i.value)).toEqual(["relevance", "recent", "score"]);
    expect(doc.querySelector('.sort-opt-input[value="relevance"]')!.hasAttribute("checked") || (doc.querySelector('.sort-opt-input[value="relevance"]') as HTMLInputElement).checked).toBe(true);
    // Relevance has no real direction, so the toggle is hidden for it.
    expect((doc.getElementById("sort-direction") as HTMLElement).hidden).toBe(true);
  });

  it("shows an empty state for no results, and a clear error for a bad operator", async () => {
    const { doc, w } = await boot({ searchResults: [] });
    (doc.getElementById("search-open") as HTMLElement).click();
    const input = doc.getElementById("search-bar-input") as HTMLInputElement;
    input.value = "nothing";
    input.dispatchEvent(new w.Event("input", { bubbles: true }));
    key(w, input, "Enter");
    await tick();
    expect(doc.querySelector("#bookmark-list .state-empty")!.textContent).toContain("No results for nothing");

    input.value = "category:Nope";
    input.dispatchEvent(new w.Event("input", { bubbles: true }));
    key(w, input, "Enter");
    await tick();
    expect(doc.querySelector("#bookmark-list .state-error")!.textContent).toContain("No category matches");
  });

  it("closing the search returns to the previous view (nothing selected, here)", async () => {
    const { doc, w } = await boot();
    (doc.getElementById("search-open") as HTMLElement).click();
    const input = doc.getElementById("search-bar-input") as HTMLInputElement;
    input.value = "evaluation";
    input.dispatchEvent(new w.Event("input", { bubbles: true }));
    key(w, input, "Enter");
    await tick();
    expect(doc.querySelector(".state-welcome")).toBeNull();
    (doc.getElementById("search-open") as HTMLElement).click(); // close
    expect(doc.querySelector(".state-welcome")).not.toBeNull();
  });
});

describe("the search bar's 'How to search' popover", () => {
  it("opens on focus and closes on Escape, returning focus to the info button", async () => {
    const { doc, w } = await boot();
    (doc.getElementById("search-open") as HTMLElement).click();
    const toggle = doc.getElementById("search-help-toggle") as HTMLElement;
    const popover = doc.getElementById("search-help-popover") as HTMLElement;
    toggle.focus();
    toggle.dispatchEvent(new w.FocusEvent("focus"));
    expect(popover.hidden).toBe(false);
    expect(doc.querySelectorAll("#search-help-list dt").length).toBeGreaterThan(0);
    key(w, toggle, "Escape");
    expect(popover.hidden).toBe(true);
    expect(doc.activeElement!.id).toBe("search-help-toggle");
  });

  it("opens and closes on click (touch/tap)", async () => {
    const { doc } = await boot();
    (doc.getElementById("search-open") as HTMLElement).click();
    const toggle = doc.getElementById("search-help-toggle") as HTMLElement;
    const popover = doc.getElementById("search-help-popover") as HTMLElement;
    toggle.click();
    expect(popover.hidden).toBe(false);
    toggle.click();
    expect(popover.hidden).toBe(true);
  });
});

describe("the search bar's from:/category:/list: autocomplete", () => {
  it("suggests authors for from: and applies one on Enter", async () => {
    const { doc, w } = await boot({ authors: ["karpathy", "kagi"] });
    (doc.getElementById("search-open") as HTMLElement).click();
    await tick(10); // authors fetch
    const input = doc.getElementById("search-bar-input") as HTMLInputElement;
    input.value = "from:ka";
    input.setSelectionRange(7, 7);
    input.dispatchEvent(new w.Event("input", { bubbles: true }));
    const list = doc.getElementById("search-suggest-list") as HTMLElement;
    expect(list.hidden).toBe(false);
    expect(list.textContent).toContain("@karpathy");
    expect(list.textContent).toContain("@kagi");
    expect(input.getAttribute("aria-expanded")).toBe("true");

    key(w, input, "Enter");
    expect(input.value).toBe("from:@karpathy ");
    expect(list.hidden).toBe(true);
  });

  it("suggests categories for category: from the already-loaded tree", async () => {
    const { doc, w } = await boot({
      tree: [{ id: 1, parentId: null, name: "AI", path: ["AI"], total: 0, unread: 0, directTotal: 0, children: [] }],
    });
    (doc.getElementById("search-open") as HTMLElement).click();
    const input = doc.getElementById("search-bar-input") as HTMLInputElement;
    input.value = "category:A";
    input.setSelectionRange(10, 10);
    input.dispatchEvent(new w.Event("input", { bubbles: true }));
    const list = doc.getElementById("search-suggest-list") as HTMLElement;
    expect(list.hidden).toBe(false);
    expect(list.textContent).toContain("AI");
  });

  it("suggests list names for list: from the already-loaded lists", async () => {
    const { doc, w } = await boot({ lists: [{ id: 1, title: "Read later" }] });
    await tick(10);
    (doc.getElementById("search-open") as HTMLElement).click();
    const input = doc.getElementById("search-bar-input") as HTMLInputElement;
    input.value = "list:Read";
    input.setSelectionRange(9, 9);
    input.dispatchEvent(new w.Event("input", { bubbles: true }));
    const list = doc.getElementById("search-suggest-list") as HTMLElement;
    expect(list.hidden).toBe(false);
    expect(list.textContent).toContain("Read later");
  });

  it("ArrowDown/ArrowUp move the active suggestion, keyboard-navigably", async () => {
    const { doc, w } = await boot({ authors: ["karpathy", "kagi"] });
    (doc.getElementById("search-open") as HTMLElement).click();
    await tick(10);
    const input = doc.getElementById("search-bar-input") as HTMLInputElement;
    input.value = "from:k";
    input.setSelectionRange(6, 6);
    input.dispatchEvent(new w.Event("input", { bubbles: true }));
    expect(input.getAttribute("aria-activedescendant")).toBe("search-suggest-opt-0");
    key(w, input, "ArrowDown");
    expect(input.getAttribute("aria-activedescendant")).toBe("search-suggest-opt-1");
    key(w, input, "ArrowUp");
    expect(input.getAttribute("aria-activedescendant")).toBe("search-suggest-opt-0");
  });
});
