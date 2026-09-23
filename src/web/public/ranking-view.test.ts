import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";

/**
 * Drives the REAL app.js + index.html in jsdom to pin issue #98's three
 * promises, none of which is visible from the pure modules alone:
 *
 *   1. A ranking run's progress lands in the ONE shared strip under the filter
 *      tabs - the same element a sync paints - and not in the rank popover,
 *      which no longer has a strip at all.
 *   2. The icon's blue dot and the panel's count are DERIVED from `/api/setup`
 *      `ranking:{scored,total}`, so a sync that adds unranked bookmarks raises
 *      them and a finished run clears them, with nothing else to keep in step.
 *   3. An unranked card's empty badge ranks that ONE post, through the same
 *      paid confirmation - and when ranking is blocked it spends nothing and
 *      sends the owner to the panel that explains why.
 *
 * Offline end to end: `fetch` is a fixture, so nothing here can reach
 * `api.typesafe.ai` and nothing can be billed.
 */

const dir = __dirname;
const read = (f: string) => readFileSync(join(dir, f), "utf8");

const bm = (id: number, score: unknown = null) => ({
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
  score,
});

const SCORE = { value: 0.82, confidence: 0.7, dimensions: { depth: 0.8 } };

interface RankingState {
  scored: number;
  total: number;
  available: boolean;
  blocker: string | null;
  pending: number;
  status: unknown;
  reason?: string;
}

interface Posted {
  url: string;
  body: unknown;
}

