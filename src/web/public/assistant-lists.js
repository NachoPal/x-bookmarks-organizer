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

  /** The sidebar row's second line: "12 posts · 5 min ago". */
  function itemMeta(list, now) {
    const when = relativeTime(list.createdAt, now);
    return when ? `${postCount(list.count)} · ${when}` : postCount(list.count);
  }

  /** The open list's line under the note. */
  function headerMeta(list, now) {
    const when = relativeTime(list.createdAt, now);
    return when ? `${postCount(list.count)} · sent ${when}` : postCount(list.count);
  }

  /** The toast that announces a list the moment it arrives. */
  function arrivalMessage(list) {
    return `Your assistant sent ${postCount(list.count)}: ${list.title}`;
  }

  /** The row's accessible name: title first, then what the meta line says. */
  function itemLabel(list, now, isNew) {
    return `${list.title}, ${itemMeta(list, now)}${isNew ? ", new" : ""}`;
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
    itemMeta,
    itemLabel,
    headerMeta,
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
