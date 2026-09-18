import { describe, expect, it } from "vitest";

// Plain browser JS, required directly (not compiled by tsc).
const { readToggleLabel } = require("./read-toggle.js");

describe("readToggleLabel", () => {
  it("labels the action for an unread post: mark it read", () => {
    expect(readToggleLabel(false)).toBe("Mark as read");
  });

  it("labels a read post with its state, not a second action label", () => {
    expect(readToggleLabel(true)).toBe("Read");
  });
});
