import { describe, expect, it } from "vitest";

// Plain browser JS, required directly (not compiled by tsc).
const {
  DEFAULT_TEXT_SIZE,
  TEXT_SIZES,
  isKnownSize,
  readTextSize,
  writeTextSize,
  scaleFor,
} = require("./text-size.js");

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

describe("text size steps", () => {
  it("offers steps in ascending scale order around an unscaled default", () => {
    const scales = TEXT_SIZES.map((s: { scale: number }) => s.scale);
    expect(scales).toEqual([...scales].sort((a, b) => a - b));
    expect(scaleFor(DEFAULT_TEXT_SIZE)).toBe(1);
  });

  it("recognizes only the offered step ids", () => {
    for (const size of TEXT_SIZES) expect(isKnownSize(size.id)).toBe(true);
    expect(isKnownSize("gigantic")).toBe(false);
    expect(isKnownSize(null)).toBe(false);
  });

  it("falls back to an unscaled multiplier for an unknown id", () => {
    expect(scaleFor("gigantic")).toBe(1);
  });
});

describe("text size persistence", () => {
  it("defaults to medium when nothing is stored", () => {
    expect(readTextSize(fakeStorage())).toBe(DEFAULT_TEXT_SIZE);
    expect(DEFAULT_TEXT_SIZE).toBe("medium");
  });

  it("round-trips each offered step", () => {
    for (const size of TEXT_SIZES) {
      const storage = fakeStorage();
      writeTextSize(storage, size.id);
      expect(readTextSize(storage)).toBe(size.id);
    }
  });

  it("ignores a write of an unknown step", () => {
    const storage = fakeStorage();
    writeTextSize(storage, "gigantic");
    expect(readTextSize(storage)).toBe(DEFAULT_TEXT_SIZE);
  });

  it("falls back to the default when a stale stored value is no longer offered", () => {
    const storage = fakeStorage();
    storage.setItem("xbo:text-size", "enormous");
    expect(readTextSize(storage)).toBe(DEFAULT_TEXT_SIZE);
  });

  it("falls back to the default when storage throws on read", () => {
    expect(readTextSize(throwingStorage())).toBe(DEFAULT_TEXT_SIZE);
  });

  it("does not throw when storage throws on write", () => {
    expect(() => writeTextSize(throwingStorage(), "large")).not.toThrow();
  });
});
