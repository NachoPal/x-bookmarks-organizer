import { describe, expect, it } from "vitest";

// Plain browser JS, required directly (not compiled by tsc).
const {
  MIN_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  SIDEBAR_WIDTH_STEP,
  SIDEBAR_WIDTH_PAGE_STEP,
  clampWidth,
  readWidth,
  writeWidth,
  clearWidth,
  stepWidth,
} = require("./sidebar-width.js");

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
    removeItem: () => {
      throw new Error("blocked");
    },
    clear: () => {},
    key: () => null,
    length: 0,
  } as Storage;
}

describe("clampWidth", () => {
  it("holds a width inside the bounds", () => {
    expect(clampWidth(MIN_SIDEBAR_WIDTH - 200)).toBe(MIN_SIDEBAR_WIDTH);
    expect(clampWidth(MAX_SIDEBAR_WIDTH + 2000)).toBe(MAX_SIDEBAR_WIDTH);
    expect(clampWidth(300)).toBe(300);
  });

  it("rounds to a whole pixel (a drag reports fractions)", () => {
    expect(clampWidth(300.6)).toBe(301);
  });

  it("parses the stored string form", () => {
    expect(clampWidth("312")).toBe(312);
  });

  it("is null - not a guessed width - for anything unusable", () => {
    expect(clampWidth(Number.NaN)).toBeNull();
    expect(clampWidth(null)).toBeNull();
    expect(clampWidth(undefined)).toBeNull();
    expect(clampWidth("not a width")).toBeNull();
    expect(clampWidth(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("persistence", () => {
  it("round-trips a chosen width", () => {
    const storage = fakeStorage();
    writeWidth(storage, 336);
    expect(readWidth(storage)).toBe(336);
  });

  it("reads back a width that is now out of bounds, clamped", () => {
    const storage = fakeStorage();
    storage.setItem("xbo:sidebar-width", "5000");
    expect(readWidth(storage)).toBe(MAX_SIDEBAR_WIDTH);
  });

  it("returns null with nothing stored, so the stylesheet default stands", () => {
    expect(readWidth(fakeStorage())).toBeNull();
  });

  it("ignores a corrupt stored value rather than resizing to junk", () => {
    const storage = fakeStorage();
    storage.setItem("xbo:sidebar-width", "wide please");
    expect(readWidth(storage)).toBeNull();
  });

  it("never stores an unusable width over a good one", () => {
    const storage = fakeStorage();
    writeWidth(storage, 300);
    writeWidth(storage, Number.NaN);
    expect(readWidth(storage)).toBe(300);
  });

  it("clamps on the way in, so a stored width is always in bounds", () => {
    const storage = fakeStorage();
    writeWidth(storage, 10);
    expect(storage.getItem("xbo:sidebar-width")).toBe(String(MIN_SIDEBAR_WIDTH));
  });

  it("forgets the preference on clear", () => {
    const storage = fakeStorage();
    writeWidth(storage, 300);
    clearWidth(storage);
    expect(readWidth(storage)).toBeNull();
  });

  it("survives storage that throws (private mode / blocked)", () => {
    const storage = throwingStorage();
    expect(readWidth(storage)).toBeNull();
    expect(() => writeWidth(storage, 300)).not.toThrow();
    expect(() => clearWidth(storage)).not.toThrow();
  });
});

describe("stepWidth (the keyboard path)", () => {
  it("grows to the right and shrinks to the left, matching the edge dragged", () => {
    expect(stepWidth(300, "ArrowRight")).toBe(300 + SIDEBAR_WIDTH_STEP);
    expect(stepWidth(300, "ArrowLeft")).toBe(300 - SIDEBAR_WIDTH_STEP);
  });

  it("takes the coarse step on PageUp/PageDown", () => {
    expect(stepWidth(300, "PageUp")).toBe(300 + SIDEBAR_WIDTH_PAGE_STEP);
    expect(stepWidth(300, "PageDown")).toBe(300 - SIDEBAR_WIDTH_PAGE_STEP);
  });

  it("jumps to the bounds on Home/End", () => {
    expect(stepWidth(300, "Home")).toBe(MIN_SIDEBAR_WIDTH);
    expect(stepWidth(300, "End")).toBe(MAX_SIDEBAR_WIDTH);
  });

  it("stops at the bounds rather than running past them", () => {
    expect(stepWidth(MAX_SIDEBAR_WIDTH, "ArrowRight")).toBe(MAX_SIDEBAR_WIDTH);
    expect(stepWidth(MIN_SIDEBAR_WIDTH, "ArrowLeft")).toBe(MIN_SIDEBAR_WIDTH);
  });

  it("is null for a key it does not own, so the event keeps bubbling", () => {
    expect(stepWidth(300, "Enter")).toBeNull();
    expect(stepWidth(300, "a")).toBeNull();
  });

  it("is null when there is no current width to step from", () => {
    expect(stepWidth(null, "ArrowRight")).toBeNull();
  });
});
