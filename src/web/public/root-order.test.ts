import { describe, expect, it } from "vitest";

const { moveBy, moveTo, dropIndex, sameOrder } = require("./root-order.js");

describe("root-order", () => {
  it("moves one step and clamps at the ends", () => {
    expect(moveBy([1, 2, 3], 2, -1)).toEqual([2, 1, 3]);
    expect(moveBy([1, 2, 3], 2, 1)).toEqual([1, 3, 2]);
    expect(moveBy([1, 2, 3], 1, -1)).toEqual([1, 2, 3]);
    expect(moveBy([1, 2, 3], 3, 1)).toEqual([1, 2, 3]);
  });

  it("moves to an index without mutating the input", () => {
    const ids = [1, 2, 3, 4];
    expect(moveTo(ids, 1, 3)).toEqual([2, 3, 4, 1]);
    expect(moveTo(ids, 4, 0)).toEqual([4, 1, 2, 3]);
    expect(ids).toEqual([1, 2, 3, 4]);
  });

  it("ignores an unknown id", () => {
    expect(moveBy([1, 2], 9, 1)).toEqual([1, 2]);
    expect(moveTo([1, 2], 9, 0)).toEqual([1, 2]);
  });

  it("computes the drop index from the other items' midpoints", () => {
    expect(dropIndex([10, 30, 50], 5)).toBe(0);
    expect(dropIndex([10, 30, 50], 35)).toBe(2);
    expect(dropIndex([10, 30, 50], 99)).toBe(3);
    expect(dropIndex([], 5)).toBe(0);
  });

  it("compares orders", () => {
    expect(sameOrder([1, 2], [1, 2])).toBe(true);
    expect(sameOrder([1, 2], [2, 1])).toBe(false);
  });
});
