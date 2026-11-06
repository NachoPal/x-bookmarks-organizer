import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";

/**
 * Drives the REAL app.js + index.html in jsdom for "Refresh from X" and the
 * summary modal's "Text in image":
 *
 *   1. Both scopes sit in the Sync panel with their estimated cost, and a
 *      press only OPENS a confirmation that names the price first - the one
 *      place `{ scope, confirm: true }` is sent.
 *   2. The run lands in the ONE shared strip, which stays "running" while the
 *      background OCR that follows it reads the images, then states the outcome.
 *   3. A server refusal keeps the dialog open with the reason; nothing started.
 *   4. The summary modal shows the images' words collapsed, as text.
 *
 * Offline: `fetch` is a fixture, so nothing here can reach X.
 */

const dir = __dirname;
const read = (f: string) => readFileSync(join(dir, f), "utf8");

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
  hasSummary: true,
  score: null,
});

const estimate = (scope: string, posts: number, low: number, high: number) => ({
  scope,
  posts,
  maxPostsRead: posts,
  quoted: 0,
  cost: { low, high },
});

interface Posted {
  url: string;
  body: unknown;
}

async function boot(opts: { refuse?: string } = {}) {
  const posted: Posted[] = [];
  let refresh: Record<string, unknown> = {
    available: true,
    estimates: { newest: estimate("newest", 10, 0.01, 0.025), all: estimate("all", 303, 0.303, 0.803) },
    status: null,
    images: { total: 0, photos: 0, done: 0, withText: 0, pending: 0, failed: 0, unavailable: 0, worker: null },
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
  w.fetch = async (url: string, init?: { method?: string; body?: string }) => {
    const json = (body: unknown, status = 200) => ({ ok: status < 300, status, json: async () => body });
    if (init && init.method === "POST") {
      const body = init.body ? JSON.parse(init.body) : null;
      posted.push({ url, body });
      if (url === "/api/refresh") {
        if (opts.refuse) return json({ error: opts.refuse }, 422);
        refresh = { ...refresh, status: { state: "running", startedAt: "2026-11-01T10:00:00Z", messages: [] } };
        return json({ status: refresh.status }, 202);
      }
      if (/\/summary$/.test(url)) return json({ summary: { summary: "A **summary**.", generatedAt: "2026-11-01T00:00:00Z" } });
      return json({});
    }
    if (url.startsWith("/api/tree")) {
      return json({
        tree: [{ id: 1, parentId: null, name: "Cat", path: ["Cat"], total: 1, unread: 1, directTotal: 1, children: [] }],
      });
    }
    if (url.startsWith("/api/refresh")) return json({ refresh });
    if (/\/api\/bookmarks\/1\/images/.test(url)) {
      return json({
        images: [
          { source: "quoted-post", type: "photo", altText: "A memo", text: "<b>Quarterly</b> zephyrine report", status: "done" },
        ],
      });
    }
    if (url.startsWith("/api/sync")) return json({ available: true, lastSyncedAt: null, status: null });
    if (url.startsWith("/api/setup")) {
      return json({
        bookmarkCount: 1,
        configured: true,
        settings: { categorizer: "claude-cli", provider: "claude-cli" },
        catalog: { methods: [], providers: [] },
        credentials: { xClientId: { present: true }, xClientSecret: { present: true }, typesafeApiKey: { present: true } },
        x: { connected: true, canConnect: true, login: { state: "idle", error: null } },
        sync: { available: true, lastSyncedAt: null, status: null },
        ranking: { scored: 0, total: 1, available: false, blocker: null, pending: 0, status: null },
        refresh,
      });
    }
    if (/^\/api\/categories\/1\/bookmarks/.test(url)) {
      return json({ bookmarks: [bm(1)], offset: 0, hasMore: false, counts: { total: 1, unread: 1, favorite: 0 } });
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
    "sort-order.js",
    "categorization.js",
    "ranking.js",
    "refresh.js",
    "paid-spend.js",
  ]) {
    w.eval(read(f));
  }
  w.eval(read("app.js"));
  await tick();
  const doc = w.document as Document;
  return {
    doc,
    posted,
    setRefresh: (over: Record<string, unknown>) => {
      refresh = { ...refresh, ...over };
    },
    byId: (id: string) => doc.getElementById(id) as HTMLElement,
  };
}

const tick = () => new Promise((r) => setTimeout(r, 120));
const poll = () => new Promise((r) => setTimeout(r, 1700));

describe('"Refresh from X" in the Sync panel', () => {
  it("offers both scopes with their cost, and only the confirmation starts one", async () => {
    const { byId, posted } = await boot();
    expect(byId("refresh-test-btn").textContent!.trim()).toBe("Test: refresh the 10 newest bookmarks");
    expect(byId("refresh-test-cost").textContent).toBe("Reads 10 posts from X · $0.01-$0.03");
    expect(byId("refresh-all-cost").textContent).toBe("Reads 303 posts from X · $0.30-$0.81");
    expect((byId("refresh-all-btn") as HTMLButtonElement).disabled).toBe(false);

    byId("refresh-all-btn").click();
    expect(byId("refresh-confirm-modal").hidden).toBe(false);
    expect(byId("refresh-confirm-title").textContent).toBe("Refresh all 303 bookmarks from X?");
    expect(byId("refresh-confirm-cost-text").textContent).toMatch(/^Estimated \$0\.30-\$0\.81, billed by X/);
    expect(byId("refresh-confirm-ok").textContent).toBe("Refresh 303 bookmarks");
    expect(posted).toEqual([]); // opening the dialog spends nothing

    byId("refresh-confirm-cancel").click();
    expect(byId("refresh-confirm-modal").hidden).toBe(true);
    expect(posted).toEqual([]);
  });

  it("starts the test scope, then keeps the strip running while the images are read", async () => {
    const { byId, posted, setRefresh } = await boot();
    byId("refresh-test-btn").click();
    byId("refresh-confirm-ok").click();
    await tick();
    expect(posted).toContainEqual({ url: "/api/refresh", body: { scope: "newest", confirm: true } });
    expect(byId("refresh-confirm-modal").hidden).toBe(true);
    expect(byId("sync-progress").hidden).toBe(false);
    expect(byId("sync-progress").getAttribute("data-state")).toBe("running");
    expect((byId("refresh-all-btn") as HTMLButtonElement).disabled).toBe(true);

    setRefresh({
      status: {
        state: "done",
        startedAt: "2026-11-01T10:00:00Z",
        finishedAt: "2026-11-01T10:00:03Z",
        summary: { refreshed: 10, imagesFound: 4 },
        messages: ["Billing: X API owned reads, $0.001 per post read"],
      },
      images: {
        total: 4,
        photos: 4,
        done: 1,
        withText: 1,
        pending: 3,
        failed: 0,
        unavailable: 0,
        worker: { state: "running", startedAt: "2026-11-01T10:00:03Z", settled: 1, total: 4 },
      },
    });
    await poll();
    expect(byId("sync-progress").getAttribute("data-state")).toBe("running");
    expect(byId("sync-progress-text").textContent).toBe("Refreshed 10 bookmarks · reading the text in images: 1 of 4…");
    expect(byId("refresh-images").textContent).toBe("Reading the text in images: 1 of 4…");
    expect(byId("sync-progress-dismiss").getAttribute("aria-label")).toBe("Dismiss refresh status");

    setRefresh({
      images: {
        total: 4,
        photos: 4,
        done: 4,
        withText: 3,
        pending: 0,
        failed: 0,
        unavailable: 0,
        worker: {
          state: "done",
          startedAt: "2026-11-01T10:00:03Z",
          finishedAt: "2026-11-01T10:00:06Z",
          settled: 4,
          total: 4,
          last: { read: 4 },
        },
      },
    });
    await poll();
    expect(byId("sync-progress").getAttribute("data-state")).toBe("done");
    expect(byId("sync-progress-text").textContent).toBe("Refreshed 10 bookmarks · 4 images found · text read from 4 images.");
    expect(byId("refresh-images").textContent).toBe("Text read from 4 of 4 images (3 with text).");
  });

  it("keeps the dialog open with the server's reason when it refuses", async () => {
    const { byId } = await boot({ refuse: "Not connected to X yet." });
    byId("refresh-test-btn").click();
    byId("refresh-confirm-ok").click();
    await tick();
    expect(byId("refresh-confirm-modal").hidden).toBe(false);
    expect(byId("refresh-confirm-error").hidden).toBe(false);
    expect(byId("refresh-confirm-error").textContent).toBe("Not connected to X yet.");
    expect(byId("sync-progress").hidden).toBe(true);
  });
});

describe('the summary modal\'s "Text in image"', () => {
  it("shows the image's words collapsed, as text - never as markup", async () => {
    const { doc, byId } = await boot();
    (doc.querySelector(".tree-node") as HTMLElement).click();
    await tick();
    (doc.querySelector(".summarize-link") as HTMLElement).click();
    await tick();
    const panel = byId("summary-images");
    expect(panel.hidden).toBe(false);
    const details = panel.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")!.textContent).toBe("Text in image");
    expect(panel.querySelector(".summary-image-label")!.textContent).toBe("Image 1 in the quoted post");
    expect(panel.querySelector(".summary-image-alt")!.textContent).toBe("Alt text: A memo");
    expect(panel.querySelector(".summary-image-text")!.textContent).toBe("<b>Quarterly</b> zephyrine report");
    expect(panel.querySelector("b")).toBeNull();
  });
});