async function boot(opts: { ranking?: Partial<RankingState> } = {}) {
  const DATA = [bm(1, SCORE), bm(2), bm(3)];
  const posted: Posted[] = [];
  let sync: Record<string, unknown> = { available: true, lastSyncedAt: null, status: null };
  let ranking: RankingState = {
    scored: 1,
    total: 3,
    available: true,
    blocker: null,
    pending: 2,
    status: null,
    ...opts.ranking,
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
  // No widgets.js: every card falls back to the text+link embed, which is all
  // this test needs - it is about the action row, not the post.
  w.fetch = async (url: string, init?: { method?: string; body?: string }) => {
    const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    if (init && init.method === "POST") {
      posted.push({ url, body: init.body ? JSON.parse(init.body) : null });
      if (url === "/api/sync") {
        sync = { ...sync, status: { state: "running", startedAt: "2026-01-01T00:00:00Z", messages: [] } };
        return { ok: true, status: 202, json: async () => ({ status: sync.status }) };
      }
      if (url === "/api/rank") {
        ranking = { ...ranking, status: { state: "running", startedAt: "2026-01-01T00:00:01Z", messages: [] } };
        return { ok: true, status: 202, json: async () => ({ status: ranking.status }) };
      }
      if (/\/rank$/.test(url)) {
        const id = Number(url.match(/bookmarks\/(\d+)\/rank/)![1]);
        DATA.find((b) => b.id === id)!.score = SCORE;
        ranking = { ...ranking, scored: ranking.scored + 1, pending: ranking.pending - 1 };
        return json({
          score: SCORE,
          summary: { candidates: 1, scored: 1, skipped: 0, failed: 0, inputTokens: 120 },
          messages: ["Ranking pass: TypeSafe Jev (jev-1) - pay-per-token.", "Ranking done. 1 scored."],
          ranking,
        });
      }
      return json({});
    }
    if (url.startsWith("/api/tree")) {
      return json({
        tree: [
          { id: 1, parentId: null, name: "Cat", path: ["Cat"], total: 3, unread: 3, directTotal: 3, children: [] },
        ],
      });
    }
    if (url.startsWith("/api/rank")) return json({ ranking });
    if (url.startsWith("/api/sync")) return json({ ...sync, status: (sync as any).status });
    if (url.startsWith("/api/setup")) {
      return json({
        bookmarkCount: 3,
        configured: true,
        settings: { categorizer: "claude-cli", provider: "claude-cli" },
        catalog: { methods: [], providers: [] },
        credentials: {
          xClientId: { present: true },
          xClientSecret: { present: true },
          typesafeApiKey: { present: true },
        },
        x: { connected: true, canConnect: true, login: { state: "idle", error: null } },
        sync,
        ranking,
      });
    }
    const m = url.match(/^\/api\/categories\/1\/bookmarks/);
    if (m) {
      return json({
        bookmarks: DATA,
        offset: 0,
        hasMore: false,
        counts: { total: 3, unread: 3, favorite: 0 },
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
    "sort-order.js",
    "categorization.js",
    "ranking.js",
  ]) {
    w.eval(read(f));
  }
  w.eval(read("app.js"));
  await tick();
  const doc = w.document as Document;
  (doc.querySelector(".tree-node") as HTMLElement).click();
  await tick();

  return {
    w,
    doc,
    posted,
    /** Move the server's answer on, the way a poll would see it. */
    setRanking: (over: Partial<RankingState>) => {
      ranking = { ...ranking, ...over };
    },
    setSync: (over: Record<string, unknown>) => {
      sync = { ...sync, ...over };
    },
    strip: () => doc.getElementById("sync-progress") as HTMLElement,
    dot: () => doc.getElementById("rank-dot") as HTMLElement,
    coverage: () => (doc.getElementById("rank-coverage") as HTMLElement).textContent,
    card: (id: number) => doc.querySelector(`.bookmark-card[data-bookmark-id="${id}"]`) as HTMLElement,
  };
}

const tick = () => new Promise((r) => setTimeout(r, 120));
/**
 * Long enough for one of app.js's own poll intervals to fire (sync 1200ms,
 * rank 1500ms). The polls are what a real run's progress arrives on, so the
 * tests wait for them rather than reaching inside and calling the tick.
 */
const poll = () => new Promise((r) => setTimeout(r, 1700));

describe("the shared progress strip (issue #98)", () => {
  it("has no strip inside the ranking popover at all - there is only one", async () => {
    const { doc } = await boot();
    expect(doc.getElementById("rank-progress")).toBeNull();
    expect(doc.querySelector("#rank-panel .sync-progress")).toBeNull();
    expect(doc.getElementById("sync-progress")).not.toBeNull();
  });

  it("paints a ranking run into the SAME strip a sync uses", async () => {
    const { doc, strip, setRanking, posted } = await boot();
    expect(strip().hidden).toBe(true);

    (doc.getElementById("rank-open") as HTMLElement).click();
    expect((doc.getElementById("rank-modal") as HTMLElement).hidden).toBe(false);
    // The paid gate: the run only ever starts from the confirmation.
    (doc.getElementById("rank-confirm") as HTMLElement).click();
    await tick();

    expect(posted).toContainEqual({ url: "/api/rank", body: { confirm: true } });
    expect(strip().hidden).toBe(false);
    expect(strip().getAttribute("data-state")).toBe("running");

    // The run's own log lines - the billing line first - reach that strip.
    setRanking({
      status: {
        state: "running",
        startedAt: "2026-01-01T00:00:01Z",
        messages: ["Ranking pass: TypeSafe Jev (jev-1) - pay-per-token."],
      },
    });
    await poll();
    expect((doc.getElementById("sync-progress-text") as HTMLElement).textContent).toContain("pay-per-token");
    expect((doc.getElementById("sync-progress-log") as HTMLElement).textContent).toContain("pay-per-token");
    expect((doc.getElementById("sync-progress-dismiss") as HTMLElement).getAttribute("aria-label")).toBe(
      "Dismiss ranking status",
    );
  });
});

describe("the unranked dot and count (issue #98)", () => {
  it("derives both from the setup counts", async () => {
    const { dot, coverage } = await boot();
    expect(dot().hidden).toBe(false);
    expect(coverage()).toBe("2 of 3 bookmarks unranked.");
  });

  it("clears once a run has finished ranking everything", async () => {
    const { dot, coverage, setRanking, doc } = await boot();
    (doc.getElementById("rank-open") as HTMLElement).click();
    (doc.getElementById("rank-confirm") as HTMLElement).click();
    await tick();

    setRanking({
      scored: 3,
      pending: 0,
      status: {
        state: "done",
        startedAt: "2026-01-01T00:00:01Z",
        messages: [],
        summary: { candidates: 2, scored: 2, skipped: 0, failed: 0, inputTokens: 300 },
      },
    });
    await poll();

    expect(dot().hidden).toBe(true);
    expect(coverage()).toBe("All 3 bookmarks are ranked.");
  });

  it("comes BACK after a sync adds unranked bookmarks", async () => {
    // The whole point of the notification: an incremental sync stores posts
    // nothing has judged yet, and the icon is how the owner learns that.
    const { dot, coverage, setRanking, setSync, doc } = await boot({
      ranking: { scored: 3, total: 3, pending: 0 },
    });
    expect(dot().hidden).toBe(true);

    (doc.getElementById("sync-btn") as HTMLElement).click();
    await tick();
    setRanking({ scored: 3, total: 7, pending: 4 });
    setSync({
      status: {
        state: "done",
        startedAt: "2026-01-01T00:00:00Z",
        messages: [],
        summary: { newBookmarks: 4, batches: 1, nodesCreated: 0 },
      },
    });
    await poll();

    expect(dot().hidden).toBe(false);
    expect(coverage()).toBe("4 of 7 bookmarks unranked.");
  });

  it("shows no dot when the viewer has no ranking wiring at all", async () => {
    const { dot } = await boot({
      ranking: { available: false, reason: "Ranking is not available in this viewer.", pending: 0 },
    });
    expect(dot().hidden).toBe(true);
  });
});

describe("the per-post empty badge (issue #98)", () => {
  it("marks an unranked card apart from a scored one - never as a zero", async () => {
    const { card } = await boot();
    const scored = card(1).querySelector(".score-chip") as HTMLElement;
    const empty = card(2).querySelector(".score-chip") as HTMLElement;

    expect(scored.classList.contains("is-empty")).toBe(false);
    expect(empty.classList.contains("is-empty")).toBe(true);
    expect(empty.textContent).not.toMatch(/0/);
    expect(empty.getAttribute("aria-label")).toMatch(/not ranked yet/i);
  });

  it("ranks that ONE post through the same confirmation, and fills its chip in", async () => {
    const { doc, card, posted, dot, coverage, strip } = await boot();
    (card(2).querySelector(".score-chip") as HTMLElement).click();

    const modal = doc.getElementById("rank-modal") as HTMLElement;
    expect(modal.hidden).toBe(false);
    expect((doc.getElementById("rank-modal-cost-text") as HTMLElement).textContent).toMatch(/paid run/i);
    expect((doc.getElementById("rank-confirm") as HTMLElement).textContent).toBe("Rank this bookmark");
    // Nothing is spent by opening it.
    expect(posted).toHaveLength(0);

    (doc.getElementById("rank-confirm") as HTMLElement).click();
    await tick();

    expect(posted).toEqual([{ url: "/api/bookmarks/2/rank", body: { confirm: true } }]);
    // The chip is patched IN PLACE: scored now, and the card is the same one.
    const chip = card(2).querySelector(".score-chip") as HTMLElement;
    expect(chip.classList.contains("is-empty")).toBe(false);
    expect(chip.textContent).toContain("8");
    // ...and the notification follows the new counts.
    expect(coverage()).toBe("1 of 3 bookmarks unranked.");
    expect(dot().hidden).toBe(false);
    // The one-post run reports into the shared strip too, billing line and all.
    expect(strip().hidden).toBe(false);
    expect((doc.getElementById("sync-progress-log") as HTMLElement).textContent).toContain("pay-per-token");
  });

  it("spends nothing when ranking is blocked - it opens the panel that says why", async () => {
    const { doc, card, posted } = await boot({
      ranking: { blocker: "TypeSafe API key missing - add your key to enable ranking." },
    });
    (card(2).querySelector(".score-chip") as HTMLElement).click();
    await tick();

    expect(posted).toHaveLength(0);
    expect((doc.getElementById("rank-modal") as HTMLElement).hidden).toBe(true);
    expect((doc.getElementById("rank-panel") as HTMLElement).hidden).toBe(false);
    expect((doc.getElementById("rank-blocker-headline") as HTMLElement).textContent).toMatch(/key missing/i);
    expect((doc.getElementById("rank-open") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("ranking panel layout: rule selector first (owner feedback after #119)", () => {
  it("renders the active-rule picker as the panel's first content, above Rank now", () => {
    const dom = new JSDOM(read("index.html"));
    const doc = dom.window.document;
    const panel = doc.getElementById("rank-panel") as HTMLElement;
    const children = Array.from(panel.children);
    const titleIndex = children.findIndex((c) => c.id === "rank-panel-title");
    const rulesIndex = children.findIndex((c) => c.classList.contains("rank-rules"));
    const rankOpenIndex = children.findIndex((c) => c.contains(doc.getElementById("rank-open")));
    const coverageIndex = children.findIndex((c) => c.id === "rank-coverage");
    const blockerIndex = children.findIndex((c) => c.id === "rank-blocker");

    expect(rulesIndex).toBeGreaterThan(-1);
    // Only the panel's own heading may precede the rule selector - it is the
    // first FUNCTIONAL content, above "Rank now", the coverage line and the
    // blocker, matching the DOM order Tab traverses.
    expect(rulesIndex).toBe(titleIndex + 1);
    expect(rulesIndex).toBeLessThan(rankOpenIndex);
    expect(rulesIndex).toBeLessThan(coverageIndex);
    expect(rulesIndex).toBeLessThan(blockerIndex);

    const picker = panel.querySelector(".rank-rules #rank-rules-input");
    expect(picker).not.toBeNull();
  });
});
