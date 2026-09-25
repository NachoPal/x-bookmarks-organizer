"use strict";

/**
 * Pure, DOM-free half of the sidebar's "Lists" page: the result lists an AI
 * assistant sends with the MCP tool `show_in_app`. app.js owns the
 * markup; this owns the words, the ordering and the guarded persistence, in
 * the same style as view-persist.js / sidebar-state.js.
 *
 * A list's title and note are an assistant's words, so app.js only ever sets
 * them as `textContent`. Nothing here builds markup from them.
 */
(function (root) {
  const OPEN_LIST_KEY = "xbo:assistant-list";
  /** How long the "your assistant sent…" toast stays: long enough to reach for Open. */
  const ARRIVAL_TOAST_MS = 12000;

  function postCount(n) {
    return `${n} post${n === 1 ? "" : "s"}`;
  }

  /** "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago", else the date. */
  function relativeTime(iso, now) {
    const then = new Date(iso).getTime();
    if (!Number.isFinite(then)) return "";
    const seconds = Math.max(0, Math.round((now - then) / 1000));
    if (seconds < 60) return "just now";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} h ago`;
    const days = Math.floor(hours / 24);
    if (days === 1) return "yesterday";
    if (days < 7) return `${days} days ago`;
    return new Date(then).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  /** Unread posts, from the server's count (a list read before `unread` existed counts none). */
  function unreadCount(list) {
    return Number.isInteger(list.unread) && list.unread > 0 ? list.unread : 0;
  }

  /**
   * When the list was sent, both ways: `relative` ("2 h ago") and `absolute`
   * (the local date and time). Past a week `relativeTime` is already a date,
   * so `relative` is empty rather than saying the date twice.
   */
  function sentAt(list, now) {
    const then = new Date(list.createdAt);
    if (!Number.isFinite(then.getTime())) return null;
    const relative = relativeTime(list.createdAt, now);
    const absolute = then.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    const recent = now - then.getTime() < 7 * 24 * 60 * 60 * 1000;
    return { relative: recent ? relative : "", absolute };
  }

  /**
   * What the info button tells about a list, one line each: the assistant's
   * note (null when it left none), how many posts it holds, and when it was
   * sent. The popover draws these; `infoDescription` says them to a screen
   * reader, so the two can never disagree.
   */
  function infoLines(list, now) {
    const when = sentAt(list, now);
    const unread = unreadCount(list);
    return {
      note: list.note ? list.note : null,
      posts: unread > 0 ? `${postCount(list.count)}, ${unread} unread` : postCount(list.count),
      sent: when ? (when.relative ? `Sent ${when.relative} · ${when.absolute}` : `Sent ${when.absolute}`) : null,
    };
  }

  /** The info button's description: the same lines, as prose. */
  function infoDescription(list, now) {
    const lines = infoLines(list, now);
    // A line that already ends a sentence (an assistant's note often does) gets no second stop.
    return [lines.note, lines.posts, lines.sent]
      .filter(Boolean)
      .map((line) => (/[.!?…]$/.test(line.trim()) ? line.trim() : `${line.trim()}.`))
      .join(" ");
  }

  /** The toast that announces a list the moment it arrives. */
  function arrivalMessage(list) {
    return `Your assistant sent ${postCount(list.count)}: ${list.title}`;
  }

  /** The row's accessible name: title first, then what its count badges say. */
  function itemLabel(list, isNew) {
    const unread = unreadCount(list);
    return `${list.title}, ${postCount(list.count)}${unread > 0 ? `, ${unread} unread` : ""}${isNew ? ", new" : ""}`;
  }

  /** The empty state of a list whose every post has since been deleted. */
  const EMPTY_LIST_MESSAGE = "Every post in this list has been deleted from your library.";

  /** Add or replace `list` by id, keeping the index newest first. Does not mutate `lists`. */
  function upsert(lists, list) {
    const rest = lists.filter((l) => l.id !== list.id);
    rest.push(list);
    return rest.sort(byNewest);
  }

  /** A copy of `lists`, newest first (ties: the later id). */
  function sorted(lists) {
    return lists.slice().sort(byNewest);
  }

  function byNewest(a, b) {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    return b.id - a.id;
  }

  /** The lists still visible while some deletes wait out their undo window. */
  function visible(lists, pendingIds) {
    return lists.filter((l) => !pendingIds.has(l.id));
  }

  /** The list open when the page was left, or null. */
  function readOpenList(storage) {
    try {
      const id = Number(storage.getItem(OPEN_LIST_KEY));
      return Number.isInteger(id) && id > 0 ? id : null;
    } catch (_) {
      return null;
    }
  }

  function writeOpenList(storage, id) {
    try {
      if (id == null) storage.removeItem(OPEN_LIST_KEY);
      else storage.setItem(OPEN_LIST_KEY, String(id));
    } catch (_) {
      /* private mode / blocked storage: ignore */
    }
  }

  const api = {
    ARRIVAL_TOAST_MS,
    EMPTY_LIST_MESSAGE,
    postCount,
    relativeTime,
    unreadCount,
    sentAt,
    infoLines,
    infoDescription,
    itemLabel,
    arrivalMessage,
    upsert,
    sorted,
    visible,
    readOpenList,
    writeOpenList,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.XBOAssistantLists = api;
})(typeof window !== "undefined" ? window : globalThis);
