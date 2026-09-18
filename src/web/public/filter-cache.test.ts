import { describe, expect, it } from "vitest";

// Plain browser JS, required directly (not compiled by tsc).
const { MAX_CACHED_CATEGORIES, touchLru, survivesReadChange, isFilterEntryStale } = require("./filter-cache.js");

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

describe("survivesReadChange", () => {
  it("the all filter always keeps a post regardless of read state", () => {
    expect(survivesReadChange("all", true)).toBe(true);
    expect(survivesReadChange("all", false)).toBe(true);
  });

  it("the unread filter keeps only unread posts", () => {
    expect(survivesReadChange("unread", false)).toBe(true);
    expect(survivesReadChange("unread", true)).toBe(false);
  });

  it("the read filter keeps only read posts", () => {
    expect(survivesReadChange("read", true)).toBe(true);
    expect(survivesReadChange("read", false)).toBe(false);
  });
});

describe("isFilterEntryStale", () => {
  it("a bookmark just marked read makes the cached unread list stale (it must disappear)", () => {
    expect(isFilterEntryStale([1, 2, 3], "unread", 2, true)).toBe(true);
  });

  it("a bookmark just marked read makes the cached read list stale (it must appear)", () => {
    expect(isFilterEntryStale([1, 3], "read", 2, true)).toBe(true);
  });

  it("a bookmark just marked unread makes the cached read list stale (it must disappear)", () => {
    expect(isFilterEntryStale([1, 2, 3], "read", 2, false)).toBe(true);
  });

  it("a bookmark just marked unread makes the cached unread list stale (it must appear)", () => {
    expect(isFilterEntryStale([1, 3], "unread", 2, false)).toBe(true);
  });

  it("the all filter's cached list is never considered stale by a read-state change", () => {
    // "all" always includes a bookmark the cache already knows about,
    // regardless of its read state.
    expect(isFilterEntryStale([1, 2, 3], "all", 2, true)).toBe(false);
    expect(isFilterEntryStale([1, 2, 3], "all", 2, false)).toBe(false);
  });

  it("is not stale when the cached presence already matches the new state", () => {
    expect(isFilterEntryStale([1, 2, 3], "unread", 2, false)).toBe(false);
    expect(isFilterEntryStale([1, 3], "unread", 2, true)).toBe(false);
  });
});
