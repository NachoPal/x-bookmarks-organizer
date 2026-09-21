import { describe, expect, it } from "vitest";

// Plain browser JS, required directly (not compiled by tsc).
const { MAX_CACHED_CATEGORIES, touchLru, touchPool, deriveFilterIds, survivesFilter, isFilterEntryStale } = require("./filter-cache.js");

/** A bookmark's cacheable state, as the viewer tracks it per card. */
const state = (read: boolean, favorite = false) => ({ read, favorite });

describe("touchLru", () => {
  it("appends a new id to the recent end", () => {
    const { order, evicted } = touchLru([1, 2], 3, 5);
    expect(order).toEqual([1, 2, 3]);
    expect(evicted).toEqual([]);
  });

  it("moves an already-present id to the recent end instead of duplicating it", () => {
    const { order, evicted } = touchLru([1, 2, 3], 1, 5);
    expect(order).toEqual([2, 3, 1]);
    expect(evicted).toEqual([]);
  });

  it("evicts the oldest id(s) once the limit is exceeded", () => {
    const { order, evicted } = touchLru([1, 2, 3], 4, 3);
    expect(order).toEqual([2, 3, 4]);
    expect(evicted).toEqual([1]);
  });

  it("defaults to MAX_CACHED_CATEGORIES when no limit is given", () => {
    const many = Array.from({ length: MAX_CACHED_CATEGORIES }, (_, i) => i + 1);
    const { order, evicted } = touchLru(many, 999);
    expect(order.length).toBe(MAX_CACHED_CATEGORIES);
    expect(order[order.length - 1]).toBe(999);
    expect(evicted).toEqual([1]);
  });

  it("never mutates the input array", () => {
    const input = [1, 2, 3];
    touchLru(input, 4, 3);
    expect(input).toEqual([1, 2, 3]);
  });
});

describe("survivesFilter", () => {
  it("the all filter always keeps a post regardless of its state", () => {
    expect(survivesFilter("all", state(true))).toBe(true);
    expect(survivesFilter("all", state(false))).toBe(true);
    expect(survivesFilter("all", state(false, true))).toBe(true);
  });

  it("the unread filter keeps only unread posts", () => {
    expect(survivesFilter("unread", state(false))).toBe(true);
    expect(survivesFilter("unread", state(true))).toBe(false);
  });

  it("the read filter keeps only read posts", () => {
    expect(survivesFilter("read", state(true))).toBe(true);
    expect(survivesFilter("read", state(false))).toBe(false);
  });

  it("the favorite filter keeps only starred posts, whatever their read state", () => {
    expect(survivesFilter("favorite", state(false, true))).toBe(true);
    expect(survivesFilter("favorite", state(true, true))).toBe(true);
    expect(survivesFilter("favorite", state(true, false))).toBe(false);
  });
});

describe("isFilterEntryStale", () => {
  it("a bookmark just marked read makes the cached unread list stale (it must disappear)", () => {
    expect(isFilterEntryStale([1, 2, 3], "unread", 2, state(true))).toBe(true);
  });

  it("a bookmark just marked read makes the cached read list stale (it must appear)", () => {
    expect(isFilterEntryStale([1, 3], "read", 2, state(true))).toBe(true);
  });

  it("a bookmark just marked unread makes the cached read list stale (it must disappear)", () => {
    expect(isFilterEntryStale([1, 2, 3], "read", 2, state(false))).toBe(true);
  });

  it("a bookmark just marked unread makes the cached unread list stale (it must appear)", () => {
    expect(isFilterEntryStale([1, 3], "unread", 2, state(false))).toBe(true);
  });

  it("a bookmark just starred makes the cached favorites list stale (it must appear)", () => {
    expect(isFilterEntryStale([1, 3], "favorite", 2, state(false, true))).toBe(true);
  });

  it("a bookmark just unstarred makes the cached favorites list stale (it must disappear)", () => {
    expect(isFilterEntryStale([1, 2, 3], "favorite", 2, state(false, false))).toBe(true);
  });

  it("a read-state change never makes a cached favorites list stale on its own", () => {
    expect(isFilterEntryStale([1, 2, 3], "favorite", 2, state(true, true))).toBe(false);
    expect(isFilterEntryStale([1, 3], "favorite", 2, state(true, false))).toBe(false);
  });

  it("a favorite change never makes a cached unread/read list stale on its own", () => {
    expect(isFilterEntryStale([1, 2, 3], "unread", 2, state(false, true))).toBe(false);
    expect(isFilterEntryStale([1, 2, 3], "read", 2, state(true, true))).toBe(false);
  });

  it("the all filter's cached list is never considered stale by a toggle", () => {
    // "all" always includes a bookmark the cache already knows about,
    // regardless of its read or favorite state.
    expect(isFilterEntryStale([1, 2, 3], "all", 2, state(true))).toBe(false);
    expect(isFilterEntryStale([1, 2, 3], "all", 2, state(false, true))).toBe(false);
  });

  it("is not stale when the cached presence already matches the new state", () => {
    expect(isFilterEntryStale([1, 2, 3], "unread", 2, state(false))).toBe(false);
    expect(isFilterEntryStale([1, 3], "unread", 2, state(true))).toBe(false);
  });
});

