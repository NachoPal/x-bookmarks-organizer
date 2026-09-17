import { describe, expect, it } from "vitest";

// Plain browser JS, required directly (not compiled by tsc).
const { readStoredTheme, writeTheme, effectiveTheme } = require("./theme.js");

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

describe("theme preference persistence", () => {
  it("has no stored preference by default", () => {
    expect(readStoredTheme(fakeStorage())).toBeNull();
  });

  it("round-trips a stored light preference", () => {
    const storage = fakeStorage();
    writeTheme(storage, "light");
    expect(readStoredTheme(storage)).toBe("light");
  });

  it("round-trips a stored dark preference", () => {
    const storage = fakeStorage();
    writeTheme(storage, "dark");
    expect(readStoredTheme(storage)).toBe("dark");
  });

  it("falls back to no preference when storage throws on read", () => {
    expect(readStoredTheme(throwingStorage())).toBeNull();
  });

  it("does not throw when storage throws on write", () => {
    expect(() => writeTheme(throwingStorage(), "dark")).not.toThrow();
  });
});

describe("effectiveTheme", () => {
  it("follows the system theme when nothing is stored", () => {
    expect(effectiveTheme(fakeStorage(), true)).toBe("dark");
    expect(effectiveTheme(fakeStorage(), false)).toBe("light");
  });

  it("overrides the system theme once a preference is stored", () => {
    const storage = fakeStorage();
    writeTheme(storage, "dark");
    expect(effectiveTheme(storage, false)).toBe("dark");

    writeTheme(storage, "light");
    expect(effectiveTheme(storage, true)).toBe("light");
  });

  it("follows the system theme when storage is unavailable", () => {
    expect(effectiveTheme(throwingStorage(), true)).toBe("dark");
  });
});
