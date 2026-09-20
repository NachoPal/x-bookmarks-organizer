import { describe, expect, it } from "vitest";

// Plain browser JS, required directly (not compiled by tsc).
const {
  DEFAULT_SORT_ORDER,
  SORT_ORDERS,
  isKnownSortOrder,
  readSortOrder,
  writeSortOrder,
  sortParam,
  formatScore,
  describeScore,
} = require("./sort-order.js");

/** A minimal in-memory Storage stand-in so these tests don't need jsdom. */
function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    clear: () => map.clear(),
    key: () => null,
    get length() {
      return map.size;
    },
  } as Storage;
}

/** A storage stand-in that always throws, mirroring private-mode/blocked storage. */
function throwingStorage(): Storage {
  return {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
    removeItem: () => {},
    clear: () => {},
    key: () => null,
    length: 0,
  } as Storage;
}

describe("sort order", () => {
  it("defaults to recency, so a library that was never ranked opens unchanged", () => {
    expect(DEFAULT_SORT_ORDER).toBe("recent");
    expect(readSortOrder(fakeStorage())).toBe("recent");
    expect(SORT_ORDERS[0].id).toBe("recent");
  });

  it("round-trips a known order and ignores an unknown one", () => {
    const storage = fakeStorage();
    writeSortOrder(storage, "score");
    expect(readSortOrder(storage)).toBe("score");
    writeSortOrder(storage, "nonsense");
    expect(readSortOrder(storage)).toBe("score");
    expect(isKnownSortOrder("score")).toBe(true);
    expect(isKnownSortOrder("nonsense")).toBe(false);
  });

  it("falls back to the default when a stored value is no longer offered", () => {
    const storage = fakeStorage();
    storage.setItem("xbo:sort-order", "by-author");
    expect(readSortOrder(storage)).toBe("recent");
  });

  it("survives storage that throws", () => {
    expect(readSortOrder(throwingStorage())).toBe("recent");
    expect(() => writeSortOrder(throwingStorage(), "score")).not.toThrow();
  });

  it("maps an order onto the API's sort parameter", () => {
    expect(sortParam("score")).toBe("score");
    expect(sortParam("recent")).toBe("recent");
    expect(sortParam("nonsense")).toBe("recent");
  });
});

describe("formatScore", () => {
  it("renders a 0..1 score as a 0..10 rating with one decimal", () => {
    expect(formatScore({ value: 0.82 })).toBe("8.2");
    expect(formatScore({ value: 1 })).toBe("10.0");
    expect(formatScore({ value: 0 })).toBe("0.0");
  });

  it("returns null for an unranked bookmark rather than a zero", () => {
    // Never ranked is not the same claim as ranked worthless.
    expect(formatScore(null)).toBeNull();
    expect(formatScore(undefined)).toBeNull();
    expect(formatScore({ value: Number.NaN })).toBeNull();
    expect(formatScore({})).toBeNull();
  });

  it("clamps a score outside 0..1", () => {
    expect(formatScore({ value: 2 })).toBe("10.0");
    expect(formatScore({ value: -1 })).toBe("0.0");
  });
});

describe("describeScore", () => {
  it("spells out the rating, the confidence and the breakdown in prose", () => {
    const text = describeScore({
      value: 0.75,
      confidence: 0.62,
      dimensions: { learning_value: 0.9, durability: 0.5 },
    });
    expect(text).toContain("Learning value 7.5 of 10");
    expect(text).toContain("confidence 62%");
    expect(text).toContain("learning 9.0");
    expect(text).toContain("lasting 5.0");
  });

  it("omits what it does not have, without inventing zeros", () => {
    expect(describeScore({ value: 0.5 })).toBe("Learning value 5.0 of 10.");
  });

  it("falls back to a raw dimension key it has no label for", () => {
    expect(describeScore({ value: 0.5, dimensions: { future_thing: 1 } })).toContain(
      "future_thing 10.0",
    );
  });

  it("is null when there is nothing to describe", () => {
    expect(describeScore(null)).toBeNull();
  });
});
