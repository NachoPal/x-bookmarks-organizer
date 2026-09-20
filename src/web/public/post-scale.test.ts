import { describe, expect, it } from "vitest";

// Plain browser JS, required directly (not compiled by tsc).
const {
  DEFAULT_POST_SCALE,
  POST_SCALES,
  isKnownScale,
  readPostScale,
  writePostScale,
  scaleFor,
} = require("./post-scale.js");

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

describe("post scale steps", () => {
  it("offers steps in ascending scale order around an unscaled default", () => {
    const scales = POST_SCALES.map((s: { scale: number }) => s.scale);
    expect(scales).toEqual([...scales].sort((a, b) => a - b));
    expect(scaleFor(DEFAULT_POST_SCALE)).toBe(1);
  });

  it("keeps every step inside the bounds the card layout can absorb", () => {
    // Lower bound: the action row's shortest control (the 1.75rem read pill)
    // must stay a >=24px pointer target once zoomed.
    // Upper bound: the 36rem card must still fit the 44rem content column.
    for (const step of POST_SCALES) {
      expect(28 * step.scale).toBeGreaterThanOrEqual(24);
      expect(36 * step.scale).toBeLessThanOrEqual(44);
    }
  });

  it("recognizes only the offered step ids", () => {
    for (const step of POST_SCALES) expect(isKnownScale(step.id)).toBe(true);
    expect(isKnownScale("gigantic")).toBe(false);
    expect(isKnownScale(null)).toBe(false);
  });

  it("falls back to an unscaled multiplier for an unknown id", () => {
    expect(scaleFor("gigantic")).toBe(1);
  });
});

describe("post scale persistence", () => {
  it("defaults to medium when nothing is stored", () => {
    expect(readPostScale(fakeStorage())).toBe(DEFAULT_POST_SCALE);
    expect(DEFAULT_POST_SCALE).toBe("medium");
  });

  it("round-trips each offered step", () => {
    for (const step of POST_SCALES) {
      const storage = fakeStorage();
      writePostScale(storage, step.id);
      expect(readPostScale(storage)).toBe(step.id);
    }
  });

  it("ignores a write of an unknown step", () => {
    const storage = fakeStorage();
    writePostScale(storage, "gigantic");
    expect(readPostScale(storage)).toBe(DEFAULT_POST_SCALE);
  });

  it("falls back to the default when a stale stored value is no longer offered", () => {
    const storage = fakeStorage();
    storage.setItem("xbo:post-scale", "enormous");
    expect(readPostScale(storage)).toBe(DEFAULT_POST_SCALE);
  });

  it("falls back to the default when storage throws on read", () => {
    expect(readPostScale(throwingStorage())).toBe(DEFAULT_POST_SCALE);
  });

  it("does not throw when storage throws on write", () => {
    expect(() => writePostScale(throwingStorage(), "large")).not.toThrow();
  });
});
