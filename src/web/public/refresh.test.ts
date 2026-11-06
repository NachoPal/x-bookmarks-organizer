import { describe, expect, it } from "vitest";

/**
 * The pure half of "Refresh from X" and the image-text UI, exercised in Node
 * like `ranking.test.ts`: every rule about what a PAID refresh says before it
 * is authorized, and how its progress reads, is testable without a DOM.
 */
// Plain browser JS, required directly (not compiled by tsc).
const refresh = require("./refresh.js") as any;
const ranking = require("./ranking.js") as {
  progressSource: (sync: unknown, rank: unknown, find?: unknown, refresh?: unknown) => string | null;
};

const estimate = (scope: string, posts: number, low: number, high: number) => ({
  scope,
  posts,
  maxPostsRead: posts,
  quoted: 0,
  cost: { low, high },
});

const STATE = {
  available: true,
  estimates: { newest: estimate("newest", 10, 0.01, 0.025), all: estimate("all", 303, 0.303, 0.803) },
  status: null,
  images: { total: 40, photos: 36, done: 30, withText: 22, pending: 6, failed: 0, unavailable: 0, worker: null },
};

describe("XBORefresh - what a refresh costs and says", () => {
  it("formats an estimate as a range, a single figure, or under a cent", () => {
    expect(refresh.costText({ low: 0.303, high: 0.803 })).toBe("$0.30-$0.80");
    expect(refresh.costText({ low: 0.01, high: 0.01 })).toBe("about $0.01");
    expect(refresh.costText({ low: 0.002, high: 0.004 })).toBe("under $0.01");
  });

  it("states each scope's reads and cost under its button", () => {
    expect(refresh.scopeLine(STATE, "newest")).toBe("Reads 10 posts from X · $0.01-$0.03");
    expect(refresh.scopeLine(STATE, "all")).toBe("Reads 303 posts from X · $0.30-$0.80");
  });

  it("names the price before the scope in the confirmation", () => {
    const all = STATE.estimates.all;
    expect(refresh.confirmCost(all)).toMatch(/^Estimated \$0\.30-\$0\.80, billed by X\. .*\$0\.001 per post/);
    expect(refresh.confirmTitle("all", all)).toBe("Refresh all 303 bookmarks from X?");
    expect(refresh.confirmTitle("newest", STATE.estimates.newest)).toBe("Refresh the 10 newest bookmarks?");
    expect(refresh.confirmLabel("all", all)).toBe("Refresh 303 bookmarks");
  });

  it("fails closed: nothing reported, unavailable, or an empty library offers no refresh", () => {
    expect(refresh.canRefresh(null)).toBe(false);
    expect(refresh.blocker({ available: false, reason: "Not here." })).toBe("Not here.");
    expect(refresh.blocker({ ...STATE, estimates: { ...STATE.estimates, all: estimate("all", 0, 0, 0) } })).toMatch(/Sync first/);
    expect(refresh.canRefresh(STATE)).toBe(true);
    expect(refresh.canRefresh({ ...STATE, status: { state: "running" } })).toBe(false);
  });

  it("describes how far the images have been read", () => {
    expect(refresh.imagesLine(STATE.images)).toBe("Text read from 30 of 36 images (22 with text). 6 waiting.");
    expect(refresh.imagesLine({ ...STATE.images, worker: { state: "running", settled: 3, total: 6 } })).toBe(
      "Reading the text in images: 3 of 6…",
    );
    expect(refresh.imagesLine({ ...STATE.images, unavailable: 6, worker: { state: "done", recognizer: null } })).toMatch(
      /can't be read on this computer/,
    );
    expect(refresh.imagesLine({ total: 0 })).toMatch(/No images found yet/);
  });

  it("keeps the strip running while the images of a finished refresh are read, then states the outcome", () => {
    const done = {
      state: "done",
      startedAt: "2026-11-01T10:00:00Z",
      finishedAt: "2026-11-01T10:00:05Z",
      summary: { refreshed: 10, imagesFound: 6 },
      messages: [],
    };
    const reading = { ...STATE.images, worker: { state: "running", startedAt: "2026-11-01T10:00:05Z", settled: 2, total: 6 } };
    const strip = refresh.stripStatus(done, reading);
    expect(strip.state).toBe("running");
    expect(refresh.progressLine(strip, reading)).toBe("Refreshed 10 bookmarks · reading the text in images: 2 of 6…");
    expect(refresh.needsPolling({ status: done, images: reading })).toBe(true);

    const finished = {
      ...STATE.images,
      done: 36,
      worker: { state: "done", startedAt: "2026-11-01T10:00:05Z", finishedAt: "2026-11-01T10:00:09Z", last: { read: 6 } },
    };
    expect(refresh.stripStatus(done, finished)).toBe(done);
    expect(refresh.progressLine(done, finished)).toBe("Refreshed 10 bookmarks · 6 images found · text read from 36 images.");
    expect(refresh.needsPolling({ status: done, images: finished })).toBe(false);
  });

  it("labels the summary modal's image text by where each image is, skipping wordless ones", () => {
    const entries = refresh.imageTextEntries([
      { source: "post", type: "photo", altText: "A chart", text: null },
      { source: "post", type: "photo", altText: null, text: "" },
      { source: "quoted-post", type: "photo", altText: null, text: "Memo text" },
    ]);
    expect(entries).toEqual([
      { label: "Image 1 in the post", altText: "A chart", text: null },
      { label: "Image 1 in the quoted post", altText: null, text: "Memo text" },
    ]);
    expect(refresh.imageTextSummary(entries)).toBe("Text in images (2)");
    expect(refresh.imageTextSummary(entries.slice(0, 1))).toBe("Text in image");
  });
});

describe("progressSource - a refresh shares the ONE strip", () => {
  it("is chosen when it is the live job", () => {
    const running = { state: "running", startedAt: "2026-01-01T00:00:02Z" };
    const old = { state: "done", startedAt: "2026-01-01T00:00:00Z" };
    expect(ranking.progressSource(old, null, null, running)).toBe("refresh");
    expect(ranking.progressSource(running, null, null, old)).toBe("sync");
  });
});
