import { describe, expect, it } from "vitest";

// Plain browser JS, required directly (not compiled by tsc).
const { SLOP_PX, passedSlop, gestureOutcome } = require("./card-drag.js");

describe("passedSlop - the press/drag boundary (issue #100)", () => {
  const origin = { x: 100, y: 100 };

  it("a finger that has not moved is still a press", () => {
    expect(passedSlop(origin, { x: 100, y: 100 })).toBe(false);
  });

  it("a tap's incidental jitter stays a press - the drawer must not open", () => {
    expect(passedSlop(origin, { x: 100 + SLOP_PX, y: 100 + SLOP_PX })).toBe(false);
  });

  it("travel past the slop on either axis is a drag", () => {
    expect(passedSlop(origin, { x: 100 + SLOP_PX + 1, y: 100 })).toBe(true);
    expect(passedSlop(origin, { x: 100, y: 100 + SLOP_PX + 1 })).toBe(true);
  });

  it("measures distance, not direction", () => {
    expect(passedSlop(origin, { x: 100 - SLOP_PX - 1, y: 100 })).toBe(true);
    expect(passedSlop(origin, { x: 100, y: 100 - SLOP_PX - 1 })).toBe(true);
  });

  it("honours an explicit slop", () => {
    expect(passedSlop(origin, { x: 140, y: 100 }, 50)).toBe(false);
    expect(passedSlop(origin, { x: 160, y: 100 }, 50)).toBe(true);
  });

  it("an unmeasurable gesture stays a press - the harmless outcome", () => {
    expect(passedSlop(origin, { x: Number.NaN, y: 100 })).toBe(false);
    expect(passedSlop(origin, null)).toBe(false);
    expect(passedSlop(null, { x: 500, y: 500 })).toBe(false);
  });
});

describe("gestureOutcome", () => {
  it("a press that never became a drag opens the picker", () => {
    expect(gestureOutcome({ started: false, cancelled: false, targetId: null })).toBe("picker");
  });

  it("a drag dropped on a category re-files the post", () => {
    expect(gestureOutcome({ started: true, cancelled: false, targetId: 7 })).toBe("move");
  });

  it("a drag released off the tree does nothing", () => {
    expect(gestureOutcome({ started: true, cancelled: false, targetId: null })).toBe("none");
  });

  it("Escape or pointercancel does nothing, drag or not", () => {
    expect(gestureOutcome({ started: true, cancelled: true, targetId: 7 })).toBe("none");
    expect(gestureOutcome({ started: false, cancelled: true, targetId: null })).toBe("none");
  });

  it("a category id of 0 is a real target, not an absent one", () => {
    expect(gestureOutcome({ started: true, cancelled: false, targetId: 0 })).toBe("move");
  });
});
