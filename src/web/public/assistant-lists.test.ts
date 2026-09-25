import { describe, expect, it } from "vitest";

// Plain browser JS, required directly (not compiled by tsc).
const lists = require("./assistant-lists.js");

function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  } as unknown as Storage;
}

const throwing = {
  getItem() {
    throw new Error("blocked");
  },
  setItem() {
    throw new Error("blocked");
  },
  removeItem() {
    throw new Error("blocked");
  },
} as unknown as Storage;

const NOW = Date.parse("2026-09-25T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const list = (id: number, createdAt: string, count = 3, title = `List ${id}`) => ({
  id,
  title,
  note: null,
  createdAt,
  count,
});

describe("XBOAssistantLists", () => {
  it("counts posts in words", () => {
    expect(lists.postCount(1)).toBe("1 post");
    expect(lists.postCount(0)).toBe("0 posts");
    expect(lists.postCount(12)).toBe("12 posts");
  });

  it("says when a list arrived, coarsely", () => {
    expect(lists.relativeTime(ago(10_000), NOW)).toBe("just now");
    expect(lists.relativeTime(ago(5 * 60_000), NOW)).toBe("5 min ago");
    expect(lists.relativeTime(ago(3 * 3_600_000), NOW)).toBe("3 h ago");
    expect(lists.relativeTime(ago(30 * 3_600_000), NOW)).toBe("yesterday");
    expect(lists.relativeTime(ago(4 * 86_400_000), NOW)).toBe("4 days ago");
    expect(lists.relativeTime(ago(40 * 86_400_000), NOW)).toMatch(/2026/);
    // A clock slightly ahead of the server is still "just now", never negative.
    expect(lists.relativeTime(ago(-5_000), NOW)).toBe("just now");
    expect(lists.relativeTime("garbage", NOW)).toBe("");
  });

  it("words the toast and the row, whose name says what its count badges show", () => {
    const eval12 = list(7, ago(5 * 60_000), 12, "Eval harnesses");
    expect(lists.arrivalMessage(eval12)).toBe("Your assistant sent 12 posts: Eval harnesses");
    expect(lists.itemLabel(eval12, true)).toBe("Eval harnesses, 12 posts, new");
    expect(lists.itemLabel({ ...eval12, unread: 4 }, false)).toBe("Eval harnesses, 12 posts, 4 unread");
    expect(lists.unreadCount({ ...eval12, unread: 4 })).toBe(4);
    expect(lists.unreadCount(eval12)).toBe(0); // a server that sent no `unread`
  });

  it("tells the info button's note, count and sent time, relative and absolute", () => {
    const at = ago(2 * 3_600_000);
    const absolute = new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    const noted = { ...list(7, at, 6, "Evals"), note: "Why these", unread: 2 };
    expect(lists.infoLines(noted, NOW)).toEqual({
      note: "Why these",
      posts: "6 posts, 2 unread",
      sent: `Sent 2 h ago · ${absolute}`,
    });
    expect(lists.infoDescription(noted, NOW)).toBe(`Why these. 6 posts, 2 unread. Sent 2 h ago · ${absolute}.`);
    // A note that already ends a sentence gets no second stop.
    expect(lists.infoDescription({ ...noted, note: "Short ones." }, NOW)).toMatch(/^Short ones\. 6 posts/);
    // No note, nothing unread: just what there is.
    expect(lists.infoLines(list(8, at, 1), NOW)).toMatchObject({ note: null, posts: "1 post" });
    // Past a week the relative time IS a date, so it is not said twice.
    const old = ago(40 * 86_400_000);
    const oldAbsolute = new Date(old).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    expect(lists.infoLines(list(9, old, 1), NOW).sent).toBe(`Sent ${oldAbsolute}`);
  });

  it("keeps the index newest first, replacing a list by id", () => {
    const older = list(1, ago(3_600_000));
    const newer = list(2, ago(60_000));
    const index = lists.upsert([older], newer);
    expect(index.map((l: { id: number }) => l.id)).toEqual([2, 1]);
    const updated = lists.upsert(index, { ...older, count: 9 });
    expect(updated.map((l: { id: number; count: number }) => [l.id, l.count])).toEqual([
      [2, 3],
      [1, 9],
    ]);
    // Same timestamp: the higher id (created later) leads.
    const tie = lists.upsert([list(3, older.createdAt)], older);
    expect(tie.map((l: { id: number }) => l.id)).toEqual([3, 1]);
    expect(index).toHaveLength(2); // inputs untouched
  });

  it("sorts an index newest first without touching its input", () => {
    const input = [list(1, ago(3_600_000)), list(2, ago(0)), list(3, ago(3_600_000))];
    expect(lists.sorted(input).map((l: { id: number }) => l.id)).toEqual([2, 3, 1]);
    expect(input.map((l) => l.id)).toEqual([1, 2, 3]);
  });

  it("hides lists whose delete is waiting out its undo window", () => {
    const index = [list(1, ago(0)), list(2, ago(0))];
    expect(lists.visible(index, new Set([1])).map((l: { id: number }) => l.id)).toEqual([2]);
  });

  it("persists the open list, guarded", () => {
    const storage = fakeStorage();
    expect(lists.readOpenList(storage)).toBeNull();
    lists.writeOpenList(storage, 42);
    expect(lists.readOpenList(storage)).toBe(42);
    lists.writeOpenList(storage, null);
    expect(lists.readOpenList(storage)).toBeNull();
    storage.setItem("xbo:assistant-list", "nope");
    expect(lists.readOpenList(storage)).toBeNull();

    expect(lists.readOpenList(throwing)).toBeNull();
    expect(() => lists.writeOpenList(throwing, 1)).not.toThrow();
  });
});