describe("touchPool (per-post LRU, issue #67)", () => {
  it("marks touched posts most recent without duplicating them", () => {
    const { order, evicted } = touchPool([1, 2, 3], [1], 10, []);
    expect(order).toEqual([2, 3, 1]);
    expect(evicted).toEqual([]);
  });

  it("evicts the oldest posts beyond the cap, bounding the pool", () => {
    const { order, evicted } = touchPool([1, 2, 3, 4], [5, 6], 4, []);
    expect(order).toEqual([3, 4, 5, 6]);
    expect(evicted).toEqual([1, 2]);
  });

  it("never evicts a protected (on-screen) post, even over the cap", () => {
    const { order, evicted } = touchPool([1, 2, 3], [4], 3, [1]);
    expect(evicted).toEqual([2]);
    expect(order).toEqual([1, 3, 4]);
  });

  it("does not mutate its input", () => {
    const input = [1, 2, 3];
    touchPool(input, [4], 2, []);
    expect(input).toEqual([1, 2, 3]);
  });
});

describe("deriveFilterIds", () => {
  const byId = new Map([
    [1, { read: false, favorite: false }],
    [2, { read: true, favorite: false }],
    [3, { read: false, favorite: true }],
  ]);
  it("derives each tab from a complete All list, keeping its order", () => {
    expect(deriveFilterIds("unread", [3, 2, 1], byId)).toEqual([3, 1]);
    expect(deriveFilterIds("read", [3, 2, 1], byId)).toEqual([2]);
    expect(deriveFilterIds("favorite", [3, 2, 1], byId)).toEqual([3]);
    expect(deriveFilterIds("all", [3, 2, 1], byId)).toEqual([3, 2, 1]);
  });
});

describe("loadingStrategy (issue #78)", () => {
  const { loadingStrategy } = require("./filter-cache.js");
  it("keeps the current content only for a tab switch inside a mounted category", () => {
    expect(loadingStrategy(false, true)).toBe("keep-content");
    expect(loadingStrategy(true, true)).toBe("placeholder");
    expect(loadingStrategy(false, false)).toBe("placeholder");
  });
});

describe("foldServerRow (issue #91)", () => {
  const { foldServerRow, sameScore } = require("./filter-cache.js");

  /** A verdict as `/api/categories/:id/bookmarks` ships it. */
  const verdict = (value: number) => ({
    value,
    confidence: 0.9,
    dimensions: { learning_value: value },
  });

  it("carries a newly ranked post's score onto the pooled bookmark", () => {
    // The exact incremental-rank case: the post was pooled BEFORE the run, so
    // the card on screen was rendered with no verdict at all.
    const pooled = { id: 1, read: false, favorite: false, score: null, hasSummary: false };
    const changed = foldServerRow(pooled, {
      id: 1,
      read: false,
      favorite: false,
      score: verdict(0.8),
      hasSummary: false,
    });

    expect(pooled.score).toEqual(verdict(0.8));
    expect(changed.score).toBe(true);
    // Ranking writes scores and nothing else, so the read/favorite controls
    // must not be repainted for it.
    expect(changed.controls).toBe(false);
  });

  it("reports no score change when the verdict is unchanged", () => {
    const pooled = { id: 1, read: false, favorite: false, score: verdict(0.8) };
    const changed = foldServerRow(pooled, {
      id: 1,
      read: false,
      favorite: false,
      score: verdict(0.8),
    });
    expect(changed.score).toBe(false);
  });

  it("still folds in fresher read/favorite state, and keeps a local summary", () => {
    const pooled = { id: 1, read: false, readAt: null, favorite: false, score: null, hasSummary: true };
    const changed = foldServerRow(pooled, {
      id: 1,
      read: true,
      readAt: "2024-05-01T00:00:00.000Z",
      favorite: true,
      score: null,
      hasSummary: false,
    });

    expect(changed).toEqual({ controls: true, score: false });
    expect(pooled.read).toBe(true);
    expect(pooled.readAt).toBe("2024-05-01T00:00:00.000Z");
    expect(pooled.favorite).toBe(true);
    // A summary generated in this tab is not in the row the server sent.
    expect(pooled.hasSummary).toBe(true);
  });

  it("never mutates the server row", () => {
    const row = { id: 1, read: true, favorite: false, score: verdict(0.5) };
    const snapshot = JSON.parse(JSON.stringify(row));
    foldServerRow({ id: 1, read: false, favorite: false, score: null }, row);
    expect(row).toEqual(snapshot);
  });

  describe("sameScore", () => {
    it("treats an absent verdict as 'never ranked', never as a zero", () => {
      expect(sameScore(null, null)).toBe(true);
      expect(sameScore(null, verdict(0))).toBe(false);
      expect(sameScore(verdict(0), null)).toBe(false);
    });

    it("compares the value, the confidence and the breakdown", () => {
      expect(sameScore(verdict(0.4), verdict(0.4))).toBe(true);
      expect(sameScore(verdict(0.4), verdict(0.5))).toBe(false);
      expect(sameScore(verdict(0.4), { ...verdict(0.4), confidence: 0.1 })).toBe(false);
      expect(sameScore(verdict(0.4), { ...verdict(0.4), dimensions: {} })).toBe(false);
    });
  });
});
