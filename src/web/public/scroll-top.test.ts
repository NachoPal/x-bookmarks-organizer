import { describe, expect, it } from "vitest";

// Plain browser JS, required directly (not compiled by tsc).
const { SHOW_AT, HIDE_AT, nextVisible, scrollBehavior } = require("./scroll-top.js");

describe("nextVisible", () => {
  it("stays hidden at the top of the list", () => {
    expect(nextVisible(0, false)).toBe(false);
  });

  it("appears once the list has genuinely been scrolled", () => {
    expect(nextVisible(SHOW_AT + 1, false)).toBe(true);
  });

  it("does not appear on a nudge short of the threshold", () => {
    expect(nextVisible(SHOW_AT - 1, false)).toBe(false);
  });

  it("stays put in the band between the two thresholds (no flicker)", () => {
    const between = (SHOW_AT + HIDE_AT) / 2;
    expect(HIDE_AT).toBeLessThan(SHOW_AT); // the hysteresis itself
    expect(nextVisible(between, true)).toBe(true); // shown: stays shown
    expect(nextVisible(between, false)).toBe(false); // hidden: stays hidden
  });

  it("hides again once the owner is back near the top", () => {
    expect(nextVisible(HIDE_AT - 1, true)).toBe(false);
  });

  it("hides for a pane with no usable scroll position", () => {
    expect(nextVisible(Number.NaN, true)).toBe(false);
    expect(nextVisible(undefined, true)).toBe(false);
  });
});

describe("scrollBehavior", () => {
  it("animates the travel by default", () => {
    expect(scrollBehavior(false)).toBe("smooth");
  });

  it("jumps instead of animating under reduced motion - the jump still happens", () => {
    expect(scrollBehavior(true)).toBe("auto");
  });
});
