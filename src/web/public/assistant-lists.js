"use strict";

/**
 * Pure, DOM-free half of the sidebar's "Lists" page: the result lists an AI
 * assistant sends with the MCP tool `show_in_app`. app.js owns the
 * markup; this owns the words, the ordering, the filter, the reorder
 * arithmetic and the guarded persistence, in the same style as
 * view-persist.js / sidebar-state.js / tree-move.js.
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

  /**
   * Add or replace `list` by id. A list already here keeps its place; one
   * that is not is new, and a new list always goes first (the server puts it
   * there too). Does not mutate `lists`.
   */
  function upsert(lists, list) {
    const at = lists.findIndex((l) => l.id === list.id);
    if (at === -1) return [list, ...lists];
    const out = lists.slice();
    out[at] = list;
    return out;
  }

  /**
   * A copy of `lists` in the Lists page's order: the owner's arrangement
   * (`position`, ascending), newest first among equals - exactly the
   * server's `ORDER BY`.
   */
  function sorted(lists) {
    return lists.slice().sort(byPlace);
  }

  function byPlace(a, b) {
    const pa = Number.isFinite(a.position) ? a.position : 0;
    const pb = Number.isFinite(b.position) ? b.position : 0;
    if (pa !== pb) return pa - pb;
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    return b.id - a.id;
  }

  /** The filter's query as it is matched: trimmed and lowercased. */
  function normalizeQuery(query) {
    return String(query || "").trim().toLowerCase();
  }

  /** Whether a list's title - or the assistant's note about it - contains the query. */
  function matches(list, query) {
    const q = normalizeQuery(query);
    if (!q) return true;
    return String(list.title || "").toLowerCase().includes(q) || String(list.note || "").toLowerCase().includes(q);
  }

  /** The lists the Lists page's filter lets through, in order. */
  function filter(lists, query) {
    return lists.filter((l) => matches(l, query));
  }

  /** The empty state of a filter that matched nothing. */
  function noMatchMessage(query) {
    return `No lists match “${String(query || "").trim()}”.`;
  }

  // ---- reordering ---------------------------------------------------------
  // A move is `{ beforeId }`: the list it goes just before, or null for last -
  // exactly the body of `PUT /api/assistant-lists/:id/position`. `lists` is
  // EVERY list in order (a list hidden while its delete waits out Undo
  // included); the rows on screen can be fewer, which is why the targets are
  // worked out against the whole order rather than a row index.

  /** The place `id` is in now, as a target - taken before a move, it is what Undo sends. */
  function currentPlace(lists, id) {
    const at = lists.findIndex((l) => l.id === id);
    if (at === -1) return null;
    const next = lists[at + 1];
    return { beforeId: next ? next.id : null };
  }

  /** Whether the target would leave `id` exactly where it is. */
  function isNoOp(lists, id, target) {
    const here = currentPlace(lists, id);
    if (!here || !target) return true;
    return target.beforeId === id || target.beforeId === here.beforeId;
  }

  /** Which half of a row the pointer is over: the top half drops before it, the bottom half after. */
  function dropZone(top, rowHeight, pointerY) {
    return rowHeight > 0 && pointerY - top > rowHeight / 2 ? "after" : "before";
  }

  /** The target a drop before or after row `overId` means for dragged `id`, or null (itself, or gone). */
  function dropTarget(lists, id, overId, zone) {
    if (overId === id) return null;
    const rest = lists.filter((l) => l.id !== id);
    const at = rest.findIndex((l) => l.id === overId);
    if (at === -1) return null;
    if (zone === "before") return { beforeId: overId };
    const next = rest[at + 1];
    return { beforeId: next ? next.id : null };
  }

  /**
   * What Up or Down on a focused handle does: one step past the neighbouring
   * row on screen (`shown`), or null at either end.
   */
  function keyboardTarget(lists, shown, id, key) {
    const at = shown.findIndex((l) => l.id === id);
    if (at === -1) return null;
    if (key === "ArrowUp") return at > 0 ? dropTarget(lists, id, shown[at - 1].id, "before") : null;
    if (key === "ArrowDown") return at < shown.length - 1 ? dropTarget(lists, id, shown[at + 1].id, "after") : null;
    return null;
  }

  /** Why an arrow key went nowhere, in words the announcer can say. */
  function keyboardEdge(list, key) {
    return `“${list.title}” is already ${key === "ArrowUp" ? "first" : "last"}.`;
  }

  /** Where a list is on the page, in words: "2 of 5". */
  function placeLabel(shown, id) {
    const at = shown.findIndex((l) => l.id === id);
    return at === -1 ? "" : `${at + 1} of ${shown.length}`;
  }

  /** The handle's tooltip: how to use it - or, while a filter narrows the page, why it cannot be. */
  function gripHint(filtering) {
    return filtering ? "Clear the filter to reorder lists" : "Drag to reorder, or press Up or Down";
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
    matches,
    filter,
    noMatchMessage,
    currentPlace,
    isNoOp,
    dropZone,
    dropTarget,
    keyboardTarget,
    keyboardEdge,
    placeLabel,
    gripHint,
    visible,
    readOpenList,
    writeOpenList,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.XBOAssistantLists = api;
})(typeof window !== "undefined" ? window : globalThis);
