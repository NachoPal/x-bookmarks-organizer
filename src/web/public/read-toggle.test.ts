import { describe, expect, it } from "vitest";

// Plain browser JS, required directly (not compiled by tsc).
const { readToggleLabel, readExitDirection, exitTranslate } = require("./read-toggle.js");

describe("readToggleLabel", () => {
  it("labels the action for an unread post: mark it read", () => {
    expect(readToggleLabel(false)).toBe("Mark as read");
  });

  it("labels a read post with its state, not a second action label", () => {
    expect(readToggleLabel(true)).toBe("Read");
  });
});

describe("marking read: membership and badges (#95)", () => {
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

describe("the exit is direction-aware (#99)", () => {
  it("sends a post marked read towards the Read tab, on its right", () => {
    expect(readExitDirection(true)).toBe("right");
  });

  it("sends a post marked unread back the way it came, to the left", () => {
    expect(readExitDirection(false)).toBe("left");
  });

  it("signs the travel to match the direction", () => {
    expect(exitTranslate("right", "22%")).toBe("translateX(22%)");
    expect(exitTranslate("left", "22%")).toBe("translateX(-22%)");
  });

  it("keeps the original rightward dismissal for any other exit", () => {
    // Un-starring in Favorites has no neighbouring tab to move towards.
    expect(exitTranslate(undefined, "22%")).toBe("translateX(22%)");
  });

  it("carries the post between the tabs it names", () => {
    const { survivesFilter } = require("./filter-cache.js");
    const bm = { id: 3, read: false, favorite: false };

    bm.read = true;
    expect(survivesFilter("unread", bm)).toBe(false);
    expect(readExitDirection(bm.read)).toBe("right"); // leaves Unread, joins Read

    bm.read = false;
    expect(survivesFilter("read", bm)).toBe(false);
    expect(readExitDirection(bm.read)).toBe("left"); // leaves Read, back to Unread
  });
});
