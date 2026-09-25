import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";

// Drives the REAL app.js + index.html in jsdom with a stubbed fetch and a fake
// EventSource, to pin the "From your assistant" section: a list an assistant
// sends with the MCP tool `show_in_app` arrives live (section row + toast,
// never a yanked view), opens as ordinary pooled cards in the assistant's
// order, renders its untrusted title/note as text only, and deletes with Undo.

const dir = __dirname;
const read = (f: string) => readFileSync(join(dir, f), "utf8");

const bm = (id: number, isRead = false) => ({
  id,
  postId: `p${id}`,
  text: `post ${id}`,
  read: isRead,
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

const NOW = new Date().toISOString();
const list = (id: number, title: string, ids: number[], note: string | null = null) => ({
  id,
  title,
  note,
  createdAt: NOW,
  count: ids.length,
  ids,
});

interface Opts {
  lists?: ReturnType<typeof list>[];
  openList?: number;
}

async function boot(opts: Opts = {}) {
  const calls: { url: string; method: string; body?: string }[] = [];
  const posts = [bm(1), bm(2, true), bm(3)];
  let lists = opts.lists ?? [];
  const dom = new JSDOM(read("index.html").replace(/<script[^>]*><\/script>/g, ""), {
    runScripts: "outside-only",
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  const w = dom.window as any;
  if (opts.openList != null) w.localStorage.setItem("xbo:assistant-list", String(opts.openList));
  w.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
  w.IntersectionObserver = class {
    observe() {}
    disconnect() {}
    unobserve() {}
  };
  // The safe-delete undo window (6s) collapses to a few ms; nothing else in
  // the app uses exactly that delay.
  const realSetTimeout = w.setTimeout.bind(w);
  w.setTimeout = (fn: () => void, ms?: number) => realSetTimeout(fn, ms === 6000 ? 40 : ms);
  const sources: any[] = [];
  w.EventSource = class {
    url: string;
    listeners = new Map<string, ((e: { data: string }) => void)[]>();
    constructor(url: string) {
      this.url = url;
      sources.push(this);
    }
    addEventListener(type: string, fn: (e: { data: string }) => void) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
    }
    emit(type: string, data: unknown = {}) {
      for (const fn of this.listeners.get(type) ?? []) fn({ data: JSON.stringify(data) });
    }
  };
  const summary = (l: ReturnType<typeof list>) => ({ id: l.id, title: l.title, note: l.note, createdAt: l.createdAt, count: l.ids.length });
  w.fetch = async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body });
    const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
    if (url.startsWith("/api/tree")) {
      return json({
        tree: [{ id: 1, parentId: null, name: "Cat", path: ["Cat"], total: 3, unread: 2, directTotal: 3, children: [] }],
      });
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
    if (url === "/api/assistant-lists" && method === "GET") return json({ lists: lists.map(summary) });
    if (url === "/api/assistant-lists" && method === "DELETE") {
      const ids: number[] = JSON.parse(init!.body!).ids;
      lists = lists.filter((l) => !ids.includes(l.id));
      return json({ deleted: ids.length });
    }
    const one = url.match(/^\/api\/assistant-lists\/(\d+)$/);
    if (one) {
      const found = lists.find((l) => l.id === Number(one[1]));
      if (!found) return json({ error: "list not found" }, 404);
      return json({ list: summary(found), bookmarks: found.ids.map((id) => posts.find((p) => p.id === id)) });
    }
    if (/\/read$/.test(url)) {
      const id = Number(url.match(/bookmarks\/(\d+)\//)![1]);
      const row = posts.find((b) => b.id === id)!;
      row.read = JSON.parse(init!.body!).read;
      return json({ bookmark: { read: row.read, readAt: null } });
    }
    const m = url.match(/^\/api\/categories\/1\/bookmarks\?filter=(\w+)/);
    if (m) {
      const f = m[1];
      const matching = posts.filter((b) => (f === "unread" ? !b.read : f === "read" ? b.read : true));
      return json({ bookmarks: matching, offset: 0, hasMore: false, counts: { total: 3, unread: 2, favorite: 0 } });
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
    "view-persist.js",
    "breadcrumb.js",
    "categorization.js",
    "assistant-lists.js",
    "app.js",
  ]) {
    w.eval(read(f));
  }
  await tick(80);
  const doc = w.document as Document;
  return {
    w,
    doc,
    calls,
    stream: () => sources[0],
    addList: (l: ReturnType<typeof list>) => {
      lists = [...lists, l];
      return summary(l);
    },
    dropList: (id: number) => {
      lists = lists.filter((l) => l.id !== id);
    },
  };
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

const visibleIds = (doc: Document) =>
  Array.from(doc.querySelectorAll(".bookmark-card"))
    .filter((c) => !(c as HTMLElement).hidden)
    .sort((x, y) => Number((x as HTMLElement).style.order) - Number((y as HTMLElement).style.order))
    .map((c) => (c as HTMLElement).dataset.bookmarkId);
const rows = (doc: Document) =>
  Array.from(doc.querySelectorAll(".assistant-list-item")).map((b) => b.querySelector(".assistant-list-title")!.textContent);
const section = (doc: Document) => doc.getElementById("assistant-lists") as HTMLElement;
const toastAction = (doc: Document, label: string) =>
  Array.from(doc.querySelectorAll(".toast-action")).find((b) => b.textContent === label) as HTMLElement | undefined;

describe("From your assistant (MCP show_in_app lists)", () => {
  it("is absent with no lists, and lists what the server holds, newest first", async () => {
    const empty = await boot();
    expect(section(empty.doc).hidden).toBe(true);
    const { doc } = await boot({ lists: [list(1, "Older", [1]), { ...list(2, "Newer", [2]), createdAt: "2999-01-01T00:00:00Z" }] });
    expect(section(doc).hidden).toBe(false);
    expect(rows(doc)).toEqual(["Newer", "Older"]);
  });

  it("surfaces a list the moment it arrives, without leaving the open category", async () => {
    const { doc, stream, addList, calls } = await boot();
    expect(stream().url).toBe("/api/assistant-lists/events");
    (doc.querySelector(".tree-node") as HTMLElement).click();
    await tick();
    expect(visibleIds(doc)).toEqual(["1", "2", "3"]);

    stream().emit("created", addList(list(7, "Eval harnesses", [3, 1], "Why these two")));
    await tick();
    expect(rows(doc)).toEqual(["Eval harnesses"]);
    expect(doc.querySelector(".assistant-list-new")!.textContent).toBe("New");
    const toast = doc.querySelector(".toast")!;
    expect(toast.textContent).toContain("Your assistant sent 2 posts: Eval harnesses");
    // The owner's view is untouched until they choose to open it.
    expect(doc.getElementById("content-title")!.textContent).toBe("Cat");
    expect(visibleIds(doc)).toEqual(["1", "2", "3"]);

    toastAction(doc, "Open")!.click();
    await tick();
    expect(calls.some((c) => c.url === "/api/assistant-lists/7")).toBe(true);
    expect(doc.getElementById("content-title")!.textContent).toBe("Eval harnesses");
    expect(visibleIds(doc)).toEqual(["3", "1"]); // the assistant's order
    expect((doc.getElementById("assistant-list-header") as HTMLElement).hidden).toBe(false);
    expect(doc.getElementById("assistant-list-note")!.textContent).toBe("Why these two");
    expect((doc.getElementById("toolbar") as HTMLElement).hidden).toBe(true); // no tabs, no sort
    expect(doc.querySelector('.assistant-list-item[aria-current="true"]')).not.toBeNull();
    expect(doc.querySelector('.tree-node[aria-current="true"]')).toBeNull();
    expect(doc.querySelector(".assistant-list-new")).toBeNull(); // seen now
  });

  it("renders an assistant's title and note as text, never as markup", async () => {
    const hostile = '<img src=x onerror="window.__pwned=1">';
    const { doc, w } = await boot({ lists: [list(3, hostile, [1], `<b>bold</b>${hostile}`)] });
    (doc.querySelector(".assistant-list-item") as HTMLElement).click();
    await tick();
    expect(doc.querySelector("img[src=x]")).toBeNull();
    expect(doc.getElementById("content-title")!.textContent).toBe(hostile);
    expect(doc.getElementById("assistant-list-note")!.textContent).toBe(`<b>bold</b>${hostile}`);
    expect(w.__pwned).toBeUndefined();
  });

  it("keeps every post on screen whatever its read state, even coming from the Unread tab", async () => {
    const { doc } = await boot({ lists: [list(4, "Mixed", [1, 2, 3])] });
    (doc.querySelector(".tree-node") as HTMLElement).click();
    await tick();
    (doc.querySelector('.filter-tab[data-filter="unread"]') as HTMLElement).click();
    await tick();
    expect(visibleIds(doc)).toEqual(["1", "3"]);
    (doc.querySelector(".assistant-list-item") as HTMLElement).click();
    await tick();
    expect(visibleIds(doc)).toEqual(["1", "2", "3"]); // the read post 2 too
    const card = doc.querySelector('.bookmark-card[data-bookmark-id="1"]') as HTMLElement;
    (card.querySelector(".read-pill") as HTMLElement).click();
    await tick(80);
    expect(visibleIds(doc)).toEqual(["1", "2", "3"]);
    // Picking the category again brings its own tab back as it was.
    (doc.querySelector(".tree-node") as HTMLElement).click();
    await tick();
    expect(doc.getElementById("content-title")!.textContent).toBe("Cat");
    expect((doc.getElementById("assistant-list-header") as HTMLElement).hidden).toBe(true);
  });

  it("deletes a list with Undo, and only the ids it hid", async () => {
    const { doc, calls, stream, addList } = await boot({ lists: [list(5, "Doomed", [1])] });
    (doc.querySelector(".assistant-list-item") as HTMLElement).click();
    await tick();
    (doc.getElementById("assistant-list-delete") as HTMLElement).click();
    expect(section(doc).hidden).toBe(true);
    expect(doc.getElementById("content-title")!.textContent).toBe("Select a category");
    toastAction(doc, "Undo")!.click();
    await tick(80);
    expect(rows(doc)).toEqual(["Doomed"]);
    expect(doc.getElementById("content-title")!.textContent).toBe("Doomed");
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);

    // Clear all, while a new list arrives inside the undo window.
    (doc.getElementById("assistant-lists-clear") as HTMLElement).click();
    stream().emit("created", addList(list(6, "Arrived meanwhile", [2])));
    await tick(120);
    const del = calls.find((c) => c.method === "DELETE")!;
    expect(JSON.parse(del.body!)).toEqual({ ids: [5] });
    expect(rows(doc)).toEqual(["Arrived meanwhile"]);
  });

  it("reopens the list that was open before a reload, and forgets one that is gone", async () => {
    const { doc } = await boot({ lists: [list(8, "Kept", [2, 3])], openList: 8 });
    expect(doc.getElementById("content-title")!.textContent).toBe("Kept");
    expect(visibleIds(doc)).toEqual(["2", "3"]);

    const gone = await boot({ lists: [], openList: 99 });
    expect(gone.doc.getElementById("content-title")!.textContent).not.toBe("Kept");
    expect(gone.w.localStorage.getItem("xbo:assistant-list")).toBeNull();
  });

  it("leaves a list deleted in another tab when the stream says the index changed", async () => {
    const { doc, stream, dropList } = await boot({ lists: [list(9, "Elsewhere", [1])] });
    (doc.querySelector(".assistant-list-item") as HTMLElement).click();
    await tick();
    dropList(9);
    stream().emit("changed");
    await tick();
    expect(section(doc).hidden).toBe(true);
    expect(doc.getElementById("content-title")!.textContent).toBe("Select a category");
    expect(visibleIds(doc)).toEqual([]);
  });
});
