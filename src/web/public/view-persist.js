"use strict";

/**
 * Pure, DOM-free persistence for the viewer's last view (issue #78), in the
 * same guarded-storage style as sort-order.js / sidebar-state.js.
 *
 * Two independent records:
 *  - the SELECTION (category + filter tab), in localStorage, so a reload or a
 *    new tab lands where the owner left off;
 *  - a bounded snapshot of the fetched bookmark DATA (category+filter views),
 *    in sessionStorage, so a reload restores the last view from it instead of
 *    re-fetching. It carries data only - X embeds always re-initialize on a
 *    fresh page load, that is X's widget, not something to preserve here.
 *
 * Freshness: a snapshot older than SNAPSHOT_TTL_MS, written under a different
 * sort order, or from another schema version reads back as empty. app.js also
 * clears it wherever it already drops its in-memory view caches (sync, reset,
 * sort change). Every storage access is try/catch-guarded.
 */
(function (root) {
  const SELECTION_KEY = "xbo:selection";
  const SNAPSHOT_KEY = "xbo:view-snapshot";
  const SNAPSHOT_VERSION = 1;
  const SNAPSHOT_TTL_MS = 5 * 60 * 1000;
  const MAX_SNAPSHOT_VIEWS = 8;
  const MAX_SNAPSHOT_CHARS = 1500000; // ~1.5MB of JSON, well under the ~5MB quota
  const FILTERS = ["all", "unread", "read", "favorite"];

  function isFilter(value) {
    return FILTERS.indexOf(value) !== -1;
  }

  /** The persisted selection as `{ categoryId, filter }`, or null when absent/garbled. */
  function readSelection(storage) {
    try {
      const parsed = JSON.parse(storage.getItem(SELECTION_KEY));
      if (!parsed || typeof parsed !== "object") return null;
      const categoryId = Number.isInteger(parsed.categoryId) ? parsed.categoryId : null;
      const filter = isFilter(parsed.filter) ? parsed.filter : "all";
      if (categoryId == null) return { categoryId: null, filter };
      return { categoryId, filter };
    } catch (_) {
      return null;
    }
  }

  /** Persist the selection (`categoryId` null = nothing selected); ignored if storage throws. */
  function writeSelection(storage, categoryId, filter) {
    try {
      storage.setItem(SELECTION_KEY, JSON.stringify({ categoryId, filter }));
    } catch (_) {
      /* private mode / blocked storage: ignore */
    }
  }

  /**
   * Keep the newest `maxViews` views, then drop the oldest until the JSON fits
   * `maxChars`. `views` is oldest first; the input is not mutated.
   */
  function boundViews(views, sort, savedAt, maxViews, maxChars) {
    let kept = views.slice(-(maxViews || MAX_SNAPSHOT_VIEWS));
    const limit = maxChars || MAX_SNAPSHOT_CHARS;
    let json = serializeSnapshot(kept, sort, savedAt);
    while (kept.length > 0 && json.length > limit) {
      kept = kept.slice(1);
      json = serializeSnapshot(kept, sort, savedAt);
    }
    return { views: kept, json };
  }

  /**
   * One view: `{ categoryId, filter, counts, bookmarks, offset, hasMore }`.
   * (Deliberately plain data - no DOM node or function ever goes in.)
   */
  function serializeSnapshot(views, sort, savedAt) {
    return JSON.stringify({ v: SNAPSHOT_VERSION, savedAt, sort, views });
  }

  function isValidView(view) {
    return (
      view &&
      Number.isInteger(view.categoryId) &&
      isFilter(view.filter) &&
      Array.isArray(view.bookmarks) &&
      view.bookmarks.every((b) => b && Number.isInteger(b.id)) &&
      view.counts &&
      typeof view.counts === "object" &&
      Number.isInteger(view.offset)
    );
  }

  /**
   * Views from a raw snapshot string that are still trustworthy for `sort` at
   * `now`; [] on any mismatch, expiry or corruption.
   */
  function parseSnapshot(raw, sort, now, ttlMs) {
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.v !== SNAPSHOT_VERSION || parsed.sort !== sort) return [];
      const age = now - parsed.savedAt;
      if (!(age >= 0) || age > (ttlMs || SNAPSHOT_TTL_MS)) return [];
      if (!Array.isArray(parsed.views)) return [];
      return parsed.views.filter(isValidView);
    } catch (_) {
      return [];
    }
  }

  /** Bound and store `views`; a full or blocked storage silently drops the snapshot. */
  function writeSnapshot(storage, views, sort, now) {
    try {
      if (views.length === 0) {
        storage.removeItem(SNAPSHOT_KEY);
        return;
      }
      storage.setItem(SNAPSHOT_KEY, boundViews(views, sort, now).json);
    } catch (_) {
      try {
        storage.removeItem(SNAPSHOT_KEY);
      } catch (__) {
        /* ignore */
      }
    }
  }

  function readSnapshot(storage, sort, now) {
    try {
      const raw = storage.getItem(SNAPSHOT_KEY);
      return raw ? parseSnapshot(raw, sort, now) : [];
    } catch (_) {
      return [];
    }
  }

  /** Invalidate: a sync, reset, recategorize or reorder made every stored page suspect. */
  function clearSnapshot(storage) {
    try {
      storage.removeItem(SNAPSHOT_KEY);
    } catch (_) {
      /* ignore */
    }
  }

  const api = {
    SELECTION_KEY,
    SNAPSHOT_KEY,
    SNAPSHOT_TTL_MS,
    MAX_SNAPSHOT_VIEWS,
    MAX_SNAPSHOT_CHARS,
    readSelection,
    writeSelection,
    boundViews,
    serializeSnapshot,
    parseSnapshot,
    readSnapshot,
    writeSnapshot,
    clearSnapshot,
  };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.XBOViewPersist = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
