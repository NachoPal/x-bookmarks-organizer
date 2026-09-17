import { describe, expect, it } from "vitest";

// Plain browser JS, required directly (not compiled by tsc).
const { ROOT_HUES, rootCategoryHue } = require("./tree-color.js");

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
