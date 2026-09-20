import { describe, expect, it } from "vitest";

// Plain browser JS, required directly (not compiled by tsc).
const {
  SELECTION_KEY,
  SNAPSHOT_KEY,
  SNAPSHOT_TTL_MS,
  readSelection,
  writeSelection,
  boundViews,
  serializeSnapshot,
  parseSnapshot,
  readSnapshot,
  writeSnapshot,
  clearSnapshot,
} = require("./view-persist.js");

function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  } as unknown as Storage;
}

const throwingStorage = {
  getItem() {
    throw new Error("blocked");
  },
  setItem() {
    throw new Error("blocked");
  },
  removeItem() {
    throw new Error("blocked");
  },
} as unknown as Storage;

function view(categoryId: number, filter = "all", n = 2) {
  return {
    categoryId,
    filter,
    counts: { total: n, unread: n, favorite: 0 },
    bookmarks: Array.from({ length: n }, (_, i) => ({ id: categoryId * 100 + i, text: "x" })),
    offset: n,
    hasMore: false,
  };
}

describe("selection", () => {
  it("round-trips category and filter", () => {
    const s = fakeStorage();
    writeSelection(s, 7, "read");
    expect(readSelection(s)).toEqual({ categoryId: 7, filter: "read" });
    writeSelection(s, null, "all");
    expect(readSelection(s)).toEqual({ categoryId: null, filter: "all" });
  });

  it("is null when absent or garbled, and coerces an unknown filter to all", () => {
    const s = fakeStorage();
    expect(readSelection(s)).toBeNull();
    s.setItem(SELECTION_KEY, "{nope");
    expect(readSelection(s)).toBeNull();
    s.setItem(SELECTION_KEY, JSON.stringify({ categoryId: 3, filter: "bogus" }));
    expect(readSelection(s)).toEqual({ categoryId: 3, filter: "all" });
    s.setItem(SELECTION_KEY, JSON.stringify({ categoryId: "3", filter: "read" }));
    expect(readSelection(s)).toEqual({ categoryId: null, filter: "read" });
  });

  it("never throws on blocked storage", () => {
    expect(() => writeSelection(throwingStorage, 1, "all")).not.toThrow();
    expect(readSelection(throwingStorage)).toBeNull();
  });
});

describe("snapshot", () => {
  it("round-trips fresh views for the same sort", () => {
    const s = fakeStorage();
    writeSnapshot(s, [view(1), view(2, "unread")], "recent", 1000);
    const back = readSnapshot(s, "recent", 1000 + 1000);
    expect(back.map((v: { categoryId: number }) => v.categoryId)).toEqual([1, 2]);
    expect(back[0].bookmarks).toHaveLength(2);
  });

  it("expires after the TTL and rejects a different sort or version", () => {
    const raw = serializeSnapshot([view(1)], "recent", 1000);
    expect(parseSnapshot(raw, "recent", 1000 + SNAPSHOT_TTL_MS)).toHaveLength(1);
    expect(parseSnapshot(raw, "recent", 1000 + SNAPSHOT_TTL_MS + 1)).toEqual([]);
    expect(parseSnapshot(raw, "score", 1000)).toEqual([]);
    expect(parseSnapshot(raw, "recent", 500)).toEqual([]); // clock went backwards
    expect(parseSnapshot(raw.replace('"v":1', '"v":99'), "recent", 1000)).toEqual([]);
  });

  it("drops malformed views and survives garbage", () => {
    const bad = JSON.stringify({
      v: 1,
      savedAt: 1,
      sort: "recent",
      views: [view(1), { categoryId: 2 }, { ...view(3), filter: "zzz" }],
    });
    expect(parseSnapshot(bad, "recent", 2).map((v: { categoryId: number }) => v.categoryId)).toEqual([1]);
    expect(parseSnapshot("not json", "recent", 2)).toEqual([]);
    expect(parseSnapshot("null", "recent", 2)).toEqual([]);
  });

  it("bounds by view count, keeping the newest", () => {
    const views = [1, 2, 3, 4, 5].map((n) => view(n));
    const { views: kept } = boundViews(views, "recent", 1, 3);
    expect(kept.map((v: { categoryId: number }) => v.categoryId)).toEqual([3, 4, 5]);
  });

  it("bounds by size, dropping the oldest until it fits", () => {
    const views = [view(1, "all", 50), view(2, "all", 50), view(3, "all", 2)];
    const one = serializeSnapshot([views[2]], "recent", 1).length;
    const { views: kept, json } = boundViews(views, "recent", 1, 8, one + 10);
    expect(kept.map((v: { categoryId: number }) => v.categoryId)).toEqual([3]);
    expect(json.length).toBeLessThanOrEqual(one + 10);
  });

  it("clears on invalidation and tolerates blocked or full storage", () => {
    const s = fakeStorage();
    writeSnapshot(s, [view(1)], "recent", 1);
    expect(s.getItem(SNAPSHOT_KEY)).not.toBeNull();
    clearSnapshot(s);
    expect(readSnapshot(s, "recent", 2)).toEqual([]);
    writeSnapshot(s, [], "recent", 1);
    expect(s.getItem(SNAPSHOT_KEY)).toBeNull();
    expect(() => writeSnapshot(throwingStorage, [view(1)], "recent", 1)).not.toThrow();
    expect(readSnapshot(throwingStorage, "recent", 1)).toEqual([]);
    expect(() => clearSnapshot(throwingStorage)).not.toThrow();
  });
});
