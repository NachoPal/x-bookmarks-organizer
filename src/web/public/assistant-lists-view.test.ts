import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";

// Drives the REAL app.js + index.html in jsdom with a stubbed fetch and a fake
// EventSource, to pin the sidebar's Lists page: a list an assistant sends with
// the MCP tool `show_in_app` arrives live (a row + toast, never a yanked
// view), opens as ordinary pooled cards in the assistant's order, renders its
// untrusted title/note as text only, and deletes with Undo. And the sidebar's
// drill-down around it: the menu, the Categories and Lists pages, Back,
// Escape, focus, the persisted page and the unviewed-lists count.

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
const list = (id: number, title: string, ids: number[], note: string | null = null, viewed = false) => ({
  id,
  title,
  note,
  createdAt: NOW,
  count: ids.length,
  viewed,
  ids,
});

interface Opts {
  lists?: ReturnType<typeof list>[];
  openList?: number;
  /** What `xbo:sidebar-page` holds at load. */
  page?: string;
  /** Start with the sidebar open (the stored default is closed). */
  sidebarOpen?: boolean;
  /** How many index reads fail (500) before the server answers. */
  failLists?: number;
}

async function boot(opts: Opts = {}) {
  const calls: { url: string; method: string; body?: string }[] = [];
  const posts = [bm(1), bm(2, true), bm(3)];
  let lists = opts.lists ?? [];
  let failLists = opts.failLists ?? 0;
  const dom = new JSDOM(read("index.html").replace(/<script[^>]*><\/script>/g, ""), {
    runScripts: "outside-only",
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  const w = dom.window as any;
  if (opts.openList != null) w.localStorage.setItem("xbo:assistant-list", String(opts.openList));
  if (opts.page != null) w.localStorage.setItem("xbo:sidebar-page", opts.page);
  if (opts.sidebarOpen) w.localStorage.setItem("xbo:sidebar-collapsed", "0");
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
  // Unread is read off the posts' own flags, as the server's count is.
  const summary = (l: ReturnType<typeof list>) => ({
    id: l.id,
    title: l.title,
    note: l.note,
    createdAt: l.createdAt,
    count: l.ids.length,
    unread: l.ids.filter((id) => !posts.find((p) => p.id === id)!.read).length,
    viewed: l.viewed,
  });
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
    if (url === "/api/assistant-lists" && method === "GET") {
      if (failLists > 0) {
        failLists -= 1;
        return json({ error: "boom" }, 500);
      }
      return json({ lists: lists.map(summary) });
    }
    if (url === "/api/assistant-lists" && method === "DELETE") {
      const ids: number[] = JSON.parse(init!.body!).ids;
      lists = lists.filter((l) => !ids.includes(l.id));
      return json({ deleted: ids.length });
    }
    const viewed = url.match(/^\/api\/assistant-lists\/(\d+)\/viewed$/);
    if (viewed && method === "POST") {
      const found = lists.find((l) => l.id === Number(viewed[1]));
      if (!found) return json({ error: "list not found" }, 404);
      found.viewed = true;
      return json({ list: summary(found) });
    }
    const one = url.match(/^\/api\/assistant-lists\/(\d+)(?:\?sort=(\w+)&dir=(\w+))?$/);
    if (one) {
      const found = lists.find((l) => l.id === Number(one[1]));
      if (!found) return json({ error: "list not found" }, 404);
      // "recent" stands in as the higher id first; "list" is the assistant's order.
      let ids = one[2] === "recent" ? found.ids.slice().sort((a, b) => b - a) : found.ids.slice();
      if (one[3] === "asc") ids = ids.reverse();
      return json({ list: summary(found), bookmarks: ids.map((id) => posts.find((p) => p.id === id)) });
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
    /** Another tab opened a list: the server's copy is viewed now. */
    viewElsewhere: (id: number) => {
      lists.find((l) => l.id === id)!.viewed = true;
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
const listsState = (doc: Document) => doc.getElementById("assistant-lists-state")!.textContent!.trim();
const page = (doc: Document) => doc.body.getAttribute("data-sidebar-page");
const view = (doc: Document, name: string) => doc.querySelector(`[data-sidebar-view="${name}"]`) as HTMLElement;
const homeRow = (doc: Document, name: string) =>
  doc.querySelector(`.sidebar-home-row[data-sidebar-page="${name}"]`) as HTMLElement;
const listsBadge = (doc: Document) => doc.querySelector("#sidebar-home-lists [data-unviewed-badge]") as HTMLElement;
/** The badge's number, or null while it is hidden (nothing unviewed). */
const unviewed = (doc: Document) => (listsBadge(doc).hidden ? null : listsBadge(doc).textContent);
const key = (w: any, target: EventTarget, k: string) =>
  target.dispatchEvent(new w.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
const toastAction = (doc: Document, label: string) =>
  Array.from(doc.querySelectorAll(".toast-action")).find((b) => b.textContent === label) as HTMLElement | undefined;

describe("Lists (MCP show_in_app lists)", () => {
  it("says there are none yet, and lists what the server holds, newest first", async () => {
    const empty = await boot();
    expect(rows(empty.doc)).toEqual([]);
    expect(listsState(empty.doc)).toContain("No lists yet");
    expect(empty.doc.getElementById("sidebar-home-meta-lists")!.textContent).toBe("None yet");
    expect((empty.doc.getElementById("assistant-lists-clear") as HTMLElement).hidden).toBe(true);
    const { doc } = await boot({ lists: [list(1, "Older", [1]), { ...list(2, "Newer", [2]), createdAt: "2999-01-01T00:00:00Z" }] });
    expect(rows(doc)).toEqual(["Newer", "Older"]);
    expect(listsState(doc)).toBe("");
    expect(doc.getElementById("sidebar-home-meta-lists")!.textContent).toBe("2 lists");
    expect((doc.getElementById("assistant-lists-clear") as HTMLElement).hidden).toBe(false);
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
    expect(page(doc)).toBe("lists"); // Open takes the sidebar to where the list is
    expect(calls.some((c) => c.url === "/api/assistant-lists/7?sort=list&dir=desc")).toBe(true);
    expect(calls.some((c) => c.url === "/api/assistant-lists/7/viewed" && c.method === "POST")).toBe(true);
    expect(doc.getElementById("content-title")!.textContent).toBe("List: Eval harnesses");
    // Marked as a list by the sidebar's Lists icon, not by an eyebrow in the pane.
    expect(doc.querySelector("#content-title .topbar-list-icon")!.getAttribute("aria-hidden")).toBe("true");
    expect(visibleIds(doc)).toEqual(["3", "1"]); // the assistant's order
    expect((doc.getElementById("toolbar") as HTMLElement).hidden).toBe(true); // no tabs
    expect((doc.getElementById("sort-bar") as HTMLElement).hidden).toBe(false); // but it can be ordered
    expect(doc.querySelector('.assistant-list-item[aria-current="true"]')).not.toBeNull();
    expect(doc.querySelector('.tree-node[aria-current="true"]')).toBeNull();
    expect(doc.querySelector(".assistant-list-new")).toBeNull(); // seen now
  });

  it("renders an assistant's title and note as text, never as markup", async () => {
    const hostile = '<img src=x onerror="window.__pwned=1">';
    const { doc, w } = await boot({
      lists: [list(3, hostile, [1], `<b>bold</b>${hostile}`)],
      page: "lists",
      sidebarOpen: true,
    });
    (doc.querySelector(".assistant-list-item") as HTMLElement).click();
    await tick();
    (doc.querySelector(".assistant-list-info") as HTMLElement).click();
    expect(doc.querySelector("img[src=x]")).toBeNull();
    expect(doc.querySelector("b")).toBeNull();
    expect(doc.getElementById("content-title")!.textContent).toBe(`List: ${hostile}`);
    expect(doc.querySelector(".list-info-note")!.textContent).toBe(`<b>bold</b>${hostile}`);
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
    expect(doc.querySelector('.sort-opt[data-sort-order="list"]')!.hasAttribute("hidden")).toBe(true);
  });

  it("deletes the open list with Undo, and only the ids it hid", async () => {
    const { doc, calls, stream, addList } = await boot({ lists: [list(5, "Doomed", [1])] });
    (doc.querySelector(".assistant-list-item") as HTMLElement).click();
    await tick();
    (doc.querySelector('.assistant-list-bin[data-list-id="5"]') as HTMLElement).click();
    expect(rows(doc)).toEqual([]);
    expect(listsState(doc)).toContain("No lists yet");
    expect(doc.getElementById("content-title")!.textContent).toBe("Select a category");
    toastAction(doc, "Undo")!.click();
    await tick(80);
    expect(rows(doc)).toEqual(["Doomed"]);
    expect(doc.getElementById("content-title")!.textContent).toBe("List: Doomed");
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
    expect(doc.getElementById("content-title")!.textContent).toBe("List: Kept");
    expect(visibleIds(doc)).toEqual(["2", "3"]);

    const gone = await boot({ lists: [], openList: 99 });
    expect(gone.doc.getElementById("content-title")!.textContent).not.toBe("List: Kept");
    expect(gone.w.localStorage.getItem("xbo:assistant-list")).toBeNull();
  });

  it("deletes one list from its own bin, with Undo, without opening it", async () => {
    const { doc, calls } = await boot({ lists: [list(1, "Keep", [1]), list(2, "Drop", [2])] });
    const bin = doc.querySelector('.assistant-list-bin[data-list-id="2"]') as HTMLElement;
    expect(bin.getAttribute("aria-label")).toBe("Delete list Drop");
    expect(bin.title).toBe("Delete list Drop");
    expect(unviewed(doc)).toBe("2");
    bin.click();
    await tick(5);
    expect(rows(doc)).toEqual(["Keep"]);
    expect(unviewed(doc)).toBe("1");
    expect(doc.getElementById("sidebar-home-meta-lists")!.textContent).toBe("1 list");
    expect(calls.some((c) => c.url.startsWith("/api/assistant-lists/2?"))).toBe(false); // never opened
    toastAction(doc, "Undo")!.click();
    await tick(80);
    expect(rows(doc)).toEqual(["Drop", "Keep"]);
    expect(unviewed(doc)).toBe("2");
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    (doc.querySelector('.assistant-list-bin[data-list-id="1"]') as HTMLElement).click();
    await tick(120);
    const del = calls.find((c) => c.method === "DELETE")!;
    expect(JSON.parse(del.body!).ids).toEqual([1]);
    expect(rows(doc)).toEqual(["Drop"]);
  });

  it("an info button tells the note, count and sent time on focus, hover or press - never opening the list", async () => {
    const { doc, w, calls } = await boot({ lists: [list(1, "Evals", [1, 2, 3], "Why these\nthree")], page: "lists", sidebarOpen: true });
    const info = doc.querySelector('.assistant-list-info[data-list-id="1"]') as HTMLElement;
    const popover = doc.getElementById("list-info") as HTMLElement;
    expect(info.getAttribute("aria-label")).toBe("About Evals");
    // The description a screen reader hears on focus says what the popover draws.
    const desc = doc.getElementById(info.getAttribute("aria-describedby")!)!;
    expect(desc.textContent).toMatch(/^Why these\nthree\. 3 posts, 2 unread\. Sent just now · .+\.$/);
    expect(popover.hidden).toBe(true);

    // Keyboard: focus opens it, Escape closes it and keeps focus on the button.
    info.focus();
    expect(popover.hidden).toBe(false);
    expect(popover.querySelector(".list-info-title")!.textContent).toBe("Evals");
    expect(popover.querySelector(".list-info-note")!.textContent).toBe("Why these\nthree");
    const facts = Array.from(popover.querySelectorAll(".list-info-facts span")).map((n) => n.textContent);
    expect(facts[0]).toBe("3 posts, 2 unread");
    expect(facts[1]).toMatch(/^Sent just now · /);
    key(w, info, "Escape");
    expect(popover.hidden).toBe(true);
    expect(doc.activeElement).toBe(info);
    expect(page(doc)).toBe("lists"); // the Escape was the popover's, not the sidebar's

    // Hover (a mouse) opens and leaving closes; a press pins it open.
    info.blur();
    info.dispatchEvent(new w.Event("pointerenter"));
    Object.defineProperty(w.Event.prototype, "pointerType", { configurable: true, get: () => "mouse" });
    info.dispatchEvent(new w.Event("pointerenter"));
    expect(popover.hidden).toBe(false);
    info.dispatchEvent(new w.Event("pointerleave"));
    expect(popover.hidden).toBe(true);
    info.click();
    info.dispatchEvent(new w.Event("pointerleave"));
    expect(popover.hidden).toBe(false);
    delete w.Event.prototype.pointerType;
    info.click();
    expect(popover.hidden).toBe(true);
    // Never for a row off screen: a closed sidebar drops it, and a press there opens nothing.
    info.click();
    expect(popover.hidden).toBe(false);
    (doc.getElementById("sidebar-toggle") as HTMLElement).click();
    expect(popover.hidden).toBe(true);
    info.click();
    expect(popover.hidden).toBe(true);
    // Neither the info button nor the bin opens the list.
    expect(calls.some((c) => c.url.startsWith("/api/assistant-lists/1?"))).toBe(false);
    expect(doc.getElementById("content-title")!.textContent).not.toContain("List:");
  });

  it("drops the list view's header: no note, no count line, no Delete list button", async () => {
    const { doc } = await boot({ lists: [list(1, "Evals", [1, 2], "A note")] });
    (doc.querySelector(".assistant-list-item") as HTMLElement).click();
    await tick();
    expect(doc.getElementById("assistant-list-header")).toBeNull();
    expect(doc.getElementById("assistant-list-delete")).toBeNull();
    const pane = doc.querySelector(".content")!.textContent!;
    expect(pane).not.toContain("A note");
    expect(pane).not.toContain("Delete list");
    expect(pane).not.toMatch(/2 posts/);
    // And the row itself carries no "N posts · time" line.
    expect(doc.querySelector(".assistant-list-meta")).toBeNull();
  });

  it("shows the category tree's total and unread badges, and follows a read toggle made in a category", async () => {
    const { doc, stream } = await boot({ lists: [list(1, "Evals", [1, 2, 3])] });
    const row = () => doc.querySelector('.assistant-list-item[data-list-id="1"]') as HTMLElement;
    expect(row().querySelector(".tree-counts .count-total")!.textContent).toBe("3");
    expect(row().querySelector(".tree-counts .badge-unread")!.textContent).toBe("2");
    expect(row().getAttribute("aria-label")).toBe("Evals, 3 posts, 2 unread, new");

    // Read a post from its CATEGORY; the server tells every tab the index moved.
    (doc.querySelector(".tree-node") as HTMLElement).click();
    await tick();
    const card = doc.querySelector('.bookmark-card[data-bookmark-id="1"]') as HTMLElement;
    (card.querySelector(".read-pill") as HTMLElement).click();
    await tick(80);
    stream().emit("changed");
    await tick();
    expect(row().querySelector(".badge-unread")!.textContent).toBe("1");

    // And from the list view, the other way round.
    row().click();
    await tick();
    const inList = doc.querySelector('.bookmark-card[data-bookmark-id="3"]') as HTMLElement;
    (inList.querySelector(".read-pill") as HTMLElement).click();
    await tick(80);
    stream().emit("changed");
    await tick();
    expect(row().querySelector(".badge-unread")).toBeNull(); // nothing unread: no badge, like the tree
    expect(row().querySelector(".count-total")!.textContent).toBe("3");
  });

  it("orders a list with the category sort chip, defaulting to the assistant's order, remembered apart", async () => {
    const { doc, w, calls } = await boot({ lists: [list(1, "Evals", [2, 3, 1])] });
    (doc.querySelector(".assistant-list-item") as HTMLElement).click();
    await tick();
    const opt = (v: string) => doc.querySelector(`.sort-opt-input[value="${v}"]`) as HTMLInputElement;
    expect(opt("list").parentElement!.hasAttribute("hidden")).toBe(false);
    expect(opt("list").checked).toBe(true);
    expect(doc.getElementById("sort-direction-label")!.textContent).toBe("As sent");
    expect(visibleIds(doc)).toEqual(["2", "3", "1"]);

    opt("recent").checked = true;
    opt("recent").dispatchEvent(new w.Event("change"));
    await tick();
    expect(calls.at(-1)!.url).toBe("/api/assistant-lists/1?sort=recent&dir=desc");
    expect(visibleIds(doc)).toEqual(["3", "2", "1"]);
    (doc.getElementById("sort-direction") as HTMLElement).click();
    await tick();
    expect(calls.at(-1)!.url).toBe("/api/assistant-lists/1?sort=recent&dir=asc");
    expect(visibleIds(doc)).toEqual(["1", "2", "3"]);
    expect(w.localStorage.getItem("xbo:list-sort-order")).toBe("recent");
    expect(w.localStorage.getItem("xbo:list-sort-direction")).toBe("asc");
    // Top score stays disabled with nothing ranked, as it is for a category.
    expect(opt("score").disabled).toBe(true);

    // A category keeps its own ordering, and has no "Assistant's order".
    (doc.querySelector(".tree-node") as HTMLElement).click();
    await tick();
    expect(opt("list").parentElement!.hasAttribute("hidden")).toBe(true);
    expect(opt("recent").checked).toBe(true);
    expect(doc.getElementById("sort-direction-label")!.textContent).toBe("Newest first");
    expect(w.localStorage.getItem("xbo:sort-order")).toBeNull();
  });

  it("leaves a list deleted in another tab when the stream says the index changed", async () => {
    const { doc, stream, dropList } = await boot({ lists: [list(9, "Elsewhere", [1])] });
    (doc.querySelector(".assistant-list-item") as HTMLElement).click();
    await tick();
    dropList(9);
    stream().emit("changed");
    await tick();
    expect(rows(doc)).toEqual([]);
    expect(doc.getElementById("content-title")!.textContent).toBe("Select a category");
    expect(visibleIds(doc)).toEqual([]);
  });
});

describe("Sidebar drill-down (menu, Categories, Lists)", () => {
  it("opens on the menu, slides into a page on its heading, and Back returns to the row", async () => {
    const { doc, w } = await boot({ sidebarOpen: true });
    expect(page(doc)).toBe("root");
    expect(view(doc, "root").hidden).toBe(false);
    expect(view(doc, "categories").hidden).toBe(true);
    expect(view(doc, "lists").hidden).toBe(true);
    // The rows summarise their pages.
    expect(doc.getElementById("sidebar-home-meta-categories")!.textContent).toBe("1 category");

    homeRow(doc, "categories").click();
    expect(page(doc)).toBe("categories");
    expect(view(doc, "root").hidden).toBe(true);
    expect(view(doc, "categories").hidden).toBe(false);
    expect(view(doc, "categories").getAttribute("data-enter")).toBe("forward");
    expect(doc.activeElement!.id).toBe("sidebar-title-categories");
    expect(w.localStorage.getItem("xbo:sidebar-page")).toBe("categories");

    (view(doc, "categories").querySelector("[data-sidebar-back]") as HTMLElement).click();
    expect(page(doc)).toBe("root");
    expect(view(doc, "root").getAttribute("data-enter")).toBe("back");
    expect(doc.activeElement).toBe(homeRow(doc, "categories"));
    expect(w.localStorage.getItem("xbo:sidebar-page")).toBe("root");

    homeRow(doc, "lists").click();
    expect(page(doc)).toBe("lists");
    expect(doc.activeElement!.id).toBe("sidebar-title-lists");
    (view(doc, "lists").querySelector("[data-sidebar-back]") as HTMLElement).click();
    expect(doc.activeElement).toBe(homeRow(doc, "lists"));
  });

  it("keeps every drag, expand and count control of the tree on the Categories page", async () => {
    const { doc } = await boot({ sidebarOpen: true, page: "categories" });
    const cats = view(doc, "categories");
    for (const sel of ["#tree", "#category-search", "#cat-editor-open", "#color-toggle", ".tree-node", ".tree-grip"]) {
      expect(cats.querySelector(sel), sel).not.toBeNull();
    }
    expect(cats.querySelector(".tree-counts")!.textContent).toContain("3");
  });

  it("Escape goes back one level while focus is in the sidebar, then closes it", async () => {
    const { doc, w } = await boot({ sidebarOpen: true });
    homeRow(doc, "lists").click();
    key(w, doc.activeElement!, "Escape");
    expect(page(doc)).toBe("root");
    expect(doc.activeElement).toBe(homeRow(doc, "lists"));
    expect(doc.body.getAttribute("data-sidebar")).toBeNull(); // still open
    key(w, doc.activeElement!, "Escape");
    expect(doc.body.getAttribute("data-sidebar")).toBe("collapsed");
  });

  it("Escape from outside the sidebar closes it without leaving the page", async () => {
    const { doc, w } = await boot({ sidebarOpen: true, page: "categories" });
    (doc.getElementById("sidebar-toggle") as HTMLElement).focus();
    key(w, doc.activeElement!, "Escape");
    expect(doc.body.getAttribute("data-sidebar")).toBe("collapsed");
    expect(page(doc)).toBe("categories");
  });

  it("an Escape that clears the category filter does not also go back", async () => {
    const { doc, w } = await boot({ sidebarOpen: true, page: "categories" });
    const search = doc.getElementById("category-search") as HTMLInputElement;
    search.focus();
    search.value = "Ca";
    search.dispatchEvent(new w.Event("input", { bubbles: true }));
    key(w, search, "Escape");
    expect(search.value).toBe("");
    expect(page(doc)).toBe("categories");
    key(w, search, "Escape");
    expect(page(doc)).toBe("root");
  });

  it("restores the page open before a reload, and falls back to the menu for anything else", async () => {
    const lists = await boot({ page: "lists" });
    expect(page(lists.doc)).toBe("lists");
    expect(view(lists.doc, "lists").hidden).toBe(false);
    expect(view(lists.doc, "lists").getAttribute("data-enter")).toBeNull(); // no slide on load
    const junk = await boot({ page: "settings" });
    expect(page(junk.doc)).toBe("root");
  });

  it("focuses where the owner is on the open page when the sidebar opens", async () => {
    const { doc } = await boot({ page: "lists", lists: [list(1, "A", [1]), list(2, "B", [2])] });
    (doc.getElementById("sidebar-toggle") as HTMLElement).click();
    expect((doc.activeElement as HTMLElement).classList.contains("assistant-list-item")).toBe(true);
  });

  it("the Select-a-category prompt and the top-bar search go to the Categories page", async () => {
    const { doc } = await boot({ page: "lists" });
    (doc.querySelector("#content-title [data-open-categories]") as HTMLElement).click();
    expect(page(doc)).toBe("categories");
    homeRow(doc, "lists").click(); // back on another page…
    (view(doc, "categories").querySelector("[data-sidebar-back]") as HTMLElement).click();
    homeRow(doc, "lists").click();
    (doc.getElementById("search-open") as HTMLElement).click();
    expect(page(doc)).toBe("categories");
    expect(doc.activeElement!.id).toBe("category-search");
  });

  it("counts lists never opened, from the server, so a reload agrees", async () => {
    const { doc } = await boot({
      lists: [list(1, "Seen", [1], null, true), list(2, "Fresh", [2]), list(3, "Also fresh", [3])],
    });
    expect(unviewed(doc)).toBe("2");
    expect(homeRow(doc, "lists").getAttribute("aria-label")).toBe("Lists, 3 lists, 2 new");
    expect(rows(doc)).toContain("Seen");
    expect(doc.querySelectorAll(".assistant-list-new")).toHaveLength(2);
    // Categories' Back carries the same count, so it is never out of sight.
    const catBack = view(doc, "categories").querySelector("[data-sidebar-back]")!;
    expect(catBack.getAttribute("aria-label")).toBe("Back to the menu, 2 new lists");
    expect((catBack.querySelector("[data-unviewed-badge]") as HTMLElement).hidden).toBe(false);
  });

  it("a live arrival adds one, opening clears one, delete and Clear all drop them", async () => {
    const { doc, stream, addList, calls } = await boot({ lists: [list(1, "Old", [1], null, true)] });
    expect(unviewed(doc)).toBeNull();
    stream().emit("created", addList(list(2, "First", [2])));
    stream().emit("created", addList(list(3, "Second", [3])));
    await tick();
    expect(unviewed(doc)).toBe("2");

    (doc.querySelector('.assistant-list-item[data-list-id="2"]') as HTMLElement).click();
    expect(unviewed(doc)).toBe("1"); // at once, not after the round trip
    await tick();
    expect(unviewed(doc)).toBe("1");
    expect(calls.filter((c) => c.url === "/api/assistant-lists/2/viewed")).toHaveLength(1);
    // A second open of a viewed list writes nothing.
    (doc.querySelector('.assistant-list-item[data-list-id="1"]') as HTMLElement).click();
    await tick();
    (doc.querySelector('.assistant-list-item[data-list-id="2"]') as HTMLElement).click();
    await tick();
    expect(calls.filter((c) => c.url.endsWith("/viewed"))).toHaveLength(1);

    // Deleting the unviewed one drops the count while its Undo waits.
    (doc.querySelector('.assistant-list-item[data-list-id="3"]') as HTMLElement).click();
    await tick();
    expect(unviewed(doc)).toBeNull(); // opened, so viewed
    stream().emit("created", addList(list(4, "Third", [1])));
    await tick();
    expect(unviewed(doc)).toBe("1");
    (doc.getElementById("assistant-lists-clear") as HTMLElement).click();
    expect(unviewed(doc)).toBeNull();
    expect(rows(doc)).toEqual([]);
    toastAction(doc, "Undo")!.click();
    await tick();
    expect(unviewed(doc)).toBe("1");
    (doc.getElementById("assistant-lists-clear") as HTMLElement).click();
    await tick(120);
    expect(unviewed(doc)).toBeNull();
    expect(listsState(doc)).toContain("No lists yet");
  });

  it("a list viewed in another tab stops counting when the stream says the index changed", async () => {
    const { doc, stream, viewElsewhere } = await boot({ lists: [list(5, "Elsewhere", [1])] });
    expect(unviewed(doc)).toBe("1");
    viewElsewhere(5);
    stream().emit("changed");
    await tick();
    expect(unviewed(doc)).toBeNull();
    expect(doc.querySelector(".assistant-list-new")).toBeNull();
  });

  it("a card drag borrows the Categories page for its drop target, then gives the page back", async () => {
    const { doc, w } = await boot({ lists: [list(6, "Mine", [1, 2])], page: "lists", sidebarOpen: true });
    (doc.querySelector(".assistant-list-item") as HTMLElement).click();
    await tick();
    const grip = doc.querySelector('.bookmark-card[data-bookmark-id="1"] .card-grip') as HTMLElement;
    grip.setPointerCapture = () => {};
    grip.releasePointerCapture = () => {};
    const pointer = (type: string, x: number) =>
      grip.dispatchEvent(new w.MouseEvent(type, { bubbles: true, clientX: x, clientY: 10 }));
    pointer("pointerdown", 10);
    pointer("pointermove", 80);
    expect(page(doc)).toBe("categories");
    pointer("pointerup", 80);
    expect(page(doc)).toBe("lists");
    expect(w.localStorage.getItem("xbo:sidebar-page")).toBe("lists");
  });

  it("says so when the lists cannot be read, with a way to try again", async () => {
    const { doc } = await boot({ failLists: 1, lists: [list(1, "Waiting", [1])] });
    expect(listsState(doc)).toContain("Couldn't load your lists.");
    expect(rows(doc)).toEqual([]);
    const retry = Array.from(doc.querySelectorAll("#assistant-lists-state button")).find(
      (b) => b.textContent === "Try again",
    ) as HTMLElement;
    retry.click();
    expect(listsState(doc)).toContain("Loading lists…");
    await tick();
    expect(rows(doc)).toEqual(["Waiting"]);
    expect(listsState(doc)).toBe("");
  });
});
