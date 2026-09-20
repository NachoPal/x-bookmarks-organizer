import { describe, expect, it } from "vitest";

// Plain browser JS, required directly (not compiled by tsc).
const { readCollapsed, writeCollapsed } = require("./sidebar-state.js");

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

describe("sidebar open/close persistence", () => {
  it("starts closed when nothing is stored, so the first view is the content", () => {
    expect(readCollapsed(fakeStorage())).toBe(true);
  });

  it("round-trips an open drawer", () => {
    const storage = fakeStorage();
    writeCollapsed(storage, false);
    expect(readCollapsed(storage)).toBe(false);
  });

  it("round-trips a closed drawer", () => {
    const storage = fakeStorage();
    writeCollapsed(storage, true);
    expect(readCollapsed(storage)).toBe(true);
  });

  it("survives a toggle round trip", () => {
    const storage = fakeStorage();
    writeCollapsed(storage, false);
    writeCollapsed(storage, true);
    writeCollapsed(storage, false);
    expect(readCollapsed(storage)).toBe(false);
  });

  it("treats an unrecognized stored value as closed", () => {
    const storage = fakeStorage();
    storage.setItem("xbo:sidebar-collapsed", "maybe");
    expect(readCollapsed(storage)).toBe(true);
  });

  it("starts closed when storage throws on read", () => {
    expect(readCollapsed(throwingStorage())).toBe(true);
  });

  it("does not throw when storage throws on write", () => {
    expect(() => writeCollapsed(throwingStorage(), false)).not.toThrow();
  });
});
