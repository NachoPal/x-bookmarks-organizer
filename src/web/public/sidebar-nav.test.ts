import { describe, expect, it } from "vitest";

// Plain browser JS, required directly (not compiled by tsc).
const nav = require("./sidebar-nav.js");

function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
    key: () => null,
    get length() {
      return map.size;
    },
  } as Storage;
}

const throwing = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("blocked");
  },
} as unknown as Storage;

describe("XBOSidebarNav", () => {
  it("persists the open page, guarded, defaulting to the menu", () => {
    const storage = fakeStorage();
    expect(nav.readPage(storage)).toBe("root");
    nav.writePage(storage, "lists");
    expect(nav.readPage(storage)).toBe("lists");
    nav.writePage(storage, "nowhere"); // not a page: ignored
    expect(nav.readPage(storage)).toBe("lists");
    storage.setItem(nav.PAGE_KEY, "junk");
    expect(nav.readPage(storage)).toBe("root");
    expect(nav.readPage(throwing)).toBe("root");
    expect(() => nav.writePage(throwing, "categories")).not.toThrow();
  });

  it("counts unviewed lists, leaving out the ones waiting on a delete's undo", () => {
    const lists = [
      { id: 1, viewed: false },
      { id: 2, viewed: true },
      { id: 3, viewed: false },
    ];
    expect(nav.unviewedCount(lists)).toBe(2);
    expect(nav.unviewedCount(lists, new Set([3]))).toBe(1);
    expect(nav.unviewedCount([])).toBe(0);
  });

  it("words the rows and the Back control", () => {
    expect(nav.categoriesMeta(null)).toBe("Loading…");
    expect(nav.categoriesMeta(null, true)).toBe("Couldn't load");
    expect(nav.categoriesMeta(0)).toBe("None yet");
    expect(nav.categoriesMeta(1)).toBe("1 category");
    expect(nav.categoriesMeta(12)).toBe("12 categories");
    expect(nav.listsMeta(0)).toBe("None yet");
    expect(nav.listsMeta(1)).toBe("1 list");
    expect(nav.listsRowLabel(3, 0)).toBe("Lists, 3 lists");
    expect(nav.listsRowLabel(3, 2)).toBe("Lists, 3 lists, 2 new");
    expect(nav.listsRowLabel(0, 0)).toBe("Lists, none yet");
    expect(nav.backLabel(0)).toBe("Back to the menu");
    expect(nav.backLabel(1)).toBe("Back to the menu, 1 new list");
    expect(nav.backLabel(4)).toBe("Back to the menu, 4 new lists");
  });
});
