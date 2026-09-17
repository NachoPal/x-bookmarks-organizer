import { describe, expect, it } from "vitest";

// Plain browser JS, required directly (not compiled by tsc).
const { ROOT_HUES, rootCategoryHue, readColorEnabled, writeColorEnabled } = require("./tree-color.js");

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

describe("rootCategoryHue", () => {
  it("is stable for the same category id across calls", () => {
    expect(rootCategoryHue("42")).toBe(rootCategoryHue("42"));
    expect(rootCategoryHue("Technology")).toBe(rootCategoryHue("Technology"));
  });

  it("returns a hue from the curated palette", () => {
    for (const id of ["1", "2", "3", "Design", "Sports", "some-long-category-name"]) {
      expect(ROOT_HUES).toContain(rootCategoryHue(id));
    }
  });

  it("cycles the palette when there are more roots than colors", () => {
    const ids = Array.from({ length: ROOT_HUES.length * 3 }, (_, i) => String(i));
    for (const id of ids) {
      expect(ROOT_HUES).toContain(rootCategoryHue(id));
    }
  });

  it("spreads different ids across more than one hue", () => {
    const hues = new Set(
      Array.from({ length: 30 }, (_, i) => rootCategoryHue(`category-${i}`)),
    );
    expect(hues.size).toBeGreaterThan(1);
  });
});

describe("category-color toggle persistence", () => {
  it("defaults to enabled (the current colored look) when nothing is stored", () => {
    expect(readColorEnabled(fakeStorage())).toBe(true);
  });

  it("round-trips a persisted off preference", () => {
    const storage = fakeStorage();
    writeColorEnabled(storage, false);
    expect(readColorEnabled(storage)).toBe(false);
  });

  it("round-trips a persisted on preference", () => {
    const storage = fakeStorage();
    writeColorEnabled(storage, false);
    writeColorEnabled(storage, true);
    expect(readColorEnabled(storage)).toBe(true);
  });

  it("falls back to enabled when storage throws on read", () => {
    expect(readColorEnabled(throwingStorage())).toBe(true);
  });

  it("does not throw when storage throws on write", () => {
    expect(() => writeColorEnabled(throwingStorage(), false)).not.toThrow();
  });
});
