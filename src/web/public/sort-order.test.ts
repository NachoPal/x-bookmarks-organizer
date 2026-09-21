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
  scoreBreakdown,
  describeScore,
  DIMENSIONS,
} = require("./sort-order.js");

interface BreakdownDimension {
  id: string;
  label: string;
  short: string;
  value: number;
  rating: string;
  percent: number;
}

interface Breakdown {
  rating: string;
  value: number;
  confidence: number | null;
  confidencePercent: number | null;
  dimensions: BreakdownDimension[];
}

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

describe("scoreBreakdown", () => {
  it("unpacks the overall rating, the confidence and one row per dimension", () => {
    const breakdown = scoreBreakdown({
      value: 0.78,
      confidence: 0.86,
      dimensions: { learning_value: 0.9, durability: 0.5 },
    }) as Breakdown;
    expect(breakdown.rating).toBe("7.8");
    expect(breakdown.value).toBeCloseTo(0.78);
    expect(breakdown.confidencePercent).toBe(86);
    expect(breakdown.dimensions.map((d) => [d.label, d.rating, d.percent])).toEqual([
      ["Learning value", "9.0", 90],
      ["Durability", "5.0", 50],
    ]);
  });

  it("orders rows by the rubric, not by the stored row's key order", () => {
    // Two bookmarks' graphs must line up row for row, whatever order the JSON
    // blob happened to be written in.
    const breakdown = scoreBreakdown({
      value: 0.5,
      dimensions: { relevance: 0.1, learning_value: 0.2, durability: 0.3 },
    }) as Breakdown;
    expect(breakdown.dimensions.map((d) => d.id)).toEqual([
      "learning_value",
      "durability",
      "relevance",
    ]);
    // ...which is the rubric's own order, filtered to what was stored.
    const rubricOrder = (DIMENSIONS as { id: string }[]).map((d) => d.id);
    expect(rubricOrder.indexOf("learning_value")).toBeLessThan(rubricOrder.indexOf("durability"));
  });

  it("omits a dimension the row does not carry rather than zero-filling it", () => {
    // `relevance` is opt-in, and an older row simply has fewer answers - an
    // absent answer is not an answer of zero.
    const breakdown = scoreBreakdown({ value: 0.4, dimensions: { learning_value: 0.4 } }) as Breakdown;
    expect(breakdown.dimensions.map((d) => d.id)).toEqual(["learning_value"]);
  });

  it("still shows a dimension this build has no label for, keyed by its id", () => {
    const breakdown = scoreBreakdown({ value: 0.5, dimensions: { future_thing: 1 } }) as Breakdown;
    expect(breakdown.dimensions).toEqual([
      { id: "future_thing", label: "future_thing", short: "future_thing", value: 1, rating: "10.0", percent: 100 },
    ]);
  });

  it("reports a missing or unusable confidence as null, never as zero", () => {
    expect((scoreBreakdown({ value: 0.5 }) as Breakdown).confidence).toBeNull();
    expect((scoreBreakdown({ value: 0.5 }) as Breakdown).confidencePercent).toBeNull();
    expect(
      (scoreBreakdown({ value: 0.5, confidence: Number.NaN }) as Breakdown).confidencePercent,
    ).toBeNull();
  });

  it("survives a score row with no readable breakdown blob", () => {
    // `dimensions` is read tolerantly server-side, so the graph has to cope
    // with a total that has nothing behind it.
    const breakdown = scoreBreakdown({ value: 0.6, dimensions: null }) as Breakdown;
    expect(breakdown.rating).toBe("6.0");
    expect(breakdown.dimensions).toEqual([]);
  });

  it("clamps values that fall outside 0..1", () => {
    const breakdown = scoreBreakdown({
      value: 2,
      confidence: 2,
      dimensions: { learning_value: -1, durability: 5 },
    }) as Breakdown;
    expect(breakdown.rating).toBe("10.0");
    expect(breakdown.confidencePercent).toBe(100);
    expect(breakdown.dimensions.map((d) => d.percent)).toEqual([0, 100]);
  });

  it("is null for a bookmark that was never ranked", () => {
    expect(scoreBreakdown(null)).toBeNull();
    expect(scoreBreakdown({})).toBeNull();
    expect(scoreBreakdown({ value: Number.NaN })).toBeNull();
  });
});
