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

describe("marking read: membership and badges (PR-VB4)", () => {
  const { survivesFilter } = require("./filter-cache.js");
  const { tabCounts } = require("./tree-counts.js");

  it("drops the post out of Unread, keeps it in Read, and moves the badges", () => {
    const bm = { id: 1, read: false, favorite: false };
    const counts = { total: 5, unread: 3, favorite: 1 };
    expect(survivesFilter("unread", bm)).toBe(true);
    expect(tabCounts(counts)).toEqual({ unread: 3, read: 2, all: 5, favorite: 1 });

    // What setRead does to the shared state; the slide-out is presentation.
    bm.read = true;
    counts.unread -= 1;

    expect(survivesFilter("unread", bm)).toBe(false); // the card leaves the view
    expect(survivesFilter("read", bm)).toBe(true); // and joins the Read tab
    expect(tabCounts(counts)).toEqual({ unread: 2, read: 3, all: 5, favorite: 1 });
  });

  it("leaves a starred post in the Favorites tab when it is read", () => {
    const bm = { id: 2, read: true, favorite: true };
    expect(survivesFilter("favorite", bm)).toBe(true);
  });
});
