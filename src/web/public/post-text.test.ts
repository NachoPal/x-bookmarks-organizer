import { describe, expect, it } from "vitest";

// Plain browser JS, required directly (not compiled by tsc).
const { isLongPostText, CLAMPED_LINES } = require("./post-text.js");

describe("isLongPostText", () => {
  it("is false for empty or whitespace-only text", () => {
    expect(isLongPostText("")).toBe(false);
    expect(isLongPostText("   \n  ")).toBe(false);
    expect(isLongPostText(undefined)).toBe(false);
    expect(isLongPostText(null)).toBe(false);
  });

  it("is false for a short one-line post", () => {
    expect(isLongPostText("Just shipped a small fix, feels good.")).toBe(false);
  });

  it("is true once text passes the character threshold", () => {
    const long = "a".repeat(281);
    expect(isLongPostText(long)).toBe(true);
  });

  it("is false right at and below the character threshold", () => {
    expect(isLongPostText("a".repeat(280))).toBe(false);
  });

  it("is true for many short lines even under the character threshold", () => {
    const manyLines = Array.from({ length: CLAMPED_LINES + 1 }, (_, i) => `line ${i}`).join("\n");
    expect(isLongPostText(manyLines)).toBe(true);
  });

  it("is false for a few short lines under both thresholds", () => {
    expect(isLongPostText("line one\nline two")).toBe(false);
  });
});
