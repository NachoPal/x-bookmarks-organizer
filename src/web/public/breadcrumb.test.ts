import { describe, expect, it } from "vitest";

// Plain browser JS, required directly (not compiled by tsc).
const { trail, layout, pathLabel, menuMove } = require("./breadcrumb.js");

/** Software (1) › Languages (2) › Rust (3) › Async (4); Design (5) alone. */
function index() {
  const nodes = [
    { id: 1, parentId: null, name: "Software" },
    { id: 2, parentId: 1, name: "Languages" },
    { id: 3, parentId: 2, name: "Rust" },
    { id: 4, parentId: 3, name: "Async" },
    { id: 5, parentId: null, name: "Design" },
  ];
  return new Map(nodes.map((n) => [n.id, n]));
}

describe("trail", () => {
  it("walks parentId up and returns the path root-first", () => {
    expect(trail(index(), 4).map((c: { name: string }) => c.name)).toEqual([
      "Software",
      "Languages",
      "Rust",
      "Async",
    ]);
  });

  it("is a single entry for a root", () => {
    expect(trail(index(), 5)).toEqual([{ id: 5, name: "Design" }]);
  });

  it("is empty for an unknown id, so a stale selection renders nothing", () => {
    expect(trail(index(), 99)).toEqual([]);
    expect(trail(new Map(), 1)).toEqual([]);
  });
});

describe("layout", () => {
  it("renders every segment inline while the path fits", () => {
    const segments = layout(trail(index(), 3));
    expect(segments.map((s: { kind: string }) => s.kind)).toEqual(["crumb", "crumb", "crumb"]);
    expect(segments.map((s: { name?: string }) => s.name)).toEqual(["Software", "Languages", "Rust"]);
  });

  it("marks only the last segment as the open category", () => {
    const segments = layout(trail(index(), 3));
    expect(segments.map((s: { current?: boolean }) => s.current)).toEqual([false, false, true]);
  });

  it("collapses the middle of a deep path and hands back what it hid", () => {
    const segments = layout(trail(index(), 4));
    expect(segments.map((s: { kind: string }) => s.kind)).toEqual(["crumb", "overflow", "crumb"]);
    expect(segments[0].name).toBe("Software");
    expect(segments[2].name).toBe("Async");
    // The hidden ancestors are real crumbs, so the menu renders them exactly
    // like the inline ones - each one clickable, none of them "current".
    expect(segments[1].items.map((s: { name: string }) => s.name)).toEqual(["Languages", "Rust"]);
    expect(segments[1].items.every((s: { current: boolean }) => !s.current)).toBe(true);
  });

  it("keeps every crumb clickable: each carries the id to select", () => {
    const segments = layout(trail(index(), 4));
    expect(segments[0].id).toBe(1);
    expect(segments[1].items.map((s: { id: number }) => s.id)).toEqual([2, 3]);
    expect(segments[2].id).toBe(4);
  });

  it("honors a tighter inline budget", () => {
    const segments = layout(trail(index(), 3), 2);
    expect(segments.map((s: { kind: string }) => s.kind)).toEqual(["crumb", "overflow", "crumb"]);
    expect(segments[1].items.map((s: { name: string }) => s.name)).toEqual(["Languages"]);
  });

  it("is empty for an empty path", () => {
    expect(layout([])).toEqual([]);
  });
});

describe("pathLabel", () => {
  it("joins the whole path for the bar's tooltip", () => {
    expect(pathLabel(trail(index(), 4))).toBe("Software › Languages › Rust › Async");
  });
});

describe("menuMove", () => {
  it("wraps in both directions", () => {
    expect(menuMove("ArrowDown", 2, 3)).toBe(0);
    expect(menuMove("ArrowUp", 0, 3)).toBe(2);
  });

  it("jumps to the ends", () => {
    expect(menuMove("Home", 2, 3)).toBe(0);
    expect(menuMove("End", 0, 3)).toBe(2);
  });

  it("returns null for anything else, so the key keeps its normal meaning", () => {
    expect(menuMove("Enter", 0, 3)).toBeNull();
    expect(menuMove("ArrowDown", 0, 0)).toBeNull();
  });
});
