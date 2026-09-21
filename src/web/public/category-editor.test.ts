import { describe, expect, it } from "vitest";

// Plain browser JS, required directly (not compiled by tsc).
const {
  SKIP_CONFIRM_KEY,
  readSkipConfirm,
  writeSkipConfirm,
  siblingsOf,
  validateName,
  needsConfirm,
  confirmSentence,
  confirmDetail,
  confirmLabel,
  deletedSummary,
  selectionSurvives,
} = require("./category-editor.js");

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

const tree = [
  {
    id: 1,
    parentId: null,
    name: "AI",
    children: [
      { id: 2, parentId: 1, name: "Evals", children: [{ id: 3, parentId: 2, name: "Harnesses", children: [] }] },
      { id: 4, parentId: 1, name: "Agents", children: [] },
    ],
  },
  { id: 5, parentId: null, name: "Game Dev", children: [] },
];

describe("siblingsOf", () => {
  it("returns the roots for a null parent", () => {
    expect(siblingsOf(tree, null).map((n: { name: string }) => n.name)).toEqual(["AI", "Game Dev"]);
  });

  it("returns the children of a nested parent", () => {
    expect(siblingsOf(tree, 1).map((n: { name: string }) => n.name)).toEqual(["Evals", "Agents"]);
    expect(siblingsOf(tree, 2).map((n: { name: string }) => n.name)).toEqual(["Harnesses"]);
  });

  it("returns an empty list for a leaf or an unknown parent", () => {
    expect(siblingsOf(tree, 3)).toEqual([]);
    expect(siblingsOf(tree, 999)).toEqual([]);
    expect(siblingsOf(undefined, null)).toEqual([]);
  });
});

describe("validateName", () => {
  it("trims and accepts a fresh name", () => {
    expect(validateName("  Rust  ", siblingsOf(tree, null))).toEqual({ ok: true, name: "Rust" });
  });

  it("rejects an empty or whitespace-only name", () => {
    expect(validateName("", []).ok).toBe(false);
    expect(validateName("   ", []).error).toBe("Give the category a name.");
    expect(validateName(null, []).ok).toBe(false);
  });

  it("rejects a duplicate sibling, case-insensitively, and names the clash", () => {
    const result = validateName("ai", siblingsOf(tree, null));
    expect(result.ok).toBe(false);
    // The EXISTING spelling is quoted, so the owner sees what is already there.
    expect(result.error).toContain("“AI”");
  });

  it("allows a name that is taken under a different parent", () => {
    expect(validateName("Evals", siblingsOf(tree, 5)).ok).toBe(true);
  });
});

describe("needsConfirm", () => {
  it("always confirms a ROOT delete, even with 'don't ask again' on", () => {
    expect(needsConfirm({ id: 1, parentId: null }, true)).toBe(true);
  });

  it("confirms a child delete by default", () => {
    expect(needsConfirm({ id: 2, parentId: 1 }, false)).toBe(true);
  });

  it("skips a child delete once 'don't ask again' is on", () => {
    expect(needsConfirm({ id: 2, parentId: 1 }, true)).toBe(false);
  });

  it("fails closed on a node it knows nothing about", () => {
    expect(needsConfirm(null, true)).toBe(true);
    expect(needsConfirm(undefined, true)).toBe(true);
  });
});

describe("the 'don't ask again' preference", () => {
  it("defaults to OFF, so a delete confirms until the owner says otherwise", () => {
    expect(readSkipConfirm(fakeStorage())).toBe(false);
  });

  it("round-trips and clears", () => {
    const storage = fakeStorage();
    writeSkipConfirm(storage, true);
    expect(storage.getItem(SKIP_CONFIRM_KEY)).toBe("1");
    expect(readSkipConfirm(storage)).toBe(true);
    writeSkipConfirm(storage, false);
    expect(readSkipConfirm(storage)).toBe(false);
  });

  it("fails SAFE when storage throws: it keeps confirming and does not blow up", () => {
    const storage = throwingStorage();
    expect(readSkipConfirm(storage)).toBe(false);
    expect(() => writeSkipConfirm(storage, true)).not.toThrow();
    expect(readSkipConfirm(storage)).toBe(false);
  });
});

describe("the destructive confirmation's prose", () => {
  it("states a leaf delete with no posts", () => {
    expect(confirmSentence("Harnesses", { categories: 1, subcategories: 0, posts: 0 })).toBe(
      "Deleting “Harnesses” removes it. No posts are deleted.",
    );
  });

  it("counts sub-categories and posts, singular and plural", () => {
    expect(confirmSentence("AI", { categories: 2, subcategories: 1, posts: 1 })).toBe(
      "Deleting “AI” removes it and 1 sub-category, and permanently deletes 1 post.",
    );
    expect(confirmSentence("AI", { categories: 4, subcategories: 3, posts: 12 })).toBe(
      "Deleting “AI” removes it and 3 sub-categories, and permanently deletes 12 posts.",
    );
  });

  it("explains that only orphaned posts go", () => {
    expect(confirmDetail({ posts: 3 })).toContain("filed nowhere else");
    expect(confirmDetail({ posts: 3 })).toContain("cannot be undone");
    expect(confirmDetail({ posts: 0 })).toContain("none are deleted");
  });

  it("restates the scope on the destructive button", () => {
    expect(confirmLabel({ posts: 0 })).toBe("Delete category");
    expect(confirmLabel({ posts: 1 })).toBe("Delete and remove 1 post");
    expect(confirmLabel({ posts: 9 })).toBe("Delete and remove 9 posts");
  });

  it("never guesses: a missing preview reads as the smallest possible delete", () => {
    expect(confirmSentence("X", undefined)).toBe("Deleting “X” removes it. No posts are deleted.");
    expect(confirmLabel(undefined)).toBe("Delete category");
  });
});

describe("deletedSummary", () => {
  it("reports what actually went", () => {
    expect(deletedSummary("Harnesses", { categories: 1, subcategories: 0, posts: 0 })).toBe(
      "Deleted “Harnesses”.",
    );
    expect(deletedSummary("AI", { categories: 3, subcategories: 2, posts: 5 })).toBe(
      "Deleted “AI” and 2 sub-categories, and 5 posts.",
    );
    expect(deletedSummary("AI", { categories: 2, subcategories: 1, posts: 1 })).toBe(
      "Deleted “AI” and 1 sub-category, and 1 post.",
    );
  });
});

describe("selectionSurvives", () => {
  it("is true when nothing is selected", () => {
    expect(selectionSurvives(null, [1, 2])).toBe(true);
  });

  it("is false when the open category was in the deleted subtree", () => {
    expect(selectionSurvives(2, [1, 2, 3])).toBe(false);
  });

  it("is true when the open category was untouched", () => {
    expect(selectionSurvives(5, [1, 2, 3])).toBe(true);
    expect(selectionSurvives(5, undefined)).toBe(true);
  });
});
