import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";

// Drives the REAL app.js + index.html in jsdom with a stubbed fetch, to pin
// the issue #33 behavior: a cached category+filter view is re-shown from its
// still-mounted pane (no re-fetch, same DOM nodes), and a real load shows the
// spinner placeholder instead of an empty pane.

const dir = __dirname;
const read = (f: string) => readFileSync(join(dir, f), "utf8");

const bm = (id: number, isRead: boolean) => ({
  id,
  postId: `p${id}`,
  text: `post ${id}`,
  read: isRead,
  readAt: null,
  categoryIds: [1],
  url: `https://x.com/i/status/${id}`,
  authorName: "a",
  authorUsername: "a",
  createdAt: "2024-01-01T00:00:00Z",
});
const DATA = [bm(1, false), bm(2, true), bm(3, false)];

async function boot() {
  const calls: string[] = [];
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
    if (/\/read$/.test(url)) return json({ bookmark: { read: true, readAt: "2024-01-02T00:00:00Z" } });
    const m = url.match(/^\/api\/categories\/1\/bookmarks\?filter=(\w+)/);
    if (m) {
      if (release === null && (w as any).__hold) await new Promise<void>((r) => (release = r));
      const f = m[1];
      const rows = DATA.filter((b) => f === "all" || (f === "unread" ? !b.read : b.read));
      return json({ bookmarks: rows, offset: 0, hasMore: false, counts: { total: 3, unread: 2 } });
    }
    return json({});
  };
  for (const f of ["tree-counts.js", "read-toggle.js", "filter-cache.js", "theme.js", "text-size.js", "sidebar-state.js", "tree-color.js", "app.js"]) {
    w.eval(read(f));
  }
  await new Promise((r) => setTimeout(r, 50));
  const doc = w.document as Document;
  const radio = (v: string) => doc.querySelector(`.seg-input[value=${v}]`) as HTMLInputElement;
  const change = (v: string) => {
    radio(v).checked = true;
    radio(v).dispatchEvent(new w.Event("change"));
  };
  return { w, calls, doc, change, hold: (v: boolean) => ((w as any).__hold = v), release: () => release?.() };
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
