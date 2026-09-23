"use strict";

/**
 * X Bookmarks Organizer — local web viewer.
 * Vanilla JS: renders the category tree, lists a node's bookmarks, embeds the
 * X post where possible (link fallback otherwise), and marks a bookmark read
 * when it is opened.
 */
(function () {
  // Let the page animate again. `#xbo-preboot` suppresses every transition
  // and animation so the state it applies before the first paint APPEARS
  // rather than sliding into place; two frames is what it takes for that
  // paint to have happened. Scheduled first, so nothing below can leave the
  // page permanently motionless by throwing.
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      document.documentElement.removeAttribute("data-preboot");
    });
  });

  const treeEl = document.getElementById("tree");
  // Host of the card pool plus ONE view pane (`listEl`: loading/empty/error
  // states, sentinel, end marker). Until the first category is opened
  // `listEl` is the host itself, which still holds the static welcome state.
  const listRoot = document.getElementById("bookmark-list");
  let listEl = listRoot;
  const titleEl = document.getElementById("content-title");
  const searchInput = document.getElementById("category-search");
  const searchClear = document.getElementById("category-search-clear");
  const filterTabsEl = document.getElementById("filter-tabs");
  // The row the tab bar sits in. Hiding the ROW, not just the tablist, is what
  // keeps the empty states free of a stray 1px border with nothing above it.
  const toolbarEl = document.getElementById("toolbar");

  // ---- summary modal ------------------------------------------------------
  const summaryBackdropEl = document.getElementById("summary-backdrop");
  const summaryModalEl = document.getElementById("summary-modal");
  const summaryMetaEl = document.getElementById("summary-meta");
  const summaryBodyEl = document.getElementById("summary-body");
  const summaryCloseBtn = document.getElementById("summary-close");
  let summaryReturnFocusEl = null;
  let summaryRequestSeq = 0;
  // Optimistic default: corrected once /api/summary-status resolves. A stale
  // "true" is still safe - the endpoint itself degrades gracefully (503) if no
  // provider is available, and that renders the same message in the modal.
  let summaryAvailable = true;
  const SUMMARY_UNAVAILABLE_MESSAGE =
    "Summaries are disabled: no LLM provider is available.";
  // The server's reason (the provider adapter's own actionable message), used
  // for the button tooltip and the modal so the owner is told what to fix.
  let summaryUnavailableReason = SUMMARY_UNAVAILABLE_MESSAGE;

  // ---- move a post to another category (issue #92) ------------------------
  // Two entry points, ONE re-file: the card's drag handle dropped on a
  // sidebar category, and the picker modal (the keyboard path).
  const moveBackdropEl = document.getElementById("move-backdrop");
  const moveModalEl = document.getElementById("move-modal");
  const moveTreeEl = document.getElementById("move-tree");
  const moveSearchInput = document.getElementById("move-search-input");
  const moveSearchClear = document.getElementById("move-search-clear");
  const moveSelectionEl = document.getElementById("move-selection");
  const moveErrorEl = document.getElementById("move-error");
  const moveConfirmBtn = document.getElementById("move-confirm");
  const moveCancelBtn = document.getElementById("move-cancel");
  const moveCloseBtn = document.getElementById("move-close");
  const moveGhostEl = document.getElementById("move-ghost");
  const moveAnnouncerEl = document.getElementById("move-announcer");

  let selectedCategoryId = null;
  let selectedButton = null;
  // Manual expand/collapse state (category id -> expanded), preserved across
  // sidebar refreshes so mark-read never resets the user's browsing context.
  const expansionState = new Map();
  // Full category tree (roots) kept in memory so the search filter can
  // re-render from source without re-fetching.
  let treeRoots = [];
  // id -> node, flattened from treeRoots (same object references) so a
  // read-state toggle or delete can walk straight to a category's ancestors
  // and patch counts in place, without touching the rest of the sidebar DOM.
  let categoryIndex = new Map();
  // The selected tab in the bar under the top bar: the three read-state
  // views plus the owner's starred set (issues #65/#63).
  let activeFilter = "all"; // "all" | "unread" | "read" | "favorite"
  // Filters whose MEMBERSHIP a per-bookmark toggle can flip, so a cached
  // view of one can go stale ("all" never loses or gains a post this way).
  const MEMBERSHIP_FILTERS = ["unread", "read", "favorite"];
  // How the list is ordered: the FIELD (issue #62) - "recent", always the
  // default, or "score", the opt-in ranking pass's verdict - and the
  // DIRECTION it runs in (issue #97): "desc" is newest/highest first, "asc"
  // is oldest/lowest first. Ordering happens SERVER-side because paging does -
  // sorting one page here would only shuffle whichever batch happened to
  // arrive. Both are persisted through XBOSortOrder's guarded storage.
  let activeSort = "recent";
  let activeDir = "desc";

  // ---- lazy loading (paged, filtered, infinite scroll) ------------------
  // The selected category is loaded one batch at a time as the owner scrolls,
  // so a large category never renders (or embeds) every post up front. Counts
  // come from the server so totals stay accurate without downloading each row.
  let categoryCounts = { total: 0, unread: 0, favorite: 0 };
  let pageOffset = 0; // rows fetched so far for the current category+filter
  let pageHasMore = false;
  let pageLoading = false;
  // Bumped on every category select / filter change so a slow in-flight batch
  // from a previous view can be discarded instead of polluting the new one.
  let requestSeq = 0;
  let observer = null;
  let sentinelEl = null;
  // Bookmark objects backing the cards currently in `listEl`, in the same
  // order (excludes the sentinel/end-marker/error tail) - kept so a view can
  // be snapshotted into `viewCaches` before switching away from it.
  let currentViewBookmarks = [];
  // False while a first-page fetch for the current category+filter is in
  // flight (or failed) - guards saveCurrentViewToCache against caching a
  // loading placeholder or error state as if it were real content.
  let viewReady = false;

  // ---- client-side view cache + per-post card pool (issues #33, #67) -----
  // Rendered cards are pooled PER POST, not per view: a post loaded under any
  // filter (All/Unread/Read/Favorites) or category is re-shown from the pool
  // when it appears in another view, so its X embed never reloads and only
  // genuinely new posts render (and spin). Every pooled card stays MOUNTED
  // in `listRoot` - detaching an iframe and re-attaching it makes the
  // browser reload it - and a view merely shows the cards of its own ids:
  // the rest are `hidden`, and flex `order` sequences the visible ones, so no
  // node is ever moved. `viewCaches` keeps only each view's id list and
  // paging state: category id -> { counts, filters: Map(filter ->
  // { ids, bmById, offset, hasMore }) }, bounded to
  // XBOFilterCache.MAX_CACHED_CATEGORIES by LRU. The pool itself is bounded
  // by XBOFilterCache.MAX_POOLED_POSTS; the posts on screen are never evicted.
  let viewCaches = new Map();
  let cacheOrder = []; // LRU order of cached category ids, oldest first
  const cardPool = new Map(); // post id -> { bm, card }
  let poolOrder = []; // LRU order of pooled post ids, oldest first
  // A pooled card holds ONE embed per theme it has been shown under (#90), so
  // the posts' iframes are bounded separately from the cards: LRU order of
  // `XBOEmbedTheme.variantKey(postId, theme)`, oldest first. Only a SPARE
  // (hidden, other-theme) variant is ever released - see touchVariantPool.
  let variantOrder = [];
  let hostMounted = false;

  function touchCategoryCache(categoryId) {
    const { order, evicted } = window.XBOFilterCache.touchLru(cacheOrder, categoryId);
    cacheOrder = order;
    for (const id of evicted) viewCaches.delete(id);
  }

  /**
   * Swap the static welcome state for the live host (once) and clear the
   * view pane. The pane sorts after every card via CSS `order`.
   */
  function ensureViewHost() {
    listRoot.removeAttribute("aria-busy");
    if (!hostMounted) {
      const pane = el("div", "view-pane");
      listRoot.replaceChildren(pane);
      listEl = pane;
      hostMounted = true;
    }
    listEl.replaceChildren();
  }

  /** Drop every pooled card (a sync makes every cached post suspect). */
  function resetPool() {
    for (const { card } of cardPool.values()) card.remove();
    cardPool.clear();
    poolOrder = [];
    variantOrder = [];
  }

  /**
   * Release one pooled post (deleted, or evicted). Removing the card takes
   * EVERY theme variant it holds with it, so its keys leave the variant LRU
   * too - otherwise a long session would accumulate keys pointing at cards
   * that no longer exist.
   */
  function dropFromPool(id) {
    const pooled = cardPool.get(id);
    if (pooled) pooled.card.remove();
    cardPool.delete(id);
    poolOrder = poolOrder.filter((x) => x !== id);
    variantOrder = variantOrder.filter((key) => window.XBOEmbedTheme.parseVariantKey(key).id !== String(id));
  }

  /**
   * The pooled bookmark + card for a server row: reuse them when the post was
   * loaded before (folding in the row's fresher read/favorite state), else
   * render a new card. Returns the POOLED bookmark object so every view of
   * the post shares one.
   */
  function poolPost(row) {
    const pooled = cardPool.get(row.id);
    if (pooled) {
      if (pooled.bm !== row) {
        // The fold itself is pure and lives in `filter-cache.js`; all that is
        // left here is repainting whatever it says actually moved.
        const changed = window.XBOFilterCache.foldServerRow(pooled.bm, row);
        if (changed.controls) patchCardControls(pooled.bm, pooled.card);
        if (changed.score) patchScoreChip(pooled.bm, pooled.card);
      }
      return pooled;
    }
    const card = renderCard(row);
    card.hidden = true; // paintViewCards reveals it
    listRoot.insertBefore(card, listEl);
    const created = { bm: row, card };
    cardPool.set(row.id, created);
    return created;
  }

  /** Show exactly the current view's cards, in order; hide the rest (never detach). */
  function paintViewCards() {
    const position = new Map(currentViewBookmarks.map((bm, i) => [bm.id, i]));
    for (const [id, { card }] of cardPool) {
      const i = position.get(id);
      card.hidden = i === undefined;
      card.style.order = i === undefined ? "" : String(i);
    }
    const { order, evicted } = window.XBOFilterCache.touchPool(
      poolOrder,
      currentViewBookmarks.map((bm) => bm.id),
      window.XBOFilterCache.MAX_POOLED_POSTS,
      position.keys(),
    );
    poolOrder = order;
    for (const id of evicted) dropFromPool(id);
    // A card pooled under the other theme is switched to its variant for the
    // current one the moment a view shows it (building that variant only if
    // this post has never been shown in this theme), so a lazily-revealed
    // post never appears in the wrong theme.
    rethemeVisibleEmbeds();
  }

  /** Add server rows to the current view, reusing pooled cards. */
  function appendToView(rows) {
    for (const row of rows) currentViewBookmarks.push(poolPost(row).bm);
    paintViewCards();
  }

  /** Snapshot the currently rendered view into the cache, before leaving it. */
  function saveCurrentViewToCache() {
    // A view mid-fetch (or one that errored) has no settled bookmarks/counts
    // to snapshot - caching it would poison that category+filter with a
    // false "0 results" entry. Only a view that finished loading (including
    // a genuinely empty category) is safe to cache.
    if (selectedCategoryId == null || !viewReady) return;
    const catCache = ensureCategoryCache(selectedCategoryId);
    catCache.counts = categoryCounts;
    const bmById = new Map();
    const ids = [];
    for (const bm of currentViewBookmarks) {
      ids.push(bm.id);
      bmById.set(bm.id, bm);
    }
    catCache.filters.set(activeFilter, {
      ids,
      bmById,
      offset: pageOffset,
      hasMore: pageHasMore,
    });
  }

  function ensureCategoryCache(categoryId) {
    touchCategoryCache(categoryId);
    let entry = viewCaches.get(categoryId);
    if (!entry) {
      entry = { counts: emptyCounts(), filters: new Map() };
      viewCaches.set(categoryId, entry);
    }
    return entry;
  }

  /** Zeroed counts, one per tab that needs a total (see the server's payload). */
  function emptyCounts() {
    return { total: 0, unread: 0, favorite: 0 };
  }

  /**
   * Sync cached category counts (rollup total/unread) from tree-count
   * updates. The sidebar tree only tracks total/unread, so the cached
   * favorites total is carried over rather than dropped.
   */
  function syncCacheCounts(updatedNodes) {
    for (const node of updatedNodes) {
      const catCache = viewCaches.get(node.id);
      if (catCache) {
        catCache.counts = { ...catCache.counts, total: node.total, unread: node.unread };
      }
    }
  }

  /**
   * Render a cache-hit view from the pool: no fetch, no re-render, and the
   * embeds inside the pooled cards are reused as-is. A post evicted from the
   * pool since is re-rendered (its embed reloads - it was released).
   */
  function restoreViewFromCache(entry) {
    teardownObserver();
    pageLoading = false;
    viewReady = true; // an already-settled snapshot, safe to re-cache as-is
    requestSeq += 1; // cancel any in-flight fetch from the view being left
    pageOffset = entry.offset;
    pageHasMore = entry.hasMore;
    currentViewBookmarks = [];
    ensureViewHost();
    appendToView(entry.ids.map((id) => entry.bmById.get(id)).filter(Boolean));

    renderCountLine();
    if (categoryCounts.total === 0) {
      stateMessage(listEl, "empty", "No bookmarks are filed under this category.");
      return;
    }
    if (currentViewBookmarks.length === 0) {
      stateMessage(listEl, "empty", emptyFilterMessage());
      return;
    }
    updateTail();
  }

  /**
   * A view of a fully loaded category under Unread/Read/Favorites needs no
   * fetch: derive it from the cached complete "All" list (same server sort),
   * so every card is a pooled one and the switch is instant.
   */
  function deriveViewEntry(catCache, filter) {
    const all = catCache.filters.get("all");
    if (!all || all.hasMore || filter === "all") return null;
    const ids = window.XBOFilterCache.deriveFilterIds(filter, all.ids, all.bmById);
    const bmById = new Map(ids.map((id) => [id, all.bmById.get(id)]));
    return { ids, bmById, offset: ids.length, hasMore: false };
  }

  /**
   * After a read-state or favorite change, keep every cached view (other
   * than the one currently on screen, which the live DOM/bm patch already
   * handles) consistent, across every category the bookmark is filed under.
   *
   * The card itself is pooled and shared, so it is already up to date and is
   * never touched here. A cached Unread/Read/Favorites id list whose
   * membership for this bookmark is now stale is deleted, so the next visit
   * re-derives it from a complete All list or re-fetches (the correct sort
   * position of a newly-qualifying post isn't knowable otherwise) - either
   * way the post's pooled card is reused, not reloaded.
   */
  function syncCachedViewsOnChange(bm) {
    // A cached view can be a PARENT category showing a rolled-up list of
    // descendant bookmarks, so a cached entry can exist for an ancestor id
    // that never appears in `bm.categoryIds` (its direct categories) -
    // affectedCategoryIds walks each direct category's ancestor chain, the
    // same set updateSidebarCounts already patches.
    const affected = window.XBOTreeCounts
      ? window.XBOTreeCounts.affectedCategoryIds(categoryIndex, bm.categoryIds || [])
      : new Set(bm.categoryIds || []);
    for (const categoryId of affected) {
      const catCache = viewCaches.get(categoryId);
      if (!catCache) continue;
      const isLive = (filterName) =>
        categoryId === selectedCategoryId && filterName === activeFilter;

      for (const filterName of MEMBERSHIP_FILTERS) {
        if (isLive(filterName)) continue; // live view, already patched
        const entry = catCache.filters.get(filterName);
        if (!entry) continue;
        if (window.XBOFilterCache.isFilterEntryStale(entry.ids, filterName, bm.id, bm)) {
          catCache.filters.delete(filterName);
        }
      }

      // A bookmark object no longer shared with the pool (its card was
      // evicted) still needs its copy in each entry kept current.
      for (const [filterName, entry] of catCache.filters) {
        if (isLive(filterName)) continue;
        const cachedBm = entry.bmById.get(bm.id);
        if (cachedBm && cachedBm !== bm) {
          cachedBm.read = bm.read;
          cachedBm.readAt = bm.readAt;
          cachedBm.favorite = bm.favorite;
        }
      }
    }
  }

  /** Re-render a card's read pill + star from its bookmark's current state. */
  function patchCardControls(bm, cardEl) {
    cardEl.classList.toggle("is-unread", !bm.read);
    const oldPill = cardEl.querySelector(".read-pill");
    if (oldPill) oldPill.replaceWith(renderPill(bm, cardEl));
    const oldStar = cardEl.querySelector(".fav-btn");
    if (oldStar) oldStar.replaceWith(renderFavoriteButton(bm, cardEl));
  }

  /**
   * Put a pooled card's score chip in step with its bookmark's current
   * verdict (issue #91).
   *
   * A ranking run writes scores and nothing else, so a card pooled BEFORE the
   * run is correct in every other respect and only its chip is out of date -
   * which is why this replaces the chip in place rather than re-rendering the
   * card. Re-rendering would detach the card's mounted X embed and reload it,
   * the very thing the pool exists to prevent.
   *
   * The chip IS focusable and opens the breakdown graph, so the swap has to
   * carry that state across: an open graph is closed (its numbers just
   * changed) and the keyboard is handed the replacement, never left on a
   * detached node. A bookmark with no verdict gets the EMPTY badge back
   * (issue #98) rather than no chip - which is also the swap the per-post run
   * itself performs when it fills one in.
   */
  function patchScoreChip(bm, cardEl) {
    const right = cardEl.querySelector(".bookmark-actions-right");
    if (!right) return;
    const existing = right.querySelector(".score-chip");
    const hadFocus = existing !== null && document.activeElement === existing;
    if (existing) {
      if (scoreDetailAnchor === existing) closeScoreDetail();
      existing.remove();
    }
    const chip = renderScoreChip(bm, cardEl);
    // The chip leads the right-hand group, ahead of the delete button - the
    // same order `renderCard` builds.
    if (chip) right.insertBefore(chip, right.firstChild);
    if (chip && hadFocus) chip.focus();
  }

  /** Permanently remove a deleted bookmark from every cached view and the pool. */
  function purgeFromCache(bm) {
    for (const catCache of viewCaches.values()) {
      for (const entry of catCache.filters.values()) {
        const idx = entry.ids.indexOf(bm.id);
        if (idx === -1) continue;
        entry.ids.splice(idx, 1);
        entry.bmById.delete(bm.id);
        entry.offset = Math.max(0, entry.offset - 1);
      }
    }
    dropFromPool(bm.id);
  }

  /** Show the selected category+filter: a cache hit restores instantly, a miss fetches. */
  async function showCategoryView(opts) {
    const catCache = viewCaches.get(selectedCategoryId);
    if (catCache) categoryCounts = catCache.counts;
    const cached = catCache && catCache.filters.get(activeFilter);
    if (cached) {
      touchCategoryCache(selectedCategoryId);
      restoreViewFromCache(cached);
      return;
    }
    const derived = catCache && deriveViewEntry(catCache, activeFilter);
    if (derived) {
      restoreViewFromCache(derived);
      return;
    }
    await fetchAndRenderFirstPage(opts);
  }

  // ---- persisted last view (issue #78) ------------------------------------
  // The selection (category + tab) survives a reload in localStorage, and a
  // bounded snapshot of the fetched pages in sessionStorage lets that reload
  // restore the view from data instead of re-fetching it (view-persist.js owns
  // the format, bounds and freshness). X embeds re-initialize on any fresh
  // page load regardless - only the server round trip is avoided. Every drop
  // of `viewCaches` below also clears the snapshot.
  let viewRestoreDone = false; // never overwrite the stored view before it was read

  function persistSelection() {
    if (window.XBOViewPersist && viewRestoreDone) {
      window.XBOViewPersist.writeSelection(window.localStorage, selectedCategoryId, activeFilter);
    }
  }

  function clearPersistedViews() {
    if (window.XBOViewPersist) window.XBOViewPersist.clearSnapshot(window.sessionStorage);
  }

  /**
   * What the page snapshot is keyed by: the field AND the direction (issue
   * #97). Pages fetched under one ordering are worthless under any other, and
   * a snapshot keyed by the field alone would survive a direction flip and
   * hydrate the list backwards.
   */
  function persistedSortKey() {
    return window.XBOSortOrder ? window.XBOSortOrder.sortKey(activeSort, activeDir) : "recent:desc";
  }

  function persistViewSnapshot() {
    if (!window.XBOViewPersist || !viewRestoreDone) return;
    saveCurrentViewToCache();
    const views = [];
    for (const categoryId of cacheOrder) {
      const catCache = viewCaches.get(categoryId);
      if (!catCache) continue;
      for (const [filter, entry] of catCache.filters) {
        const bookmarks = entry.ids.map((id) => entry.bmById.get(id)).filter(Boolean);
        views.push({
          categoryId,
          filter,
          counts: catCache.counts,
          bookmarks,
          offset: entry.offset,
          hasMore: entry.hasMore,
        });
      }
    }
    // The open view goes last so the size bound drops the others first.
    const live = views.findIndex((v) => v.categoryId === selectedCategoryId && v.filter === activeFilter);
    if (live !== -1) views.push(views.splice(live, 1)[0]);
    window.XBOViewPersist.writeSnapshot(window.sessionStorage, views, persistedSortKey(), Date.now());
  }

  /** Seed `viewCaches` from the stored snapshot, for categories that still exist. */
  function hydrateViewSnapshot() {
    const views = window.XBOViewPersist.readSnapshot(window.sessionStorage, persistedSortKey(), Date.now());
    for (const view of views) {
      const node = categoryIndex.get(view.categoryId);
      if (!node) continue; // renamed/removed since (e.g. a recategorize)
      const catCache = ensureCategoryCache(view.categoryId);
      // The tree just loaded is authoritative for the rollup counts.
      catCache.counts = { ...view.counts, total: node.total, unread: node.unread };
      catCache.filters.set(view.filter, {
        ids: view.bookmarks.map((b) => b.id),
        bmById: new Map(view.bookmarks.map((b) => [b.id, b])),
        offset: view.offset,
        hasMore: Boolean(view.hasMore),
      });
    }
  }

  /**
   * On load: reopen the persisted category + tab, from the persisted pages
   * when there are any. A category that no longer exists falls back to the
   * empty "Select a category" state - never an error.
   */
  async function restoreLastView() {
    const saved = window.XBOViewPersist && window.XBOViewPersist.readSelection(window.localStorage);
    // On a phone, restoring a category auto-dismisses the drawer anyway
    // (`selectCategory` does it) - but only once the tree has loaded, which
    // meant every reload with a saved selection played the whole close
    // animation. Decide it here instead, before the first frame, so the
    // drawer simply starts closed. `silent` so the owner's own preference is
    // untouched: a load with nothing to restore still opens it.
    if (saved && saved.categoryId != null && drawerQuery.matches && !isCollapsed()) {
      setCollapsed(true, { silent: true, moveFocus: false });
    }
    await loadTree();
    try {
      if (saved && selectedCategoryId == null) {
        activeFilter = saved.filter;
        renderFilterTabs();
      }
      if (saved && saved.categoryId != null && selectedCategoryId == null) {
        const node = categoryIndex.get(saved.categoryId);
        const button = treeEl.querySelector(`[data-category-id="${saved.categoryId}"]`);
        if (node && button) {
          hydrateViewSnapshot();
          viewRestoreDone = true;
          await selectCategory(node, button);
          return;
        }
      }
    } catch (_) {
      /* storage or a stale record must never break the viewer */
    } finally {
      viewRestoreDone = true;
    }
    persistSelection(); // nothing (valid) to restore: forget a dead selection
  }

  // ---- sidebar (resizes the content, issues #65, #86) --------------------
  // On wide screens the sidebar is an in-flow column beside `.viewer`:
  // opening it grows that column and shrinks the viewer by the same width,
  // where the posts re-center in the narrower space - nothing is hidden
  // underneath it. That is all CSS; the state here is just the body
  // attribute. On narrow screens it stays the overlay drawer with its scrim
  // (a resized column would have no room left), which is also where the
  // *auto-dismiss on pick* applies.

  const bodyEl = document.body;
  const contentEl = document.getElementById("bookmarks"); // the scrolling pane
  const sidebarEl = document.getElementById("sidebar");
  const toggleBtn = document.getElementById("sidebar-toggle");
  const backdropEl = document.getElementById("sidebar-backdrop");
  const searchOpenBtn = document.getElementById("search-open");
  const drawerQuery = window.matchMedia("(max-width: 820px)");

  function readStoredCollapsed() {
    return window.XBOSidebarState
      ? window.XBOSidebarState.readCollapsed(window.localStorage)
      : true;
  }
  function storeCollapsed(collapsed) {
    if (window.XBOSidebarState) {
      window.XBOSidebarState.writeCollapsed(window.localStorage, collapsed);
    }
  }

  function isCollapsed() {
    return bodyEl.getAttribute("data-sidebar") === "collapsed";
  }

  // The open/close animation is entirely CSS (issue #86): on wide screens
  // `body`'s `grid-template-columns` transitions, so the sidebar track grows
  // and the viewer's shrinks out of one interpolation; on narrow screens the
  // fixed overlay drawer transitions its transform. Either way the body
  // attribute below is the only state JS owns - there is no keyframe to name,
  // start or clean up.

  function setCollapsed(collapsed, opts) {
    const options = opts || {};
    if (collapsed) bodyEl.setAttribute("data-sidebar", "collapsed");
    else bodyEl.removeAttribute("data-sidebar");

    const visible = !collapsed;
    toggleBtn.setAttribute("aria-expanded", String(visible));
    toggleBtn.setAttribute("aria-label", visible ? "Hide categories" : "Show categories");
    // A closed drawer is off-screen but still in the DOM; `inert` keeps it
    // out of the tab order so keyboard focus never disappears into it.
    // (The scrim's visibility is pure CSS, so it can fade both ways.)
    sidebarEl.inert = collapsed;

    if (!options.silent) storeCollapsed(collapsed);
    if (options.silent || options.moveFocus === false) return;

    if (visible) {
      const firstNode = treeEl.querySelector(".tree-node") || searchInput;
      if (firstNode) firstNode.focus();
    } else if (options.returnFocus !== false) {
      toggleBtn.focus();
    }
  }

  function initSidebar() {
    setCollapsed(readStoredCollapsed(), { silent: true });

    toggleBtn.addEventListener("click", () => setCollapsed(!isCollapsed()));
    // The empty-state prompts (landing card + top-bar title) open the same
    // animated sidebar as the menu toggle.
    const openFromPrompt = () => {
      if (isCollapsed()) setCollapsed(false);
      else {
        const first = treeEl.querySelector(".tree-node") || searchInput;
        if (first) first.focus();
      }
    };
    document.addEventListener("click", (e) => {
      if (e.target.closest && e.target.closest("[data-open-categories]")) openFromPrompt();
    });
    listRoot.addEventListener("keydown", (e) => {
      const prompt = e.target.closest && e.target.closest(".state-prompt");
      if (!prompt || e.target !== prompt) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openFromPrompt();
      }
    });
    backdropEl.addEventListener("click", () => setCollapsed(true));

    // The bar's search control is an entry point to the drawer's own filter
    // field - one search, reachable from the top bar.
    if (searchOpenBtn && searchInput) {
      searchOpenBtn.addEventListener("click", () => {
        setCollapsed(false, { moveFocus: false });
        searchInput.focus();
        searchInput.select();
      });
    }

    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || isCollapsed()) return;
      // The settings popover and the setup dialog each own Escape while open.
      if (popovers.some(isPopoverOpen) || isSetupOpen()) return;
      // So does any modal dialog over the tree. Without this, Escape closed
      // the dialog AND collapsed the drawer behind it - which for the
      // category editor also stranded focus, because the pencil it returns
      // the keyboard to is inside the drawer that just went `inert`.
      if (isCatEditorOpen() || isCatDeleteOpen() || isMovePickerOpen() || isRubricOpen()) return;
      setCollapsed(true);
    });
  }

  // ---- resizing the sidebar (issue #99) ----------------------------------
  // The column's right edge is a real ARIA window splitter: drag it, or focus
  // it and use the arrow keys. What it sets is `--sidebar-width` on `:root`,
  // which is the ONE token the track, the overlay drawer and `.sidebar-inner`
  // all hang off - so both modes follow it and the #86 open/close animation is
  // untouched (it interpolates to whatever the token currently says).
  //
  // The bounds and the guarded persistence are `sidebar-width.js`; everything
  // here is the gesture and the ARIA values.

  const resizerEl = document.getElementById("sidebar-resizer");
  const sidebarInnerEl = sidebarEl ? sidebarEl.querySelector(".sidebar-inner") : null;
  let sidebarWidth = window.XBOSidebarWidth
    ? window.XBOSidebarWidth.readWidth(window.localStorage)
    : null;

  /**
   * The width in force right now. With nothing persisted that is whatever the
   * stylesheet's `clamp()` resolved to, which is read off `.sidebar-inner` -
   * it is absolutely positioned at a width derived from the token, so it
   * reports a real number even while the track is animating (or collapsed to
   * zero) and the token itself would only read back as the unresolved
   * `clamp(...)` expression.
   */
  function currentSidebarWidth() {
    if (sidebarWidth !== null) return sidebarWidth;
    if (!sidebarInnerEl || !window.XBOSidebarWidth) return null;
    const strip = resizerEl ? resizerEl.getBoundingClientRect().width : 0;
    return window.XBOSidebarWidth.clampWidth(
      sidebarInnerEl.getBoundingClientRect().width + strip,
    );
  }

  function syncResizerValues() {
    if (!resizerEl || !window.XBOSidebarWidth) return;
    resizerEl.setAttribute("aria-valuemin", String(window.XBOSidebarWidth.MIN_SIDEBAR_WIDTH));
    resizerEl.setAttribute("aria-valuemax", String(window.XBOSidebarWidth.MAX_SIDEBAR_WIDTH));
    const now = currentSidebarWidth();
    if (now === null) return;
    resizerEl.setAttribute("aria-valuenow", String(now));
    resizerEl.setAttribute("aria-valuetext", `${now} pixels wide`);
  }

  /** Apply a width to the token; `persist` is false for every drag frame. */
  function applySidebarWidth(px, persist) {
    if (!window.XBOSidebarWidth) return;
    const value = window.XBOSidebarWidth.clampWidth(px);
    if (value === null) return;
    sidebarWidth = value;
    document.documentElement.style.setProperty("--sidebar-width", `${value}px`);
    if (persist) window.XBOSidebarWidth.writeWidth(window.localStorage, value);
    syncResizerValues();
  }

  function initSidebarResizer() {
    if (!resizerEl || !window.XBOSidebarWidth) return;
    // Restore the persisted width before anything measures the column.
    if (sidebarWidth !== null) {
      document.documentElement.style.setProperty("--sidebar-width", `${sidebarWidth}px`);
    }
    syncResizerValues();

    let dragPointer = null;
    resizerEl.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      dragPointer = e.pointerId;
      resizerEl.setPointerCapture(dragPointer);
      // Suppresses the grid's own transition for the duration: the column has
      // to track the pointer exactly, not ease after it.
      bodyEl.setAttribute("data-resizing", "sidebar");
      e.preventDefault();
    });
    resizerEl.addEventListener("pointermove", (e) => {
      if (dragPointer === null || e.pointerId !== dragPointer) return;
      // The sidebar is flush with the viewport's left edge, so the pointer's
      // x IS the width being asked for.
      applySidebarWidth(e.clientX, false);
    });
    const endDrag = (e) => {
      if (dragPointer === null || (e && e.pointerId !== dragPointer)) return;
      if (resizerEl.hasPointerCapture(dragPointer)) {
        resizerEl.releasePointerCapture(dragPointer);
      }
      dragPointer = null;
      bodyEl.removeAttribute("data-resizing");
      // Persisted once, at the end: a drag would otherwise write on every
      // frame of itself.
      if (sidebarWidth !== null) {
        window.XBOSidebarWidth.writeWidth(window.localStorage, sidebarWidth);
      }
    };
    resizerEl.addEventListener("pointerup", endDrag);
    resizerEl.addEventListener("pointercancel", endDrag);

    resizerEl.addEventListener("keydown", (e) => {
      const next = window.XBOSidebarWidth.stepWidth(currentSidebarWidth(), e.key);
      if (next === null) return;
      e.preventDefault();
      applySidebarWidth(next, true);
    });
  }

  // ---- scroll back to the first post (issue #99) --------------------------
  // A floating control at the top-right of the scrolling pane, offered only
  // once the list has actually been scrolled. The two thresholds that decide
  // that (and the hysteresis between them, so it does not flicker) are the
  // pure `XBOScrollTop`.

  const scrollTopBtn = document.getElementById("scroll-top");

  function initScrollTop() {
    if (!scrollTopBtn || !contentEl || !window.XBOScrollTop) return;
    let visible = false;
    const update = () => {
      const next = window.XBOScrollTop.nextVisible(contentEl.scrollTop, visible);
      if (next === visible) return;
      visible = next;
      scrollTopBtn.hidden = !visible;
    };
    contentEl.addEventListener("scroll", update, { passive: true });
    update();

    scrollTopBtn.addEventListener("click", () => {
      // Focus moves first: the button hides itself the moment the pane is
      // back near the top, and focus must not fall off it onto <body>.
      contentEl.focus({ preventScroll: true });
      contentEl.scrollTo({
        top: 0,
        behavior: window.XBOScrollTop.scrollBehavior(reducedMotion.matches),
      });
    });
  }

  // ---- top-bar popovers: ranking + sync + settings (issues #37, #71, #89) ---
  // Icon buttons in the bar's right region, each opening a panel anchored
  // under it, in the bar's own order. Settings holds post size, order and
  // categorization; Sync holds the last-synced time and the Sync button;
  // Ranking - to the LEFT of sync - holds "Rank now" and the run's progress,
  // which used to sit inside the sync panel and does not belong to syncing.
  // Opening one closes the others.
  const popovers = [
    { toggle: document.getElementById("rank-toggle"), panel: document.getElementById("rank-panel"), name: "ranking" },
    { toggle: document.getElementById("sync-toggle"), panel: document.getElementById("sync-panel"), name: "sync" },
    { toggle: document.getElementById("settings-toggle"), panel: document.getElementById("settings-panel"), name: "settings" },
  ].filter((p) => p.toggle && p.panel);

  function isPopoverOpen(p) {
    return !p.panel.hidden;
  }

  function setPopoverOpen(p, open, opts) {
    const options = opts || {};
    if (open) popovers.forEach((o) => o !== p && isPopoverOpen(o) && setPopoverOpen(o, false, { returnFocus: false }));
    p.panel.hidden = !open;
    p.toggle.setAttribute("aria-expanded", String(open));
    p.toggle.setAttribute("aria-label", `${open ? "Close" : "Open"} ${p.name}`);

    if (open) {
      const first =
        p.panel.querySelector(".seg-input:checked") || p.panel.querySelector("button:not(:disabled), input");
      if (first) first.focus();
    } else if (options.returnFocus !== false) {
      p.toggle.focus();
    }
  }

  function initSettingsPanel() {
    popovers.forEach((p) => p.toggle.addEventListener("click", () => setPopoverOpen(p, !isPopoverOpen(p))));

    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || isSetupOpen() || isRankOpen()) return;
      popovers.forEach((p) => isPopoverOpen(p) && setPopoverOpen(p, false));
    });
    // A click anywhere outside dismisses it; inside it (or on its icon,
    // which toggles) does not.
    document.addEventListener("pointerdown", (e) => {
      popovers.forEach((p) => {
        if (!isPopoverOpen(p) || p.panel.contains(e.target) || p.toggle.contains(e.target)) return;
        setPopoverOpen(p, false, { returnFocus: false });
      });
    });
  }

  // ---- post size (issue #37) ---------------------------------------------
  // A --post-scale multiplier on :root driving `zoom` on the bookmark card,
  // so the POST resizes - the embedded tweet included. Scaling the app's own
  // text was the first cut and is what the browser's zoom already does; what
  // is actually wanted is a bigger or smaller tweet, and since X owns the
  // embed's iframe, zooming the card is the only way to reach inside it.
  // Persisted through XBOPostScale's guarded storage.
  const postScaleEl = document.getElementById("post-scale");

  function applyPostScale(id) {
    if (!window.XBOPostScale) return;
    document.documentElement.style.setProperty(
      "--post-scale",
      String(window.XBOPostScale.scaleFor(id)),
    );
    if (!postScaleEl) return;
    postScaleEl.querySelectorAll(".seg-input").forEach((input) => {
      input.checked = input.value === id;
    });
  }

  function initPostScale() {
    if (!window.XBOPostScale) return;
    applyPostScale(window.XBOPostScale.readPostScale(window.localStorage));
    if (!postScaleEl) return;
    postScaleEl.querySelectorAll(".seg-input").forEach((input) => {
      input.addEventListener("change", () => {
        if (!input.checked) return;
        window.XBOPostScale.writePostScale(window.localStorage, input.value);
        applyPostScale(input.value);
      });
    });
  }

  // ---- the floating sort selector (issues #62, #97) -----------------------
  // The one sort UI in the app: it left the settings popover in #97, because
  // an ordering control belongs beside what it orders, not among post-size
  // and theme switches. It only chooses how to ORDER what has already been
  // scored; it never starts a run. Starting one lives behind the
  // confirm-gated "Rank now" in the ranking popover (issues #80, #89), where
  // the paid decision belongs.
  const sortBarEl = document.getElementById("sort-bar");
  const sortFieldEl = document.getElementById("sort-field");
  const sortSentinelEl = document.getElementById("sort-sentinel");
  const sortDirBtn = document.getElementById("sort-direction");
  const sortDirLabelEl = document.getElementById("sort-direction-label");
  const sortNoteEl = document.getElementById("sort-note");
  let sortStuckObserver = null;

  function sortOrderApi() {
    return window.XBOSortOrder;
  }

  function sortFieldInputs() {
    return sortFieldEl ? Array.from(sortFieldEl.querySelectorAll(".sort-opt-input")) : [];
  }

  /** Whether the ranking pass has stored at least one score to sort by. */
  function scoreOrderAvailable() {
    const api = sortOrderApi();
    return !!api && api.scoreOrderAvailable(setupState && setupState.ranking);
  }

  /**
   * Repaint the selector from `activeSort`/`activeDir`: which field is
   * checked, whether "Top score" is offered at all, and what the direction
   * toggle reads. Pure display - it never re-pages the list.
   */
  function renderSortBar() {
    const api = sortOrderApi();
    if (!api || !sortBarEl) return;
    const scoreOk = scoreOrderAvailable();

    for (const input of sortFieldInputs()) {
      input.checked = input.value === activeSort;
      const blocked = input.value === "score" && !scoreOk;
      input.disabled = blocked;
      // A disabled radio cannot take focus, so the title is the POINTER half
      // of the explanation; `.sort-note` below carries the rest.
      if (blocked) input.parentElement.title = api.SCORE_UNAVAILABLE_MESSAGE;
      else input.parentElement.removeAttribute("title");
    }

    if (sortNoteEl) {
      sortNoteEl.textContent = scoreOk ? "" : api.SCORE_UNAVAILABLE_MESSAGE;
      sortNoteEl.hidden = scoreOk;
    }
    // Entering the radiogroup announces why an option is missing, which a
    // `title` on a disabled input never would.
    if (sortFieldEl) {
      if (scoreOk) sortFieldEl.removeAttribute("aria-describedby");
      else sortFieldEl.setAttribute("aria-describedby", "sort-note");
    }

    sortBarEl.dataset.direction = activeDir;
    if (sortDirLabelEl) sortDirLabelEl.textContent = api.directionLabel(activeSort, activeDir);
    if (sortDirBtn) {
      const name = api.directionToggleLabel(activeSort, activeDir);
      sortDirBtn.setAttribute("aria-label", name);
      sortDirBtn.title = name;
    }
  }

  /**
   * Show the selector exactly when the tab bar shows: both are controls OF an
   * open category's list, and neither means anything without one (PR #95).
   */
  function updateSortBarVisibility(show) {
    if (sortBarEl) sortBarEl.hidden = !show;
  }

  /**
   * Re-page the open category under the current ordering.
   *
   * Every cached view was paged under the OLD ordering, so any of them could
   * now be in the wrong sequence - they are dropped wholesale rather than
   * patched, exactly as a completed sync drops them. The POOL is deliberately
   * kept: re-paging only re-sequences the cards it already holds
   * (`paintViewCards` sets `order` and LRU-evicts the cold ones), so no loaded
   * post - and no mounted X embed - reloads.
   *
   * `sameCategory` is what makes this a CONTENT-ONLY refresh (issue #97): it
   * keeps the posts on screen (dimmed) until the new page lands instead of
   * blanking them, and - the actual glitch - it skips `clearTabCounts()`, so
   * the filter tabs' badges are never emptied and repainted. The tab bar's DOM
   * is not touched here at all.
   */
  function repageForSort() {
    clearPersistedViews();
    viewCaches = new Map();
    cacheOrder = [];
    if (selectedCategoryId != null) void fetchAndRenderFirstPage({ sameCategory: true });
  }

  /** Switch the sort FIELD. */
  function selectSortOrder(id) {
    const api = sortOrderApi();
    if (!api || id === activeSort || !api.isKnownSortOrder(id)) return;
    if (id === "score" && !scoreOrderAvailable()) return;
    api.writeSortOrder(window.localStorage, id);
    activeSort = id;
    renderSortBar();
    repageForSort();
  }

  /** Flip the DIRECTION the current field runs in. */
  function toggleSortDirection() {
    const api = sortOrderApi();
    if (!api) return;
    activeDir = api.flipDirection(activeDir);
    api.writeSortDirection(window.localStorage, activeDir);
    renderSortBar();
    repageForSort();
  }

  /**
   * Elevate the pill only once it is actually pinned, so it sits flat in the
   * list at rest and lifts off the posts travelling under it. The sentinel is
   * a zero-height marker at the top of the content pane; the observer's root
   * margin is the bar's own sticky offset, read from the stylesheet rather
   * than restated here.
   */
  function initSortStuckObserver() {
    if (!sortBarEl || !sortSentinelEl || !contentEl || !("IntersectionObserver" in window)) return;
    if (sortStuckObserver) sortStuckObserver.disconnect();
    const offset = Math.round(Number.parseFloat(getComputedStyle(sortBarEl).top) || 0);
    sortStuckObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) sortBarEl.classList.toggle("is-stuck", !entry.isIntersecting);
      },
      { root: contentEl, rootMargin: `-${offset}px 0px 0px 0px`, threshold: 0 },
    );
    sortStuckObserver.observe(sortSentinelEl);
  }

  function initSortOrder() {
    const api = sortOrderApi();
    if (!api) return;
    // Resolved against the REMEMBERED ranking availability, not the raw stored
    // choice (issue #104). `persistedSortKey()` has to mean the same thing on
    // the way in as it did on the way out, and what the pages were fetched
    // under is the resolved order - a stored "score" that is not orderable
    // otherwise hydrated the snapshot under a key nothing was ever saved as,
    // and every refresh re-fetched the whole view from the server.
    activeSort = api.resolveSortOrder(
      api.readSortOrder(window.localStorage),
      api.rememberedRanking(window.localStorage),
    );
    activeDir = api.readSortDirection(window.localStorage);
    renderSortBar();
    for (const input of sortFieldInputs()) {
      input.addEventListener("change", () => {
        if (input.checked) selectSortOrder(input.value);
      });
    }
    if (sortDirBtn) sortDirBtn.addEventListener("click", toggleSortDirection);
    initSortStuckObserver();
  }

  /**
   * Re-decide what the selector may offer after `/api/setup` moved (a rank run
   * finished, or a reset wiped every score). A stored "Top score" that is no
   * longer orderable falls back to recency and re-pages; the stored CHOICE is
   * left alone, so it comes back by itself after the next run.
   */
  function updateSortAvailability() {
    const api = sortOrderApi();
    if (!api) return;
    const ranking = setupState && setupState.ranking;
    // Remember what the server just said, so the NEXT load resolves the same
    // way this one finally did and its page snapshot is keyed to match
    // (issue #104). Only a real answer is recorded - a failed `/api/setup`
    // must not clear a good observation.
    if (ranking) api.writeScoreOrderAvailable(window.localStorage, api.scoreOrderAvailable(ranking));
    // Resolved from the STORED choice, not from `activeSort`: this load may
    // have started on the fallback, and a finished ranking run has to be able
    // to hand "Top score" back without the owner re-picking it.
    const resolved = api.resolveSortOrder(api.readSortOrder(window.localStorage), ranking);
    const changed = resolved !== activeSort;
    activeSort = resolved;
    renderSortBar();
    if (changed) repageForSort();
  }

  // ---- category-color toggle ---------------------------------------------
  // Lets the owner compare a plain (indentation + guide lines only) tree
  // against the per-root-hue colored one and persists the choice, so a
  // reload keeps whichever they picked. Defaults to off (the plain tree).
  // One icon button, beside the sidebar's "Categories" heading.
  const colorQuickBtn = document.getElementById("color-toggle");

  function isColorEnabled() {
    return bodyEl.getAttribute("data-tree-colors") === "on";
  }

  function setColorEnabled(enabled, opts) {
    if (enabled) bodyEl.setAttribute("data-tree-colors", "on");
    else bodyEl.removeAttribute("data-tree-colors");
    if (colorQuickBtn) {
      colorQuickBtn.setAttribute("aria-pressed", String(enabled));
      colorQuickBtn.setAttribute(
        "aria-label",
        enabled ? "Turn category colors off" : "Turn category colors on",
      );
    }
    if (!(opts && opts.silent) && window.XBOTreeColor) {
      window.XBOTreeColor.writeColorEnabled(window.localStorage, enabled);
    }
  }

  function initColorToggle() {
    const stored = window.XBOTreeColor
      ? window.XBOTreeColor.readColorEnabled(window.localStorage)
      : false;
    setColorEnabled(stored, { silent: true });
    const onToggle = () => setColorEnabled(!isColorEnabled());
    if (colorQuickBtn) colorQuickBtn.addEventListener("click", onToggle);
  }

  // ---- helpers -----------------------------------------------------------

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function stateMessage(container, kind, message) {
    container.replaceChildren();
    if (kind === "loading") {
      // A real load: spinner over a gray block, never an empty white pane.
      const box = el("div", "state state-loading");
      box.setAttribute("role", "status");
      box.append(el("span", "list-spinner"), el("span", "", message));
      container.appendChild(box);
      return;
    }
    const p = el("p", `state state-${kind}`, message);
    if (kind === "error" || kind === "loading") p.setAttribute("role", "status");
    container.appendChild(p);
  }

  async function getJSON(url) {
    const res = await fetch(url);
    if (!res.ok) {
      const err = new Error(`Request failed (${res.status})`);
      err.status = res.status;
      try {
        err.body = await res.json();
      } catch (_) {
        /* no JSON body to attach */
      }
      throw err;
    }
    return res.json();
  }

  function formatDate(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  function systemPrefersDark() {
    return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  }

  function isDarkTheme() {
    return window.XBOTheme
      ? window.XBOTheme.effectiveTheme(window.localStorage, systemPrefersDark()) === "dark"
      : systemPrefersDark();
  }

  // ---- light/dark theme toggle --------------------------------------------
  // Explicit light/dark preference in the top menu bar, overriding the system
  // default. Defaults to following the system theme until the owner picks.
  const themeToggleBtn = document.getElementById("theme-toggle");

  function applyTheme(theme) {
    // The icon shown is driven by CSS off this same attribute (see
    // styles.css), so setting it here is the single source of truth for
    // both the active theme and the toggle's icon/label.
    document.documentElement.setAttribute("data-theme", theme);
    const isDark = theme === "dark";
    if (themeToggleBtn) {
      themeToggleBtn.setAttribute("aria-pressed", String(isDark));
      themeToggleBtn.setAttribute("aria-label", isDark ? "Switch to light theme" : "Switch to dark theme");
    }
    // The posts are cross-origin widgets X themes at creation, so the toggle
    // switches each visible card to its embed for this theme (issues #89, #90).
    scheduleEmbedRetheme();
  }

  // ---- keeping the posts on the app's theme (issues #89, #90) --------------
  // The chrome re-themes from one attribute; the posts cannot. An X embed is a
  // cross-origin iframe whose theme is fixed when `createTweet` is called and
  // has no API to change afterwards, so a post shown under both themes needs
  // TWO embeds. They are kept side by side inside the card's one `.embed-slot`
  // as `.embed-variant` children - exactly one visible, the other hidden but
  // still MOUNTED, because detaching an iframe and re-attaching it reloads it.
  // So the first time a post is shown in a theme its variant is built (and
  // loads, with the skeleton + spinner); every toggle back to a theme already
  // seen just reveals the variant that is already there, instantly and with no
  // network at all.
  //
  // Three rules keep that from being expensive or jarring:
  //
  //  - only the cards actually ON SCREEN are touched here. The per-post pool
  //    (#67) holds every card ever loaded, and building dozens of hidden
  //    widgets would fetch them all for nobody; a hidden card keeps the
  //    variant it is showing until `paintViewCards` next reveals it, which
  //    re-themes it then - so a card is never shown under the wrong theme.
  //  - while a NEW variant loads, the slot keeps the height the outgoing one
  //    had, so the column does not collapse to the skeleton's height and yank
  //    the reader's scroll position out from under them. A reveal needs no
  //    such reservation - the variant already has its height.
  //  - the variants are LRU-bounded (`touchVariantPool`), so the two-per-post
  //    ceiling cannot grow the page without limit over a long session.
  //
  // The card shell, its read/favorite state, its order and every cache entry
  // are SHARED by both variants and untouched by a toggle: only which embed
  // inside the slot is visible changes.
  const RETHEME_DEBOUNCE_MS = 60;
  let rethemeTimer = null;

  /** Coalesce a burst of toggles into ONE pass. */
  function scheduleEmbedRetheme() {
    if (rethemeTimer !== null) window.clearTimeout(rethemeTimer);
    rethemeTimer = window.setTimeout(() => {
      rethemeTimer = null;
      rethemeVisibleEmbeds();
    }, RETHEME_DEBOUNCE_MS);
  }

  /** A slot's theme variants, in DOM order. */
  function embedVariants(slot) {
    return Array.from(slot.children).filter((node) => node.classList.contains("embed-variant"));
  }

  /** Show exactly one of a slot's variants; the rest stay mounted but hidden. */
  function showEmbedVariant(slot, variant) {
    for (const other of embedVariants(slot)) other.hidden = other !== variant;
  }

  /**
   * Bring every on-screen card onto the current theme. WHICH cards that is -
   * and whether each one reveals a variant it already has or has to build its
   * first one for this theme - is decided by the pure
   * `XBOEmbedTheme.rethemeAction`; this half only carries it out.
   */
  function rethemeVisibleEmbeds() {
    const theme = isDarkTheme() ? "dark" : "light";
    const shown = [];
    for (const [id, pooled] of cardPool) {
      const slot = pooled.card.querySelector(".embed-slot");
      if (!slot) continue;
      const variants = embedVariants(slot);
      const decision = window.XBOEmbedTheme.rethemeAction(
        {
          hidden: pooled.card.hidden,
          variants: variants.map((variant) => ({
            theme: variant.dataset.embedTheme,
            fallback: variant.dataset.embedFallback === "1",
            visible: !variant.hidden,
          })),
        },
        theme,
      );
      if (decision.action === "reveal") {
        const variant = variants[decision.index];
        showEmbedVariant(slot, variant);
        // The revealed variant carries its own height; a reservation left
        // over from the build that replaced it would only pad the slot.
        slot.style.minHeight = "";
        shown.push(window.XBOEmbedTheme.variantKey(id, variant.dataset.embedTheme));
      } else if (decision.action === "build") {
        buildThemeVariant(pooled, slot);
        shown.push(window.XBOEmbedTheme.variantKey(id, theme));
      }
    }
    touchVariantPool(shown);
  }

  /** Add this post's first embed for the current theme, beside the old one. */
  function buildThemeVariant(pooled, slot) {
    const reserved = slot.offsetHeight;
    if (reserved > 0) slot.style.minHeight = `${reserved}px`;
    mountEmbed(pooled.bm, pooled.card, slot, {
      onSettled: () => {
        slot.style.minHeight = "";
      },
    });
  }

  /**
   * Mark `keys` most recently shown in the variant LRU and release the
   * coldest variants beyond `XBOEmbedTheme.MAX_POOLED_EMBEDS`. Only a SPARE
   * variant can go: every card's VISIBLE one is protected, so an eviction
   * only ever drops an off-screen post's other-theme copy - which that post
   * rebuilds if it is ever shown under that theme again. Dropping the whole
   * post (`dropFromPool`) is what releases both of its variants.
   */
  function touchVariantPool(keys) {
    const visible = [];
    for (const [id, { card }] of cardPool) {
      const slot = card.querySelector(".embed-slot");
      if (!slot) continue;
      for (const variant of embedVariants(slot)) {
        if (!variant.hidden) visible.push(window.XBOEmbedTheme.variantKey(id, variant.dataset.embedTheme));
      }
    }
    const { order, evicted } = window.XBOFilterCache.touchPool(
      variantOrder,
      keys,
      window.XBOEmbedTheme.MAX_POOLED_EMBEDS,
      visible,
    );
    variantOrder = order;
    for (const key of evicted) releaseEmbedVariant(key);
  }

  /** Remove one spare (hidden) theme variant from its card. */
  function releaseEmbedVariant(key) {
    const { id, theme } = window.XBOEmbedTheme.parseVariantKey(key);
    const pooled = cardPool.get(Number(id));
    if (!pooled) return;
    const slot = pooled.card.querySelector(".embed-slot");
    if (!slot) return;
    for (const variant of embedVariants(slot)) {
      if (variant.hidden && variant.dataset.embedTheme === theme) variant.remove();
    }
  }

  function initThemeToggle() {
    if (!window.XBOTheme) return;
    applyTheme(window.XBOTheme.effectiveTheme(window.localStorage, systemPrefersDark()));

    const onToggle = () => {
      const next = isDarkTheme() ? "light" : "dark";
      window.XBOTheme.writeTheme(window.localStorage, next);
      applyTheme(next);
    };
    if (themeToggleBtn) themeToggleBtn.addEventListener("click", onToggle);

    // Keep the toggle in sync if the system theme changes while following it
    // (no explicit preference stored yet).
    const media = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)");
    const onSystemChange = () => {
      if (!window.XBOTheme.readStoredTheme(window.localStorage)) {
        applyTheme(window.XBOTheme.effectiveTheme(window.localStorage, systemPrefersDark()));
      }
    };
    if (media && media.addEventListener) media.addEventListener("change", onSystemChange);
    else if (media && media.addListener) media.addListener(onSystemChange);
  }

  // ---- category tree -----------------------------------------------------

  async function loadTree() {
    // Snapshot the user's manual expand/collapse state before the loading
    // placeholder replaces the tree, so a refresh (e.g. after mark-read) does
    // not reset it to the depth default.
    captureExpansionState();
    stateMessage(treeEl, "loading", "Loading categories…");
    let data;
    try {
      data = await getJSON("/api/tree");
    } catch (_err) {
      stateMessage(treeEl, "error", "Could not load categories. Is the server running?");
      return;
    }
    treeRoots = data.tree || [];
    categoryIndex = window.XBOTreeCounts ? window.XBOTreeCounts.buildCategoryIndex(treeRoots) : new Map();
    renderTree();
  }

  /**
   * Patch a single category button's counters in the DOM (no-op if the node
   * is not currently rendered, e.g. filtered out by an active search).
   */
  function patchCategoryCountDom(node) {
    const button = treeEl.querySelector(`[data-category-id="${node.id}"]`);
    if (!button) return;
    const counts = button.querySelector(".tree-counts");
    if (!counts) return;
    const totalEl = counts.querySelector(".count-total");
    if (totalEl) {
      totalEl.textContent = String(node.total);
      totalEl.setAttribute("aria-label", `${node.total} bookmarks`);
    }
    let badge = counts.querySelector(".badge-unread");
    if (node.unread > 0) {
      if (!badge) {
        badge = el("span", "badge-unread");
        counts.appendChild(badge);
      }
      badge.textContent = String(node.unread);
      badge.setAttribute("aria-label", `${node.unread} unread`);
    } else if (badge) {
      badge.remove();
    }
  }

  /**
   * Apply a total/unread delta to a bookmark's categories (and their
   * ancestors, counts roll up) and patch only those sidebar counters in
   * place. This is the fix for the bug where toggling read state or
   * deleting a bookmark used to reload and re-render the whole tree,
   * flickering the sidebar and losing scroll/expand state.
   */
  function updateSidebarCounts(bm, totalDelta, unreadDelta) {
    if (!window.XBOTreeCounts) return;
    const updated = window.XBOTreeCounts.applyCountDelta(
      categoryIndex,
      bm.categoryIds,
      totalDelta,
      unreadDelta,
    );
    for (const node of updated) patchCategoryCountDom(node);
    // Keep any cached category views' rollup counts in step with the same
    // ancestor-inclusive delta, so a cached view's count line stays correct.
    syncCacheCounts(updated);
  }

  /**
   * Render the category tree, honoring the current search query. An empty
   * query shows the full tree with the user's expand/collapse state; a query
   * shows only matching nodes plus the ancestors needed to place them, fully
   * expanded, with the matched substring highlighted.
   */
  function renderTree() {
    if (treeRoots.length === 0) {
      stateMessage(
        treeEl,
        "empty",
        "No categories yet. Press Sync to fetch your bookmarks and sort them.",
      );
      return;
    }
    const raw = searchInput ? searchInput.value.trim() : "";
    const query = raw.toLowerCase();
    const searching = query.length > 0;
    const roots = searching ? filterTree(treeRoots, query) : treeRoots;
    if (searching && roots.length === 0) {
      stateMessage(treeEl, "empty", `No categories match “${raw}”.`);
      return;
    }
    treeEl.replaceChildren(renderNodeList(roots, 0, { searching, query }));
    // Re-apply the current selection highlight after a refresh.
    if (selectedCategoryId != null) {
      const btn = treeEl.querySelector(`[data-category-id="${selectedCategoryId}"]`);
      if (btn) {
        btn.setAttribute("aria-current", "true");
        selectedButton = btn;
        if (!searching) expandAncestors(btn); // keep the selected node visible
      }
    }
  }

  /**
   * Return a pruned copy of the tree: a node survives if its name matches the
   * (lowercased) query or if any descendant does, so matches always keep their
   * ancestor path for context. Non-matching branches are dropped.
   */
  function filterTree(nodes, query) {
    const out = [];
    for (const node of nodes) {
      const kids =
        node.children && node.children.length ? filterTree(node.children, query) : [];
      const selfMatch = node.name.toLowerCase().includes(query);
      if (selfMatch || kids.length > 0) out.push({ ...node, children: kids });
    }
    return out;
  }

  /** Append `text` to `container`, wrapping each `query` match in a <mark>. */
  function appendHighlighted(container, text, query) {
    if (!query) {
      container.appendChild(document.createTextNode(text));
      return;
    }
    const lower = text.toLowerCase();
    let from = 0;
    let idx = lower.indexOf(query);
    if (idx === -1) {
      container.appendChild(document.createTextNode(text));
      return;
    }
    while (idx !== -1) {
      if (idx > from) container.appendChild(document.createTextNode(text.slice(from, idx)));
      container.appendChild(el("mark", null, text.slice(idx, idx + query.length)));
      from = idx + query.length;
      idx = lower.indexOf(query, from);
    }
    if (from < text.length) container.appendChild(document.createTextNode(text.slice(from)));
  }

  /** Record which expandable nodes are currently open, keyed by category id. */
  function captureExpansionState() {
    // While searching, the tree is force-expanded; recording that transient
    // state would clobber the user's real expand/collapse choices.
    if (searchInput && searchInput.value.trim().length > 0) return;
    treeEl.querySelectorAll(".tree-row").forEach((row) => {
      const btn = row.querySelector(".tree-node");
      const toggle = row.querySelector(".tree-toggle");
      if (btn && toggle && !toggle.classList.contains("is-leaf")) {
        expansionState.set(btn.dataset.categoryId, toggle.getAttribute("aria-expanded") === "true");
      }
    });
  }

  /** Expand every ancestor list of a node so it can never be hidden. */
  function expandAncestors(btn) {
    let li = btn.closest("li");
    while (li) {
      const parentUl = li.parentElement;
      if (!parentUl || parentUl.tagName !== "UL") break;
      const parentLi = parentUl.parentElement;
      const toggle = parentLi && parentLi.querySelector(":scope > .tree-row > .tree-toggle");
      if (toggle && !toggle.classList.contains("is-leaf")) {
        parentUl.hidden = false;
        toggle.setAttribute("aria-expanded", "true");
        const nodeBtn = parentLi.querySelector(":scope > .tree-row > .tree-node");
        if (nodeBtn) expansionState.set(nodeBtn.dataset.categoryId, true);
      }
      li = parentLi;
    }
  }

  function renderNodeList(nodes, depth, opts) {
    const ul = el("ul");
    for (const node of nodes) ul.appendChild(renderNode(node, depth, opts));
    return ul;
  }

  function renderNode(node, depth, opts) {
    const options = opts || {};
    const searching = options.searching === true;
    const li = el("li");
    const row = el("div", "tree-row");
    const hasChildren = node.children && node.children.length > 0;

    const toggle = el("button", "tree-toggle");
    toggle.type = "button";
    // Only a root, and only in the full (unfiltered) tree, can be reordered:
    // a search shows a subset, and a position in a subset means nothing.
    const reorderable = depth === 0 && !searching && !!window.XBORootOrder;
    if (reorderable) li.dataset.rootId = String(node.id);
    const chev = el("span", "chev", "▶");
    chev.setAttribute("aria-hidden", "true");
    toggle.appendChild(chev);

    const button = el("button", "tree-node");
    button.type = "button";
    button.dataset.categoryId = String(node.id);
    // A root's hue is set once and inherited by its whole subtree via CSS
    // custom property cascading; depth parity alternates the shade within it.
    if (depth === 0 && window.XBOTreeColor) {
      li.style.setProperty("--tree-hue", String(window.XBOTreeColor.rootCategoryHue(node.id)));
    }
    button.dataset.parity = String(depth % 2);

    const label = el("span", "tree-label");
    appendHighlighted(label, node.name, options.query);
    label.title = node.path.join(" › ");
    const counts = el("span", "tree-counts");
    const total = el("span", "count-total", String(node.total));
    total.setAttribute("aria-label", `${node.total} bookmarks`);
    counts.appendChild(total);
    if (node.unread > 0) {
      const badge = el("span", "badge-unread", String(node.unread));
      badge.setAttribute("aria-label", `${node.unread} unread`);
      counts.appendChild(badge);
    }
    button.append(label, counts);
    button.addEventListener("click", () => selectCategory(node, button));

    if (hasChildren) {
      const childList = renderNodeList(node.children, depth + 1, options);
      const saved = expansionState.get(String(node.id));
      // While searching, every surviving branch is forced open so matches show;
      // that transient state is not written back to expansionState. Absent a
      // saved choice, every node - including root categories - starts
      // collapsed; the owner expands each one to navigate.
      const expanded = searching ? true : saved !== undefined ? saved : false;
      childList.hidden = !expanded;
      toggle.setAttribute("aria-expanded", String(expanded));
      toggle.setAttribute("aria-label", `Toggle ${node.name}`);
      toggle.addEventListener("click", () => {
        const now = toggle.getAttribute("aria-expanded") !== "true";
        toggle.setAttribute("aria-expanded", String(now));
        childList.hidden = !now;
        if (!searching) expansionState.set(String(node.id), now);
      });
      row.append(toggle, button);
      if (reorderable) row.prepend(createRootGrip(node));
      li.append(row, childList);
    } else {
      toggle.classList.add("is-leaf");
      toggle.setAttribute("aria-hidden", "true");
      toggle.tabIndex = -1;
      row.append(toggle, button);
      if (reorderable) row.prepend(createRootGrip(node));
      li.append(row);
    }
    return li;
  }

  // ---- reorder the ROOT categories (issue #82) -----------------------------
  // Pointer drag on a grip handle, or ArrowUp/ArrowDown on the focused handle.
  // The order math is pure (root-order.js); the server persists and re-sorts.

  const rootAnnouncer = document.getElementById("tree-announcer");

  function announceRootOrder(message) {
    if (rootAnnouncer) rootAnnouncer.textContent = message;
  }

  function createRootGrip(node) {
    const grip = el("button", "tree-grip");
    grip.type = "button";
    grip.dataset.gripFor = String(node.id);
    grip.setAttribute("aria-label", `Reorder ${node.name}`);
    grip.title = "Drag to reorder, or press Up / Down arrow";
    grip.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><g fill="currentColor">' +
      '<circle cx="9" cy="6" r="1.7"/><circle cx="15" cy="6" r="1.7"/>' +
      '<circle cx="9" cy="12" r="1.7"/><circle cx="15" cy="12" r="1.7"/>' +
      '<circle cx="9" cy="18" r="1.7"/><circle cx="15" cy="18" r="1.7"/></g></svg>';
    grip.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      e.preventDefault();
      const ids = treeRoots.map((r) => r.id);
      const next = window.XBORootOrder.moveBy(ids, node.id, e.key === "ArrowUp" ? -1 : 1);
      if (window.XBORootOrder.sameOrder(ids, next)) {
        announceRootOrder(`${node.name} is already ${e.key === "ArrowUp" ? "first" : "last"}.`);
        return;
      }
      commitRootOrder(next, node);
    });
    grip.addEventListener("pointerdown", (e) => startRootDrag(e, grip, node));
    return grip;
  }

  /** Apply a new root order at once, persist it, and roll back if the save fails. */
  async function commitRootOrder(ids, moved) {
    const previous = treeRoots;
    const byId = new Map(treeRoots.map((r) => [r.id, r]));
    treeRoots = ids.map((id) => byId.get(id));
    captureExpansionState();
    renderTree();
    const grip = treeEl.querySelector(`[data-grip-for="${moved.id}"]`);
    if (grip) grip.focus();
    announceRootOrder(`${moved.name} moved to position ${ids.indexOf(moved.id) + 1} of ${ids.length}.`);
    try {
      const res = await fetch("/api/categories/root-order", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Could not save the category order.");
    } catch (err) {
      treeRoots = previous;
      renderTree();
      announceRootOrder(err.message || "Could not save the category order.");
      showRootOrderError(err.message || "Could not save the category order.");
    }
  }

  function showRootOrderError(message) {
    const note = el("p", "state state-error tree-order-error", message);
    note.setAttribute("role", "status");
    treeEl.prepend(note);
    setTimeout(() => note.remove(), 6000);
  }

  function startRootDrag(e, grip, node) {
    if (e.button !== undefined && e.button !== 0) return;
    const li = grip.closest("li");
    const list = li && li.parentElement;
    if (!li || !list) return;
    e.preventDefault();
    try {
      grip.setPointerCapture(e.pointerId);
    } catch (_) {
      /* no active pointer to capture (synthetic event); moves still reach the grip */
    }
    const startY = e.clientY;
    const ids = treeRoots.map((r) => r.id);
    const others = Array.from(list.children).filter((c) => c !== li);
    const mids = others.map((c) => {
      const r = c.getBoundingClientRect();
      return r.top + r.height / 2;
    });
    let target = ids.indexOf(node.id);
    li.classList.add("is-dragging");
    treeEl.classList.add("is-reordering");

    const markTarget = () => {
      others.forEach((c) => c.classList.remove("drop-before", "drop-after"));
      if (target < others.length) others[target].classList.add("drop-before");
      else if (others.length) others[others.length - 1].classList.add("drop-after");
    };
    const onMove = (ev) => {
      li.style.transform = `translateY(${ev.clientY - startY}px)`;
      target = window.XBORootOrder.dropIndex(mids, ev.clientY);
      markTarget();
    };
    const finish = (ev, cancelled) => {
      grip.removeEventListener("pointermove", onMove);
      grip.removeEventListener("pointerup", onUp);
      grip.removeEventListener("pointercancel", onCancel);
      try {
        grip.releasePointerCapture(ev.pointerId);
      } catch (_) {
        /* capture already gone */
      }
      li.classList.remove("is-dragging");
      li.style.transform = "";
      treeEl.classList.remove("is-reordering");
      others.forEach((c) => c.classList.remove("drop-before", "drop-after"));
      if (cancelled) return;
      const next = window.XBORootOrder.moveTo(ids, node.id, target);
      if (!window.XBORootOrder.sameOrder(ids, next)) commitRootOrder(next, node);
    };
    const onUp = (ev) => finish(ev, false);
    const onCancel = (ev) => finish(ev, true);
    grip.addEventListener("pointermove", onMove);
    grip.addEventListener("pointerup", onUp);
    grip.addEventListener("pointercancel", onCancel);
  }

  // ---- bookmarks ---------------------------------------------------------

  async function selectCategory(node, button) {
    if (selectedButton) selectedButton.removeAttribute("aria-current");
    button.setAttribute("aria-current", "true");
    selectedButton = button;

    if (selectedCategoryId !== node.id) saveCurrentViewToCache();
    selectedCategoryId = node.id;
    persistSelection();

    renderTitle(node.id);

    // On narrow screens the sidebar still overlays the content; picking a
    // category should reveal what it covers.
    if (drawerQuery.matches && !isCollapsed()) setCollapsed(true, { returnFocus: false });

    await showCategoryView();
  }

  /** The bar's title with nothing selected: a button that opens the sidebar. */
  function renderEmptyTitle() {
    closeCrumbMenu();
    const prompt = el("button", "topbar-prompt", "Select a category");
    prompt.type = "button";
    prompt.setAttribute("aria-controls", "sidebar");
    prompt.setAttribute("data-open-categories", "");
    titleEl.replaceChildren(prompt);
    titleEl.removeAttribute("title");
    updateToolbarVisibility();
  }

  // ---- the top bar's breadcrumb (issue #89) --------------------------------
  // The path used to be one dead string the CSS ellipsized, so the "…" an
  // owner saw was an artefact they could not click. It is a real breadcrumb
  // now: every segment selects that category - the SAME action as picking it
  // in the sidebar, routed through `selectCategoryById` - and the collapsed
  // middle of a deep path is a control that opens a menu of what it hid.
  // Which segments show is decided in `breadcrumb.js`; this half is markup,
  // focus and the menu's keyboard contract.

  const crumbMenuEl = document.getElementById("crumb-menu");
  let crumbMenuTrigger = null;

  /**
   * Select a category by id, exactly as clicking it in the tree does: the
   * sidebar button IS the selection's owner (it carries `aria-current`), so
   * the breadcrumb drives that button rather than duplicating its work. A
   * collapsed ancestor is expanded first so the tree agrees with the bar.
   */
  async function selectCategoryById(id) {
    const node = categoryIndex.get(id);
    const button = treeEl.querySelector(`[data-category-id="${id}"]`);
    if (!node || !button) return;
    expandAncestors(button);
    await selectCategory(node, button);
  }

  /** One clickable path segment. The open category is marked, not disabled. */
  function renderCrumbLink(segment) {
    const btn = el("button", "crumb-link", segment.name);
    btn.type = "button";
    btn.dataset.categoryId = String(segment.id);
    if (segment.current) {
      btn.classList.add("crumb-current");
      btn.setAttribute("aria-current", "true");
    }
    btn.addEventListener("click", () => {
      closeCrumbMenu();
      void selectCategoryById(segment.id);
    });
    return btn;
  }

  function crumbSeparator() {
    const sep = el("span", "crumb-sep", "›");
    sep.setAttribute("aria-hidden", "true");
    return sep;
  }

  /**
   * The bar's centered title, as a breadcrumb.
   *
   * Everything but the open category lives in `.topbar-crumb`, which is what
   * the CSS caps and what the <=560px bar drops: the leaf - the part that
   * actually names what is open - always survives the one line it gets.
   */
  function renderTitle(categoryId) {
    closeCrumbMenu();
    const path = window.XBOBreadcrumb
      ? window.XBOBreadcrumb.trail(categoryIndex, categoryId)
      : [];
    if (path.length === 0) {
      renderEmptyTitle();
      return;
    }
    updateToolbarVisibility();
    const segments = window.XBOBreadcrumb.layout(path);
    titleEl.replaceChildren();

    const ancestors = el("span", "topbar-crumb");
    for (const segment of segments.slice(0, -1)) {
      ancestors.appendChild(
        segment.kind === "overflow" ? renderCrumbOverflow(segment.items) : renderCrumbLink(segment),
      );
      ancestors.appendChild(crumbSeparator());
    }
    if (ancestors.childElementCount > 0) titleEl.appendChild(ancestors);

    const leaf = renderCrumbLink(segments[segments.length - 1]);
    leaf.classList.add("topbar-leaf");
    titleEl.appendChild(leaf);
    titleEl.title = window.XBOBreadcrumb.pathLabel(path);
  }

  /** The "…" control standing in for the ancestors the bar could not fit. */
  function renderCrumbOverflow(items) {
    const btn = el("button", "crumb-link crumb-overflow", "…");
    btn.type = "button";
    btn.setAttribute("aria-haspopup", "menu");
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-controls", "crumb-menu");
    btn.setAttribute(
      "aria-label",
      `Show ${items.length} more ${items.length === 1 ? "category" : "categories"} in this path`,
    );
    btn.title = window.XBOBreadcrumb.pathLabel(items);
    btn.addEventListener("click", () => {
      if (crumbMenuTrigger === btn && !crumbMenuEl.hidden) closeCrumbMenu();
      else openCrumbMenu(btn, items);
    });
    return btn;
  }

  function crumbMenuItems() {
    return crumbMenuEl ? [...crumbMenuEl.querySelectorAll(".crumb-menu-item")] : [];
  }

  function openCrumbMenu(trigger, items) {
    if (!crumbMenuEl) return;
    crumbMenuEl.replaceChildren(
      ...items.map((segment) => {
        const item = el("button", "crumb-menu-item", segment.name);
        item.type = "button";
        item.setAttribute("role", "menuitem");
        item.tabIndex = -1;
        item.addEventListener("click", () => {
          closeCrumbMenu();
          void selectCategoryById(segment.id);
        });
        return item;
      }),
    );
    crumbMenuEl.hidden = false;
    crumbMenuTrigger = trigger;
    trigger.setAttribute("aria-expanded", "true");
    const first = crumbMenuItems()[0];
    if (first) first.focus();
  }

  /** Close it and hand focus back to the "…" that opened it. */
  function closeCrumbMenu(opts) {
    if (!crumbMenuEl || crumbMenuEl.hidden) return;
    const options = opts || {};
    const trigger = crumbMenuTrigger;
    crumbMenuEl.hidden = true;
    crumbMenuEl.replaceChildren();
    crumbMenuTrigger = null;
    if (trigger && trigger.isConnected) {
      trigger.setAttribute("aria-expanded", "false");
      if (options.returnFocus) trigger.focus();
    }
  }

  function isCrumbMenuOpen() {
    return !!crumbMenuEl && !crumbMenuEl.hidden;
  }

  function initCrumbMenu() {
    if (!crumbMenuEl) return;
    crumbMenuEl.addEventListener("keydown", (e) => {
      const items = crumbMenuItems();
      const move = window.XBOBreadcrumb.menuMove(e.key, items.indexOf(document.activeElement), items.length);
      if (move !== null) {
        e.preventDefault();
        items[move].focus();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        // The menu owns Escape while it is open: without this the sidebar's
        // and the popovers' document-level handlers would close too.
        e.stopPropagation();
        closeCrumbMenu({ returnFocus: true });
      }
    });
    // Tabbing out of the menu, or a click anywhere else, dismisses it; it is a
    // menu, not a dialog, so it must never hold focus hostage.
    crumbMenuEl.addEventListener("focusout", () => {
      window.setTimeout(() => {
        if (isCrumbMenuOpen() && !crumbMenuEl.contains(document.activeElement)) closeCrumbMenu();
      }, 0);
    });
    document.addEventListener("pointerdown", (e) => {
      if (!isCrumbMenuOpen()) return;
      if (crumbMenuEl.contains(e.target) || (crumbMenuTrigger && crumbMenuTrigger.contains(e.target))) return;
      closeCrumbMenu();
    });
  }

  /** Per-tab counts for the selected category, derived from categoryCounts. */
  function tabCounts() {
    return window.XBOTreeCounts.tabCounts(categoryCounts);
  }

  /** How many bookmarks match the active tab in this category. */
  function filteredTotal() {
    return tabCounts()[activeFilter];
  }

  /**
   * Paint each filter tab's count badge (issue #72).
   *
   * Every write is guarded on the value actually changing. Re-paging under a
   * new sort order re-runs this with the very same numbers - a category's
   * counts do not depend on how it is ordered - and writing them back anyway
   * would churn the tab bar's DOM on a change that is only ever about the
   * post list (issue #97).
   */
  function renderCountLine() {
    const counts = tabCounts();
    for (const tab of filterTabButtons()) {
      const badge = tab.querySelector(".filter-tab-count");
      if (!badge) continue;
      const n = String(counts[tab.dataset.filter]);
      if (badge.textContent !== n) badge.textContent = n;
      const label = `${tab.querySelector(".filter-tab-label").textContent}, ${n}`;
      if (tab.getAttribute("aria-label") !== label) tab.setAttribute("aria-label", label);
    }
  }

  /**
   * Show or hide the whole tab bar (PR #95).
   *
   * Unread / Read / All / Favorites are views OF a category, so the bar only
   * exists while one is open AND the library has something in it; the
   * decision itself is the pure `XBOCategorization.showFilterTabs`. In the
   * never-synced first run and the "Select a category" state the bar is
   * ABSENT, not zeroed - which is also the fix for a Reset leaving the old
   * category's badges on screen, since a reset returns the app to the first
   * run and the badges are cleared on the way out.
   *
   * `role="tabpanel"` goes with it: a panel whose tablist is not on screen is
   * a role promise the page cannot keep, and its `aria-labelledby` would
   * point at a hidden tab.
   */
  function updateToolbarVisibility() {
    if (!toolbarEl) return;
    const count = setupState ? setupState.bookmarkCount : undefined;
    const show = categorization().showFilterTabs(count, selectedCategoryId);
    if (!show) clearTabCounts();
    toolbarEl.hidden = !show;
    // The sort selector is a control OF the open category's list too, so it
    // comes and goes with the tabs rather than floating over an empty pane.
    updateSortBarVisibility(show);
    if (show) {
      listRoot.setAttribute("role", "tabpanel");
      renderFilterTabs(); // re-establishes aria-labelledby on the active tab
    } else {
      listRoot.removeAttribute("role");
      listRoot.removeAttribute("aria-labelledby");
    }
  }

  /** No category is settled yet (loading): show no counts rather than stale ones. */
  function clearTabCounts() {
    for (const tab of filterTabButtons()) {
      const badge = tab.querySelector(".filter-tab-count");
      if (badge) badge.textContent = "";
      tab.removeAttribute("aria-label");
    }
  }

  function emptyFilterMessage() {
    if (activeFilter === "unread") return "No unread bookmarks in this category.";
    if (activeFilter === "read") return "No read bookmarks in this category yet.";
    if (activeFilter === "favorite") {
      return "No favorites in this category yet. Star a post to keep it here.";
    }
    return "No bookmarks are filed under this category.";
  }

  /** Fetch one page of the current category under the active filter. */
  function fetchPage(offset) {
    const api = window.XBOSortOrder;
    const sort = api ? api.sortParam(activeSort) : "recent";
    const dir = api ? api.dirParam(activeDir) : "desc";
    const url =
      `/api/categories/${selectedCategoryId}/bookmarks` +
      `?filter=${encodeURIComponent(activeFilter)}&sort=${encodeURIComponent(sort)}` +
      `&dir=${encodeURIComponent(dir)}&offset=${offset}`;
    return getJSON(url);
  }

  /**
   * Fetch and render the first batch of the selected category+filter,
   * resetting all paging state. Only runs on a cache miss - `showCategoryView`
   * restores instantly from `viewCaches` instead when this exact
   * category+filter was already loaded.
   */
  async function fetchAndRenderFirstPage(opts) {
    const seq = ++requestSeq;
    teardownObserver();
    pageLoading = false;
    viewReady = false; // mid-fetch: not safe to cache until this settles
    pageOffset = 0;
    pageHasMore = false;
    // A tab switch inside an open category keeps the current view on screen
    // (dimmed) until the first page lands - never a blank frame between
    // views; anything else shows the gray loading placeholder at once.
    const keep =
      window.XBOFilterCache.loadingStrategy(!(opts && opts.sameCategory), hostMounted) ===
      "keep-content";
    if (keep) {
      listRoot.setAttribute("aria-busy", "true");
    } else {
      currentViewBookmarks = [];
      clearTabCounts();
      ensureViewHost();
      paintViewCards(); // hide the previous view's cards (kept mounted in the pool)
      stateMessage(listEl, "loading", "Loading bookmarks…");
    }

    let data;
    try {
      data = await fetchPage(0);
    } catch (_err) {
      if (seq !== requestSeq) return; // a newer view took over
      currentViewBookmarks = [];
      clearTabCounts();
      ensureViewHost();
      paintViewCards();
      stateMessage(listEl, "error", "Could not load bookmarks for this category.");
      return;
    }
    if (seq !== requestSeq) return; // superseded while awaiting
    if (keep) {
      // Swap in one synchronous step: the old view's cards hide in the same
      // task the new ones show, so no intermediate frame is ever painted.
      currentViewBookmarks = [];
      ensureViewHost();
    }

    viewReady = true;
    categoryCounts = data.counts || emptyCounts();
    // Keep the category's rollup counts fresh in the cache even before this
    // view itself is saved there (e.g. a sibling filter is cached already).
    ensureCategoryCache(selectedCategoryId).counts = categoryCounts;
    pageOffset = data.offset + data.bookmarks.length;
    pageHasMore = Boolean(data.hasMore);

    listEl.replaceChildren();
    if (categoryCounts.total === 0) {
      renderCountLine();
      stateMessage(listEl, "empty", "No bookmarks are filed under this category.");
      return;
    }
    renderCountLine();
    if (data.bookmarks.length === 0) {
      stateMessage(listEl, "empty", emptyFilterMessage());
      return;
    }
    appendToView(data.bookmarks);
    updateTail();
  }

  /** Fetch and append the next batch; a no-op while one is in flight or at end. */
  async function loadMore() {
    if (pageLoading || !pageHasMore) return;
    pageLoading = true;
    const seq = requestSeq;
    setSentinelLoading(true);

    let data;
    try {
      data = await fetchPage(pageOffset);
    } catch (_err) {
      if (seq === requestSeq) {
        pageLoading = false;
        showLoadMoreError(); // surface an inline error with an explicit Retry
      }
      return;
    }
    if (seq !== requestSeq) return; // category/filter changed mid-flight

    pageLoading = false;
    pageOffset = data.offset + data.bookmarks.length;
    pageHasMore = Boolean(data.hasMore);
    if (data.counts) categoryCounts = data.counts;

    removeTail();
    appendToView(data.bookmarks);
    renderCountLine();
    updateTail();
  }

  // ---- infinite-scroll tail (sentinel + end-of-list marker) --------------

  function ensureObserver() {
    if (observer) return;
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            loadMore();
            break;
          }
        }
      },
      // Preload before the owner hits the bottom so scrolling stays smooth.
      { root: contentEl, rootMargin: "400px 0px" },
    );
  }

  function teardownObserver() {
    if (observer) observer.disconnect();
    sentinelEl = null;
  }

  /** Drop the sentinel and end marker, if present, before re-deriving the tail. */
  function removeTail() {
    if (observer && sentinelEl) observer.unobserve(sentinelEl);
    if (sentinelEl) {
      sentinelEl.remove();
      sentinelEl = null;
    }
    const end = listEl.querySelector(".list-end");
    if (end) end.remove();
  }

  /**
   * Append the correct tail after the loaded cards: an observed sentinel while
   * more pages remain, otherwise a clear end-of-list marker.
   */
  function updateTail() {
    removeTail();
    if (pageHasMore) {
      sentinelEl = el("div", "list-sentinel");
      sentinelEl.setAttribute("role", "status");
      sentinelEl.setAttribute("aria-live", "polite");
      listEl.appendChild(sentinelEl);
      ensureObserver();
      observer.observe(sentinelEl);
    } else if (currentViewBookmarks.length > 0) {
      const end = el("p", "list-end");
      end.setAttribute("role", "status");
      end.textContent = `You've reached the end · ${filteredTotal()} shown`;
      listEl.appendChild(end);
    }
  }

  /**
   * Replace the tail with an inline error + Retry when a batch fails to load.
   * An IntersectionObserver only re-fires on an intersection change, so a user
   * parked at the bottom would otherwise see a silent, stuck end-of-list; the
   * button re-attempts the fetch on demand and restores normal paging.
   */
  function showLoadMoreError() {
    removeTail();
    const box = el("div", "list-error");
    box.setAttribute("role", "alert");
    box.appendChild(el("p", "list-error-msg", "Couldn't load more posts."));
    const retry = el("button", "btn btn-secondary list-retry", "Retry");
    retry.type = "button";
    retry.addEventListener("click", () => {
      box.remove();
      updateTail(); // re-add the observed sentinel
      loadMore(); // and fetch immediately rather than waiting for a scroll
    });
    box.appendChild(retry);
    listEl.appendChild(box);
  }

  /** Show or clear the "Loading more…" spinner inside the sentinel. */
  function setSentinelLoading(loading) {
    if (!sentinelEl) return;
    sentinelEl.classList.toggle("is-loading", loading);
    sentinelEl.replaceChildren();
    if (loading) {
      const spinner = el("span", "list-spinner");
      spinner.setAttribute("aria-hidden", "true");
      sentinelEl.append(spinner, el("span", "list-sentinel-label", "Loading more…"));
    }
  }

  /**
   * A single action row above the post: a left-aligned group (read/unread
   * toggle, the favorite star, then Summarize/Summary) and a right-aligned
   * group (delete only - opening the post on X is already reachable by
   * clicking the card/embed, see #54). No author line - the embed (or the
   * fallback's own byline) already carries who posted it.
   */
  function renderCard(bm) {
    const card = el("article", "bookmark-card");
    if (!bm.read) card.classList.add("is-unread");
    card.dataset.bookmarkId = String(bm.id);

    const actions = el("div", "bookmark-actions");

    const left = el("div", "bookmark-actions-group bookmark-actions-left");
    // The drag handle leads the row, LEFT of the read chip (issue #92).
    left.appendChild(renderDragHandle(bm, card));
    left.appendChild(renderPill(bm, card));
    left.appendChild(renderFavoriteButton(bm, card));
    // "Move to a category", between Favorite and Summarize.
    left.appendChild(renderMoveButton(bm, card));

    const summarizeBtn = el("button", "link-external summarize-link");
    summarizeBtn.type = "button";
    applySummarizeButtonLabel(summarizeBtn, bm.hasSummary);
    // A saved summary can always be re-opened from cache, with no provider
    // needed; generating a NEW one needs the provider to be available.
    if (!summaryAvailable && !bm.hasSummary) {
      summarizeBtn.disabled = true;
      summarizeBtn.title = summaryUnavailableReason;
    } else {
      summarizeBtn.addEventListener("click", () => openSummary(bm, summarizeBtn));
    }
    left.appendChild(summarizeBtn);

    const right = el("div", "bookmark-actions-group bookmark-actions-right");

    const scoreChip = renderScoreChip(bm, card);
    if (scoreChip) right.appendChild(scoreChip);

    const deleteBtn = el("button", "icon-btn delete-btn");
    deleteBtn.type = "button";
    deleteBtn.setAttribute("aria-label", "Delete bookmark");
    deleteBtn.title = "Delete bookmark";
    deleteBtn.appendChild(trashIcon());
    deleteBtn.addEventListener("click", () => deleteBookmark(bm, card));
    right.appendChild(deleteBtn);

    actions.append(left, right);

    // Embed slot with link fallback. Opening the fallback link also marks read.
    const slot = el("div", "embed-slot");
    card.append(actions, slot);
    mountEmbed(bm, card, slot);

    // X-native Article card (x.com/i/article/...): X's embed shows these as a
    // bare link, so render the Article's cover/title/preview from the X API
    // data stored at ingest. Independent of external links - those get X's
    // own card inside the embed.
    const xArticleCard = renderXArticleCard(bm, card);
    if (xArticleCard) card.appendChild(xArticleCard);

    return card;
  }

  /** Cover aspect ratio, clamped so an odd cover never dominates the card. */
  const X_ARTICLE_COVER_RATIO = { min: 1.5, max: 3, fallback: 2.5 };

  /**
   * The "X Article" card for a bookmark that hosts or quotes an X Article:
   * cover (when there is one), label, title and a 2-line preview, as one
   * link to the Article. Returns null for every other bookmark.
   */
  function renderXArticleCard(bm, card) {
    const article = bm.xArticle;
    if (!article || !(article.title || article.previewText)) return null;

    const link = el("a", "x-article-card");
    link.href = article.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    const label = article.quoted ? "Quoted X Article" : "X Article";
    link.setAttribute(
      "aria-label",
      `${label}: ${article.title || article.previewText} (opens on X in a new tab)`,
    );

    if (article.coverUrl) {
      const cover = el("div", "x-article-cover");
      const { coverWidth: w, coverHeight: h } = article;
      const ratio = w > 0 && h > 0 ? w / h : X_ARTICLE_COVER_RATIO.fallback;
      const clamped = Math.min(X_ARTICLE_COVER_RATIO.max, Math.max(X_ARTICLE_COVER_RATIO.min, ratio));
      cover.style.setProperty("--x-article-cover-ratio", String(clamped));
      const img = document.createElement("img");
      img.className = "x-article-cover-image";
      img.src = article.coverUrl;
      img.alt = "";
      img.loading = "lazy";
      img.decoding = "async";
      // A cover that fails to load drops out rather than leaving a broken box.
      img.addEventListener("error", () => cover.remove());
      cover.appendChild(img);
      link.appendChild(cover);
    }

    const body = el("div", "x-article-body");
    const kicker = el("p", "x-article-label");
    kicker.appendChild(articleIcon());
    kicker.appendChild(document.createTextNode(label));
    body.appendChild(kicker);
    if (article.title) body.appendChild(el("p", "x-article-title", article.title));
    if (article.previewText) body.appendChild(el("p", "x-article-preview", article.previewText));
    link.appendChild(body);

    // Following the link out counts as engaging with the bookmark, exactly
    // like "Open on X" does.
    link.addEventListener("click", () => setRead(bm, card, true));
    return link;
  }

  function articleIcon() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 20 20");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("class", "x-article-icon");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute(
      "d",
      "M5 3h10a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Zm2 3.5h6M7 9.5h6M7 12.5h4",
    );
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.5");
    path.setAttribute("stroke-linecap", "round");
    svg.appendChild(path);
    return svg;
  }

  function starIcon() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 20 20");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.classList.add("icon-star");
    svg.innerHTML =
      '<path d="M10 2.6l2.3 4.7 5.2.76-3.75 3.66.88 5.18L10 14.45l-4.63 2.45.88-5.18L2.5 8.06l5.2-.76L10 2.6z" ' +
      'stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />';
    return svg;
  }

  /**
   * The favorite star (issue #63), beside the read toggle. `aria-pressed`
   * carries the state and the star fills in when it is on, so the state
   * never rests on color alone. A click persists immediately; the button
   * shows its loading state and reverts if the request fails.
   */
  function renderFavoriteButton(bm, card) {
    const btn = el("button", "icon-btn fav-btn");
    btn.type = "button";
    btn.appendChild(starIcon());
    applyFavoriteButtonState(btn, bm.favorite);
    btn.addEventListener("click", () => setFavorite(bm, card, !bm.favorite));
    return btn;
  }

  function applyFavoriteButtonState(btn, favorite) {
    btn.setAttribute("aria-pressed", String(Boolean(favorite)));
    const label = favorite ? "Remove from favorites" : "Add to favorites";
    btn.setAttribute("aria-label", label);
    btn.title = label;
  }

  function gripIcon() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 20 20");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.classList.add("icon-grip");
    svg.innerHTML =
      '<g fill="currentColor">' +
      '<circle cx="7.5" cy="5" r="1.5"/><circle cx="12.5" cy="5" r="1.5"/>' +
      '<circle cx="7.5" cy="10" r="1.5"/><circle cx="12.5" cy="10" r="1.5"/>' +
      '<circle cx="7.5" cy="15" r="1.5"/><circle cx="12.5" cy="15" r="1.5"/></g>';
    return svg;
  }

  /** Folder with an arrow entering it: "file this post somewhere else". */
  function moveIcon() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 20 20");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.classList.add("icon-move");
    svg.innerHTML =
      '<path d="M2.5 15.2V5.4a1 1 0 0 1 1-1h3.3l1.5 1.8h7.2a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-12a1 1 0 0 1-1-1z" ' +
      'fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />' +
      '<path d="M7.4 11h5M10.4 8.8l2.2 2.2-2.2 2.2" fill="none" stroke="currentColor" ' +
      'stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />';
    return svg;
  }

  function checkIcon() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 20 20");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.classList.add("icon-check");
    svg.innerHTML =
      '<path d="M4.5 10.5l3.6 3.6 7.4-8" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round" />';
    return svg;
  }

  /**
   * The card's drag handle (issue #92): press and drag it onto a category in
   * the sidebar to re-file the post there.
   *
   * It is a real button, and pressing it (click, Enter or Space) opens the
   * picker modal - the same destination the drag reaches. A focusable control
   * that only answers to a pointer gesture would be a dead stop for the
   * keyboard, and "drag me" is not a promise a keyboard can keep.
   */
  function renderDragHandle(bm, card) {
    const handle = el("button", "icon-btn card-grip");
    handle.type = "button";
    handle.setAttribute("aria-label", "Move to another category");
    handle.title = "Drag onto a category, or press to choose one";
    handle.appendChild(gripIcon());
    handle.addEventListener("pointerdown", (e) => startCardDrag(e, handle, bm, card));
    handle.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      openMovePicker(bm, card, handle);
    });
    return handle;
  }

  /** "Move to a category" - the picker's own trigger, between Favorite and Summarize. */
  function renderMoveButton(bm, card) {
    const btn = el("button", "icon-btn move-btn");
    btn.type = "button";
    btn.setAttribute("aria-haspopup", "dialog");
    btn.setAttribute("aria-label", "Move to a category");
    btn.title = "Move to a category";
    btn.appendChild(moveIcon());
    btn.addEventListener("click", () => openMovePicker(bm, card, btn));
    return btn;
  }

  function trashIcon() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 20 20");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.classList.add("icon-trash");
    svg.innerHTML =
      '<path d="M7.5 3.5h5M4 6h12M6 6l.6 9.4a1 1 0 0 0 1 .9h4.8a1 1 0 0 0 1-.9L14 6M8.3 9v4M11.7 9v4" ' +
      'fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />';
    return svg;
  }

  function sparkleIcon() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 20 20");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.classList.add("icon-sparkle");
    svg.innerHTML =
      '<path d="M9.5 3l1.1 3.4L14 7.5l-3.4 1.1L9.5 12l-1.1-3.4L5 7.5l3.4-1.1L9.5 3z ' +
      'M15 12.5l.55 1.7L17.25 15l-1.7.55L15 17.25l-.55-1.7L12.75 15l1.7-.55L15 12.5z" ' +
      'fill="currentColor" stroke="currentColor" stroke-width="0.6" stroke-linejoin="round" />';
    return svg;
  }

  /**
   * Sets the Summarize/Summary button's label, icon and visual state.
   * "Summary" (a saved summary already exists) is styled distinctly from
   * "Summarize" (generates on demand) but shares the same control shape.
   */
  function applySummarizeButtonLabel(btn, hasSummary) {
    btn.replaceChildren(sparkleIcon(), document.createTextNode(hasSummary ? "Summary" : "Summarize"));
    btn.classList.toggle("has-summary", hasSummary);
  }

  /**
   * The ranking score (issue #62), as a compact rating beside the card's other
   * controls - or, for a bookmark the paid pass has never scored, the EMPTY
   * badge below (issue #98). Unranked is not a score of zero, so the two look
   * and read as different things, never as a bad verdict.
   *
   * The number alone is an unexplained verdict, so the chip reveals the rubric
   * breakdown behind it: a small graph on hover, on keyboard focus and on tap.
   * That is why it is a real `<button>` rather than the plain span it started
   * as - hover is not a keyboard or touch gesture, and a focusable element with
   * a click contract is the cheapest way to have all three. The whole verdict
   * also stays on the chip's `aria-label`, so a screen reader is told it in
   * prose and the popover it opens is only a drawing of what it already heard
   * (hence the popover's `aria-hidden`, and no `aria-expanded` claiming to
   * reveal something to AT).
   */
  function renderScoreChip(bm, cardEl) {
    if (!window.XBOSortOrder) return null;
    const breakdown = window.XBOSortOrder.scoreBreakdown(bm.score);
    if (breakdown === null) return renderEmptyScoreChip(bm, cardEl);

    const chip = el("button", "score-chip");
    chip.type = "button";
    chip.appendChild(gaugeIcon());
    chip.appendChild(el("span", "score-chip-value", breakdown.rating));
    const description = window.XBOSortOrder.describeScore(bm.score);
    if (description) chip.setAttribute("aria-label", description);

    // Hover is mouse-only on purpose: a touch `pointerenter` fires immediately
    // before the `click` that follows it, so without the guard a tap would
    // open the graph and then instantly toggle it shut again.
    chip.addEventListener("pointerenter", (e) => {
      if (e.pointerType === "mouse") openScoreDetail(chip, breakdown);
    });
    chip.addEventListener("pointerleave", (e) => {
      // A chip the keyboard is sitting on keeps its graph when the pointer
      // merely passes over it.
      if (e.pointerType === "mouse" && document.activeElement !== chip) closeScoreDetail();
    });
    // `:focus-visible` rather than plain focus: a mouse click focuses the chip
    // too, and opening from that would fight the click's own toggle.
    chip.addEventListener("focus", () => {
      if (chip.matches(":focus-visible")) openScoreDetail(chip, breakdown);
    });
    chip.addEventListener("blur", () => {
      if (scoreDetailAnchor === chip) closeScoreDetail();
    });
    chip.addEventListener("click", () => {
      if (scoreDetailAnchor === chip) closeScoreDetail();
      else openScoreDetail(chip, breakdown);
    });
    return chip;
  }

  /**
   * The badge an UNRANKED post carries (issue #98): an explicit "no verdict
   * yet, rank this one" affordance, and the entry point to the per-post run.
   *
   * It is deliberately NOT a zero, and must never read as one. Absent means
   * never judged (`AGENTS.md`: an absent `bookmark_scores` row is "never
   * ranked", which is also why `sort=score` files these last in BOTH
   * directions), so the badge shows a dash, wears its own muted outline style
   * rather than the filled chip's, and says so in its accessible name.
   *
   * Pressing it is the same paid decision as "Rank now", only narrower: it
   * opens the same confirmation, which is what sends `{ confirm: true }`.
   */
  function renderEmptyScoreChip(bm, cardEl) {
    const chip = el("button", "score-chip is-empty");
    chip.type = "button";
    chip.appendChild(gaugeIcon());
    chip.appendChild(el("span", "score-chip-value", "\u2013"));
    chip.setAttribute(
      "aria-label",
      "Not ranked yet. Rank this bookmark - a paid run you confirm first.",
    );
    chip.title = "Not ranked yet - rank this bookmark";
    chip.addEventListener("click", () => openRankOneConfirm(bm, cardEl || chip.closest(".bookmark-card")));
    return chip;
  }

  // ---- score breakdown popover -------------------------------------------
  // ONE popover shared by every chip, mounted on <body> (see index.html for
  // why it cannot live inside a card). It holds no state of its own beyond
  // which chip opened it.
  const scoreDetailEl = document.getElementById("score-detail");
  let scoreDetailAnchor = null;

  /**
   * Draw one rubric question as a labelled meter.
   *
   * Length is the only magnitude channel - every bar wears the same accent
   * hue, because shading it by value as well would encode the same number
   * twice. Each bar carries its own 0..10 rating as a direct label, which is
   * what lets the graph do without an axis at this size.
   */
  function renderScoreDetailRow(dimension) {
    const row = el("li", "score-detail-row");
    row.appendChild(el("span", "score-detail-name", dimension.label));
    row.appendChild(el("span", "score-detail-value", dimension.rating));
    const track = el("span", "score-detail-track");
    const fill = el("span", "score-detail-fill");
    fill.style.width = `${dimension.percent}%`;
    track.appendChild(fill);
    row.appendChild(track);
    return row;
  }

  function renderScoreDetail(breakdown) {
    const head = el("div", "score-detail-head");
    head.appendChild(el("span", "score-detail-label", "Ranking score"));
    head.appendChild(el("span", "score-detail-rating", breakdown.rating));
    head.appendChild(el("span", "score-detail-scale", "/ 10"));

    const nodes = [head];
    if (breakdown.confidencePercent !== null) {
      nodes.push(el("p", "score-detail-confidence", `${breakdown.confidencePercent}% model confidence`));
    }
    if (breakdown.dimensions.length > 0) {
      const rows = el("ul", "score-detail-rows");
      for (const dimension of breakdown.dimensions) rows.appendChild(renderScoreDetailRow(dimension));
      nodes.push(rows);
    } else {
      // A score stored without a readable breakdown blob still has a total
      // worth showing; the graph just has nothing to draw (see the tolerant
      // `dimensions` read in `src/db/database.ts`).
      nodes.push(el("p", "score-detail-empty", "No per-question breakdown was stored for this score."));
    }
    scoreDetailEl.replaceChildren(...nodes);
  }

  /**
   * Anchor the popover to its chip: centred under it, flipped above when it
   * would run off the bottom, and clamped into the viewport's gutters either
   * way so nothing is ever half off-screen on a narrow window.
   */
  function positionScoreDetail(anchor) {
    const gutter = 8;
    const rect = anchor.getBoundingClientRect();
    const width = scoreDetailEl.offsetWidth;
    const height = scoreDetailEl.offsetHeight;

    let top = rect.bottom + gutter;
    if (top + height > window.innerHeight - gutter) top = rect.top - gutter - height;
    top = Math.max(gutter, Math.min(top, window.innerHeight - gutter - height));

    let left = rect.left + rect.width / 2 - width / 2;
    left = Math.max(gutter, Math.min(left, window.innerWidth - gutter - width));

    scoreDetailEl.style.top = `${Math.round(top)}px`;
    scoreDetailEl.style.left = `${Math.round(left)}px`;
  }

  function openScoreDetail(anchor, breakdown) {
    if (!scoreDetailEl) return;
    scoreDetailAnchor = anchor;
    renderScoreDetail(breakdown);
    scoreDetailEl.hidden = false;
    positionScoreDetail(anchor);
    // One frame with the popover laid out but still transparent, so the fade
    // has something to run from (`prefers-reduced-motion` drops it in CSS).
    requestAnimationFrame(() => {
      if (scoreDetailAnchor === anchor) scoreDetailEl.classList.add("is-open");
    });
  }

  function closeScoreDetail(opts) {
    if (!scoreDetailEl || scoreDetailAnchor === null) return;
    const anchor = scoreDetailAnchor;
    scoreDetailAnchor = null;
    scoreDetailEl.classList.remove("is-open");
    scoreDetailEl.hidden = true;
    scoreDetailEl.replaceChildren();
    if (opts && opts.returnFocus && anchor.isConnected) anchor.focus();
  }

  function initScoreDetail() {
    if (!scoreDetailEl) return;
    // The content pane scrolls under a fixed popover, and a card can be
    // re-sequenced or dropped from the pool while it is open, so the anchor is
    // re-read rather than trusted.
    const reflow = () => {
      if (scoreDetailAnchor === null) return;
      if (!scoreDetailAnchor.isConnected) {
        closeScoreDetail();
        return;
      }
      positionScoreDetail(scoreDetailAnchor);
    };
    window.addEventListener("scroll", reflow, true);
    window.addEventListener("resize", reflow);
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || scoreDetailAnchor === null) return;
      // The popover owns Escape while it is open, so dismissing it does not
      // also close the sidebar drawer or a popover in the top bar.
      e.stopPropagation();
      closeScoreDetail({ returnFocus: true });
    });
    document.addEventListener("pointerdown", (e) => {
      if (scoreDetailAnchor === null || scoreDetailAnchor.contains(e.target)) return;
      closeScoreDetail();
    });
  }

  /** A small gauge, so the chip reads as a rating rather than a bare number. */
  function gaugeIcon() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "icon icon-gauge");
    svg.setAttribute("viewBox", "0 0 20 20");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.innerHTML =
      '<path d="M3.5 14a7 7 0 1 1 13 0" fill="none" stroke="currentColor" stroke-width="1.6" ' +
      'stroke-linecap="round" />' +
      '<path d="M10 13.5 13.2 8.6" fill="none" stroke="currentColor" stroke-width="1.6" ' +
      'stroke-linecap="round" />';
    return svg;
  }

  /**
   * The read/unread toggle button: a click flips it. An unread post's label
   * names the ACTION a click performs ("Mark as read"); a read post's label
   * is its STATE ("Read"), not a second action label (issue #54). Either
   * way it stays clickable - clicking "Read" marks it unread again. Both
   * states render as a colored dot + label, in distinct colors; the read
   * timestamp is still stored (see `bm.readAt`) but never shown here.
   */
  function renderPill(bm, card) {
    const pill = el("button", "read-pill");
    pill.type = "button";
    pill.appendChild(el("span", "dot"));
    pill.classList.add(bm.read ? "is-read" : "is-unread");
    pill.appendChild(document.createTextNode(window.XBOReadToggle.readToggleLabel(bm.read)));
    pill.addEventListener("click", () => setRead(bm, card, !bm.read));
    return pill;
  }

  // Backstop: if widgets.js loads but createTweet never settles (network stall
  // on the embed iframe), resolve to the link fallback rather than spinning
  // forever. whenWidgetsReady already bounds the "never loads" case at 15s.
  const EMBED_RENDER_TIMEOUT_MS = 20000;

  /**
   * Build this card's embed for the CURRENT theme as a new `.embed-variant`
   * inside its slot, and show it. Any variant already there (the one for the
   * other theme) stays MOUNTED and merely hidden, so toggling back reveals it
   * without reloading - X hands a widget its theme at creation and offers no
   * way to change it afterwards, which is why a post needs one embed per
   * theme rather than one embed that follows the toggle (issues #89, #90).
   */
  function mountEmbed(bm, card, slot, opts) {
    const host = slot || card.querySelector(".embed-slot");
    if (!host) return;
    const variant = el("div", "embed-variant");
    variant.dataset.embedTheme = isDarkTheme() ? "dark" : "light";
    host.appendChild(variant);
    showEmbedVariant(host, variant);
    touchVariantPool([window.XBOEmbedTheme.variantKey(bm.id, variant.dataset.embedTheme)]);
    renderEmbed(variant, bm, () => setRead(bm, card, true), opts);
  }

  /**
   * The post's own author + text, as the loading placeholder's content
   * (issue #104), or null for a stored row that carries neither - there is
   * nothing to preview then, and the bare spinner is still the honest state.
   *
   * `aria-hidden`: the loader is already a `role="status"` announcing
   * "Loading post…", and the same prose is about to arrive for real in the
   * embed (or in the fallback, which carries its own byline). Reading it twice
   * would make a refresh of twenty posts unusable with a screen reader.
   */
  function renderEmbedPreview(bm) {
    if (!bm.text && !bm.authorUsername) return null;
    const preview = el("div", "embed-preview");
    preview.setAttribute("aria-hidden", "true");
    if (bm.authorUsername) {
      const author = el("p", "embed-preview-author");
      author.append(document.createTextNode(bm.authorName || bm.authorUsername));
      author.appendChild(el("span", "bookmark-handle", ` @${bm.authorUsername}`));
      preview.appendChild(author);
    }
    if (bm.text) preview.appendChild(el("p", "embed-preview-text", bm.text));
    return preview;
  }

  function renderEmbed(variant, bm, onOpen, opts) {
    const options = opts || {};
    // A variant can be released while its createTweet is still in flight (the
    // LRU dropping a spare theme copy, or the whole post leaving the pool).
    // Such a call must stay silent: settling would clear the `min-height` the
    // slot is holding for the variant that REPLACED it, collapsing the column
    // under the reader. The card is still detached while it renders, so this
    // is only ever consulted from the async paths below.
    const abandoned = () => !variant.isConnected;
    const settle = () => {
      if (options.onSettled) options.onSettled();
    };
    // Show a placeholder immediately and reveal only the finished result: the
    // official embed once widgets.js reports it fully rendered, or the
    // text+link fallback on failure/timeout/non-embeddable post.
    //
    // The placeholder carries the post's OWN author and text when the stored
    // row has them (issue #104). A reload restores the whole list from the
    // sessionStorage snapshot without a single server round trip, but every
    // X embed still has to be rebuilt by X's widgets.js - so a list of blank
    // shimmering boxes was the entire visible experience of a refresh, and it
    // read as "the posts are loading again" even though no post was fetched.
    // This narrows the earlier rule (an embed must not be preceded by raw
    // text that then "pops"): the preview is visibly a LOADING state - muted,
    // clamped, spinner alongside - not content presented as final, and the
    // shimmer steps aside for it since the text is the better skeleton.
    const loader = el("div", "embed-loader");
    loader.setAttribute("role", "status");
    loader.setAttribute("aria-label", "Loading post…");
    const preview = renderEmbedPreview(bm);
    if (preview) {
      loader.dataset.preview = "1";
      loader.appendChild(preview);
    }
    const spinner = el("span", "embed-spinner");
    spinner.setAttribute("aria-hidden", "true");
    loader.appendChild(spinner);
    // The embed renders into its own host (empty, so nothing shows until X is
    // done); the loader sits alongside it and is removed on resolve.
    const embedHost = el("div", "embed-host");
    variant.append(loader, embedHost);

    let settled = false;

    function showFallback() {
      if (settled || abandoned()) return;
      settled = true;
      loader.remove();
      embedHost.remove();
      const fallback = el("div", "embed-fallback");
      // The card itself carries no author line (the embed normally shows
      // it); a fallback has no embed, so it needs its own byline to avoid
      // leaving the post with zero context about who posted it.
      const author = el("p", "embed-fallback-author");
      author.append(document.createTextNode(bm.authorName || bm.authorUsername));
      author.appendChild(el("span", "bookmark-handle", ` @${bm.authorUsername}`));
      fallback.appendChild(author);
      if (bm.text) fallback.appendChild(el("p", null, bm.text));
      const link = el("a", "link-external", "View this post on X ↗");
      link.href = bm.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      if (onOpen) link.addEventListener("click", onOpen);
      fallback.appendChild(link);
      variant.dataset.embedFallback = "1";
      variant.appendChild(fallback);
      settle();
    }

    function showEmbed() {
      if (settled || abandoned()) return;
      settled = true;
      loader.remove(); // the rendered embed already lives in embedHost
      settle();
    }

    const backstop = setTimeout(showFallback, EMBED_RENDER_TIMEOUT_MS);

    // widgets.js loads async, so on the first card it may not be ready yet.
    // Wait for it (rather than committing to the fallback) so embeds appear.
    whenWidgetsReady().then((twttr) => {
      if (settled) return;
      if (abandoned()) {
        clearTimeout(backstop);
        settled = true;
        return;
      }
      if (!twttr) {
        clearTimeout(backstop);
        showFallback(); // widgets.js never loaded
        return;
      }
      twttr.widgets
        .createTweet(bm.postId, embedHost, {
          theme: variant.dataset.embedTheme === "dark" ? "dark" : "light",
          conversation: "none",
        })
        .then((embedded) => {
          clearTimeout(backstop);
          // createTweet resolves with the element on success, undefined for a
          // deleted/protected post that can't be embedded.
          if (embedded) showEmbed();
          else showFallback();
        })
        .catch(() => {
          clearTimeout(backstop);
          showFallback();
        });
    });
  }

  // Resolves with window.twttr once the widget factory is usable, or null if it
  // never loads. Memoized so every card shares one wait.
  let widgetsReadyPromise = null;
  function whenWidgetsReady() {
    if (widgetsReadyPromise) return widgetsReadyPromise;
    widgetsReadyPromise = new Promise((resolve) => {
      const usable = () => window.twttr && window.twttr.widgets && window.twttr.widgets.createTweet;
      if (usable()) return resolve(window.twttr);
      const start = Date.now();
      const timer = setInterval(() => {
        if (usable()) {
          clearInterval(timer);
          resolve(window.twttr);
        } else if (Date.now() - start > 15000) {
          clearInterval(timer);
          resolve(null); // widgets.js unavailable; fallbacks stay
        }
      }, 150);
    });
    return widgetsReadyPromise;
  }

  // ---- leaving the live view (#95, #99) -----------------------------
  // Marking a post read in the Unread tab used to make it disappear on the
  // spot and the next post jump up into its place. It is now a movement with
  // a direction, and since issue #99 the direction MEANS something: the
  // Unread and Read tabs sit side by side in that order, so a post marked
  // read slides RIGHT - towards the tab it is joining - and a post marked
  // unread slides LEFT, back the way it came. Either way it fades, and only
  // then do the posts below travel up to close the gap. `transform` and
  // `opacity` only, on both halves - the gap is closed with a FLIP, never by
  // animating a layout property. Which way is the pure
  // `XBOReadToggle.readExitDirection`; this half is the animation.

  const reducedMotion =
    typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)")
      : { matches: false };

  /** How far the card travels, as a share of its own width. */
  const EXIT_SLIDE_DISTANCE = "22%";
  /** Leaving accelerates away (the arrival back uses the token layer's ease). */
  const EXIT_EASE = "cubic-bezier(0.4, 0, 1, 1)";

  /**
   * A motion token's duration in milliseconds. The Web Animations API needs a
   * number, and reading it back from the token layer keeps `styles.css` the
   * one place the app's motion scale is defined.
   */
  function motionMs(token, fallback) {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
    const value = parseFloat(raw);
    if (!Number.isFinite(value) || value <= 0) return fallback;
    return /ms$/.test(raw) ? value : value * 1000;
  }

  /** The token layer's own easing curve, for the settling half of a move. */
  function easeToken() {
    return getComputedStyle(document.documentElement).getPropertyValue("--ease").trim()
      || "cubic-bezier(0.2, 0, 0, 1)";
  }

  /**
   * The post-size setting applies `zoom` to a card, and an element's own
   * `transform` resolves in its ZOOMED coordinate space - so a distance
   * measured in screen pixels has to be divided by this before it can be fed
   * to a translate. (The slide itself is a percentage of the card, which
   * needs no such correction.)
   */
  function cardZoom(cardEl) {
    const raw = parseFloat(getComputedStyle(cardEl).getPropertyValue("--post-scale"));
    return Number.isFinite(raw) && raw > 0 ? raw : 1;
  }

  /**
   * The visible pooled cards sequenced after `card` - the ones that will move
   * up when it leaves. Cards are ordered by inline `order`, not by DOM
   * position (the pool never moves a card), so that is what decides "after".
   */
  function cardsAfter(card) {
    const from = Number(card.style.order);
    const after = [];
    for (const pooled of cardPool.values()) {
      const other = pooled.card;
      if (other === card || other.hidden) continue;
      if (Number(other.style.order) > from) after.push(other);
    }
    return after;
  }

  /**
   * Slide `card` out of the live view, then run `commit` - which does the real
   * bookkeeping (hiding the card, splicing it out of the view, repainting the
   * counts) and is called exactly ONCE either way, so a browser without the
   * Web Animations API and an owner who asked for reduced motion both get
   * today's instant hide and nothing else changes.
   *
   * The card is hidden, never detached: it stays pooled with its mounted X
   * embeds, which is what stops a post reappearing in another tab from
   * reloading (issues #67, #89). The animation only borrows it on the way out,
   * and the fill is released once it is hidden so a later reveal is clean.
   */
  function animateCardExit(card, commit, direction) {
    if (reducedMotion.matches || typeof card.animate !== "function" || card.hidden) {
      commit();
      return;
    }
    const followers = cardsAfter(card);
    const before = followers.map((other) => other.getBoundingClientRect().top);
    const travel = window.XBOReadToggle.exitTranslate(direction || "right", EXIT_SLIDE_DISTANCE);
    const slide = card.animate(
      [
        { transform: "translateX(0)", opacity: 1 },
        { transform: travel, opacity: 0 },
      ],
      { duration: motionMs("--motion-slow", 260), easing: EXIT_EASE, fill: "forwards" },
    );
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      commit(); // the card is hidden here: the gap opens on this frame
      slide.cancel(); // release the held end state before it can be re-shown
      const collapse = motionMs("--motion-med", 200);
      const ease = easeToken();
      followers.forEach((other, i) => {
        if (other.hidden) return;
        const delta = (before[i] - other.getBoundingClientRect().top) / cardZoom(other);
        if (Math.abs(delta) < 1) return;
        other.animate(
          [{ transform: `translateY(${delta}px)` }, { transform: "translateY(0)" }],
          { duration: collapse, easing: ease },
        );
      });
    };
    slide.addEventListener("finish", finish);
    slide.addEventListener("cancel", finish);
  }

  /**
   * A bookmark no longer belongs in the tab that is open: animate its card out
   * and settle the view behind it.
   *
   * The bookkeeping is unchanged from when this was inlined twice. That row
   * also left the server-side filtered set, so the paging offset shifts back
   * by one to keep the next batch aligned; an emptied view pulls the next
   * batch in if there is one, and otherwise says so.
   *
   * The COUNTS are not in here: the caller settles them before the exit
   * starts, so a tab badge never lags the sidebar counter it has to agree
   * with by the length of an animation.
   */
  function dropCardFromView(bm, card, direction) {
    animateCardExit(card, () => commitCardOut(bm, card), direction);
  }

  /**
   * The bookkeeping half of a card leaving the view, shared by every exit
   * (read/favorite drop-out, and the re-file of issue #92) so the two
   * animations differ only in their motion.
   */
  function commitCardOut(bm, card) {
    card.hidden = true; // stays pooled and mounted: no reload if it reappears
    const idx = currentViewBookmarks.indexOf(bm);
    if (idx !== -1) currentViewBookmarks.splice(idx, 1);
    pageOffset = Math.max(0, pageOffset - 1);
    if (currentViewBookmarks.length > 0) {
      updateTail(); // keep the "N shown" end-of-list marker in step
    } else if (pageHasMore) {
      // Emptied the visible view but more remain: pull the next batch in.
      loadMore();
    } else {
      removeTail();
      stateMessage(listEl, "empty", emptyFilterMessage());
    }
  }

  /**
   * A moved post leaves the view with ONLY the settling half of the exit
   * above (issue #92, the owner's call): the cards below FLIP up to close the
   * gap and the card itself simply goes - no sideways travel, no fade. A
   * re-file is not a dismissal, so the card is not swept away; the list just
   * closes over where it was.
   *
   * Same three load-bearing properties as `animateCardExit`: `commit` runs
   * exactly once (so reduced motion and a browser without the Web Animations
   * API both fall through to an instant hide), the card is hidden rather than
   * detached (keeping it pooled with its mounted X embeds), and the FLIP
   * delta is divided by the card's own `zoom`.
   */
  function reflowCardOut(bm, card) {
    const commit = () => commitCardOut(bm, card);
    if (reducedMotion.matches || typeof card.animate !== "function" || card.hidden) {
      commit();
      return;
    }
    const followers = cardsAfter(card);
    const before = followers.map((other) => other.getBoundingClientRect().top);
    commit(); // the gap opens on this frame; the cards below close it below
    const collapse = motionMs("--motion-med", 200);
    const ease = easeToken();
    followers.forEach((other, i) => {
      if (other.hidden) return;
      const delta = (before[i] - other.getBoundingClientRect().top) / cardZoom(other);
      if (Math.abs(delta) < 1) return;
      other.animate([{ transform: `translateY(${delta}px)` }, { transform: "translateY(0)" }], {
        duration: collapse,
        easing: ease,
      });
    });
  }

  // ---- read tracking -----------------------------------------------------

  /**
   * Set a bookmark's read state (the chip toggles both ways; opening a post
   * only ever sets it to read). Reflects the change immediately: the pill is
   * swapped, counts are kept in step, the sidebar badges refresh, and a card
   * that no longer matches the active Unread/Read filter drops out of view.
   */
  async function setRead(bm, card, read) {
    if (bm.read === read) return;
    const pillBtn = card.querySelector(".read-pill");
    if (pillBtn) {
      pillBtn.classList.add("is-loading");
      pillBtn.disabled = true;
    }
    try {
      const data = await postJSON(`/api/bookmarks/${bm.id}/read`, { read });
      const updated = data.bookmark;
      bm.read = updated.read;
      bm.readAt = updated.readAt;
      if (read) {
        if (categoryCounts.unread > 0) categoryCounts.unread -= 1;
      } else {
        categoryCounts.unread += 1;
      }
      // Patch only the sidebar counters for this bookmark's categories (and
      // their ancestors) in place - NOT a full tree reload, which used to
      // flicker the whole sidebar and lose scroll/expand-collapse state.
      updateSidebarCounts(bm, 0, read ? -1 : 1);
      // A read-state change can flip which cached Unread/Read view a post
      // belongs to for every category it's filed under; keep every OTHER
      // cached view (not the one on screen, patched below) consistent.
      syncCachedViewsOnChange(bm);

      patchCardControls(bm, card); // the pooled card is reused by other tabs
      // Only the two read-state tabs' membership turns on this toggle - a
      // post is not un-starred by being read, so the Favorites tab keeps it.
      const dropsOut =
        (activeFilter === "unread" && bm.read) || (activeFilter === "read" && !bm.read);
      renderCountLine();
      // Direction-aware (#99): towards Read on the way in, back towards
      // Unread on the way out.
      if (dropsOut) dropCardFromView(bm, card, window.XBOReadToggle.readExitDirection(bm.read));
    } catch (_err) {
      if (pillBtn) {
        pillBtn.classList.remove("is-loading");
        pillBtn.disabled = false;
      }
    }
  }

  /**
   * Star or unstar a bookmark (issue #63) and reflect it immediately: the
   * star fills in, the count line follows, every cached view is kept
   * consistent, and a card that no longer belongs in the Favorites tab
   * drops out of it. Persisted server-side, exactly like read state - the
   * sidebar's badges are read-state only, so they are untouched here.
   */
  async function setFavorite(bm, card, favorite) {
    if (Boolean(bm.favorite) === favorite) return;
    const starBtn = card.querySelector(".fav-btn");
    if (starBtn) {
      starBtn.classList.add("is-loading");
      starBtn.disabled = true;
    }
    try {
      const data = await postJSON(`/api/bookmarks/${bm.id}/favorite`, { favorite });
      bm.favorite = data.bookmark.favorite;
      categoryCounts.favorite = Math.max(0, (categoryCounts.favorite || 0) + (bm.favorite ? 1 : -1));
      syncCachedViewsOnChange(bm);

      if (starBtn) {
        // The pooled card outlives a drop-out, so settle its star either way.
        starBtn.classList.remove("is-loading");
        starBtn.disabled = false;
        applyFavoriteButtonState(starBtn, bm.favorite);
      }
      renderCountLine();
      if (activeFilter === "favorite" && !bm.favorite) {
        // Unstarred while the Favorites tab is open: it leaves this view the
        // same way a read post leaves Unread, animation and bookkeeping alike.
        dropCardFromView(bm, card);
      }
    } catch (_err) {
      if (starBtn) {
        starBtn.classList.remove("is-loading");
        starBtn.disabled = false;
      }
    }
  }

  // POST helper (kept separate so GET caching semantics stay obvious above).
  async function postJSON(url, body) {
    const res = await fetch(url, {
      method: "POST",
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`Request failed (${res.status})`);
    return res.json();
  }

  // ---- delete forever (bin icon) ------------------------------------------
  // Safe-delete UX: the card is removed from view immediately and a toast
  // offers Undo; the DELETE call (which permanently drops the local row and
  // tombstones its post id so it can never come back on a later sync) only
  // fires once the undo window elapses without a click.
  const UNDO_WINDOW_MS = 6000;
  const toastContainerEl = document.getElementById("toast-container");

  /** How long a toast that only reports something stays on screen. */
  const TOAST_MS = 4000;

  /**
   * A bottom toast, optionally offering actions (issue #99 gave the move its
   * second one, so this takes a LIST rather than a single label/handler).
   *
   * `opts.duration` is how long it stays; `0` means it is owned by the caller
   * (the safe-delete toast, which its own undo-window timer removes). Every
   * action closes the toast before running, so a slow handler cannot leave a
   * dismissed toast on screen.
   */
  function showToast(message, opts) {
    const options = opts || {};
    const actions = options.actions || [];
    const toast = el("div", "toast");
    toast.setAttribute("role", "status");
    toast.appendChild(el("span", "toast-msg", message));
    if (actions.length > 0) {
      const row = el("span", "toast-actions");
      for (const action of actions) {
        const actionBtn = el("button", "btn btn-ghost toast-action", action.label);
        actionBtn.type = "button";
        actionBtn.addEventListener("click", () => {
          toast.remove();
          action.onClick();
        });
        row.appendChild(actionBtn);
      }
      toast.appendChild(row);
    }
    toastContainerEl.appendChild(toast);
    const duration = options.duration === undefined ? TOAST_MS : options.duration;
    if (duration > 0) setTimeout(() => toast.remove(), duration);
    return toast;
  }

  function deleteBookmark(bm, card) {
    const wasUnread = !bm.read;
    const wasFavorite = Boolean(bm.favorite);
    const bmIndex = currentViewBookmarks.indexOf(bm);

    card.hidden = true; // released from the pool only once the delete is final
    if (bmIndex !== -1) currentViewBookmarks.splice(bmIndex, 1);
    categoryCounts.total = Math.max(0, categoryCounts.total - 1);
    if (wasUnread && categoryCounts.unread > 0) categoryCounts.unread -= 1;
    if (wasFavorite && categoryCounts.favorite > 0) categoryCounts.favorite -= 1;
    pageOffset = Math.max(0, pageOffset - 1);
    renderCountLine();
    if (currentViewBookmarks.length === 0) {
      if (pageHasMore) {
        loadMore();
      } else {
        removeTail();
        stateMessage(listEl, "empty", emptyFilterMessage());
      }
    } else {
      updateTail(); // keep the "N shown" end-of-list marker in step
    }

    function restore() {
      // Deleting the last visible card swaps the list to the empty-state
      // message; clear it before putting the card back.
      const emptyMsg = listEl.querySelector(":scope > .state-empty");
      if (emptyMsg) emptyMsg.remove();
      if (bmIndex !== -1 && bmIndex <= currentViewBookmarks.length) {
        currentViewBookmarks.splice(bmIndex, 0, bm);
      } else {
        currentViewBookmarks.push(bm);
      }
      paintViewCards(); // re-shows the card at its old position
      categoryCounts.total += 1;
      if (wasUnread) categoryCounts.unread += 1;
      if (wasFavorite) categoryCounts.favorite = (categoryCounts.favorite || 0) + 1;
      pageOffset += 1;
      renderCountLine();
      updateTail();
    }

    let undone = false;
    const toast = showToast(`Deleted @${bm.authorUsername}’s post.`, {
      // Owned by the undo-window timer below, not by a dwell time: the toast
      // must be on screen for exactly as long as the delete can still be
      // taken back.
      duration: 0,
      actions: [
        {
          label: "Undo",
          onClick: () => {
            undone = true;
            clearTimeout(timer);
            restore();
          },
        },
      ],
    });

    const timer = setTimeout(async () => {
      if (undone) return;
      toast.remove();
      try {
        const res = await fetch(`/api/bookmarks/${bm.id}`, { method: "DELETE" });
        if (res.ok) {
          // Patch only the sidebar counters for this bookmark's categories
          // (and their ancestors) in place - not a full tree reload.
          updateSidebarCounts(bm, -1, wasUnread ? -1 : 0);
          purgeFromCache(bm);
        } else if (res.status !== 404) {
          throw new Error(`Request failed (${res.status})`);
        }
      } catch (_err) {
        // Deletion failed server-side: restore the card so nothing silently
        // vanishes, and let the owner know so they can retry.
        restore();
        showToast("Couldn't delete that post. Please try again.");
      }
    }, UNDO_WINDOW_MS);
  }

  // ---- move a post to another category (issue #92) ------------------------
  // ONE re-file, two ways in: dragging the card's handle onto a sidebar
  // category, and the picker modal (the keyboard-accessible equivalent, and
  // the only path on a touch device with the drawer closed). "Move" is
  // re-file, not add - the post ends up in exactly the chosen category.

  /** The picker's pure half: the tree filter, the visible-item walk, the key contract. */
  function picker() {
    return window.XBOCategoryPicker;
  }

  function announceMove(message) {
    if (moveAnnouncerEl) moveAnnouncerEl.textContent = message;
  }

  /**
   * Keep every cached view consistent with a post that has just been re-filed
   * from `fromIds` to `toId`.
   *
   * A cached view can be an ANCESTOR showing a rolled-up list, so membership
   * is decided per subtree, not per direct category. A subtree the post left
   * has it spliced out of its cached id lists (its position in the others is
   * unchanged); a subtree it JOINED has its id lists dropped, because where
   * the server's sort would place it is not knowable here. A subtree that
   * both contained it before and contains it now is untouched.
   *
   * The pooled CARD is never released - the post still exists, and detaching
   * it would reload its X embeds (issues #67, #89).
   */
  function syncCachedViewsOnMove(bm, fromIds, toIds) {
    if (!window.XBOTreeCounts) return;
    const before = window.XBOTreeCounts.affectedCategoryIds(categoryIndex, fromIds);
    const after = window.XBOTreeCounts.affectedCategoryIds(categoryIndex, toIds);
    for (const [categoryId, catCache] of viewCaches) {
      const had = before.has(categoryId);
      const has = after.has(categoryId);
      if (had && !has) {
        for (const entry of catCache.filters.values()) {
          const idx = entry.ids.indexOf(bm.id);
          if (idx === -1) continue;
          entry.ids.splice(idx, 1);
          entry.bmById.delete(bm.id);
          entry.offset = Math.max(0, entry.offset - 1);
        }
      } else if (!had && has) {
        catCache.filters.clear();
      } else {
        // Still filed in this subtree: only a bookmark copy no longer shared
        // with the pool needs its category list refreshed.
        for (const entry of catCache.filters.values()) {
          const cached = entry.bmById.get(bm.id);
          if (cached && cached !== bm) cached.categoryIds = toIds.slice();
        }
      }
    }
  }

  /**
   * Re-file `bm` under exactly `targetIds`, then settle everything the change
   * touches WITHOUT reloading anything: the sidebar counters (source chains
   * down, destination chains up, a shared ancestor netting zero), the cached
   * views, the live view's own counts, and the card itself - out of the view
   * on the reflow above when the post has left the category being browsed,
   * back INTO it when an undo brings it home again.
   *
   * A move always passes one id. The list is what makes the operation
   * reversible (issue #99): a post the assignment pass multi-labelled had
   * several memberships before the move collapsed them, and Undo restores
   * exactly those - the same re-file run backwards, not a second code path.
   *
   * Throws on failure so each entry point can report it in its own idiom
   * (an inline message in the modal, a toast after a drag).
   */
  async function refileBookmark(bm, card, targetIds, opts) {
    const options = opts || {};
    const fromIds = (bm.categoryIds || []).slice();
    // Where the card sits in the view it may be about to leave, captured
    // before anything moves so an Undo can put it back where it was rather
    // than at the end of the list.
    const viewIndex = currentViewBookmarks.indexOf(bm);
    const res = await fetch(`/api/bookmarks/${bm.id}/category`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ categoryIds: targetIds }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || "Could not move that post.");

    const wasUnread = !bm.read;
    const wasFavorite = Boolean(bm.favorite);

    let leftView = false;
    let joinedView = false;
    if (window.XBOTreeCounts && selectedCategoryId != null) {
      const before = window.XBOTreeCounts.affectedCategoryIds(categoryIndex, fromIds);
      const after = window.XBOTreeCounts.affectedCategoryIds(categoryIndex, targetIds);
      leftView = before.has(selectedCategoryId) && !after.has(selectedCategoryId);
      joinedView = !before.has(selectedCategoryId) && after.has(selectedCategoryId);
    }

    if (window.XBOTreeCounts) {
      const updated = window.XBOTreeCounts.applyMoveDelta(
        categoryIndex,
        fromIds,
        targetIds,
        wasUnread ? 1 : 0,
      );
      for (const node of updated) patchCategoryCountDom(node);
      syncCacheCounts(updated);
    }
    syncCachedViewsOnMove(bm, fromIds, targetIds);
    bm.categoryIds = targetIds.slice();

    // The live view's own counts move with it, the same way the read toggle
    // settles them before the card starts leaving.
    if (leftView || joinedView) {
      const sign = leftView ? -1 : 1;
      categoryCounts.total = Math.max(0, categoryCounts.total + sign);
      if (wasUnread) categoryCounts.unread = Math.max(0, categoryCounts.unread + sign);
      if (wasFavorite) {
        categoryCounts.favorite = Math.max(0, (categoryCounts.favorite || 0) + sign);
      }
      renderCountLine();
    }
    if (leftView) reflowCardOut(bm, card);
    else if (joinedView) restoreCardToView(bm, card, options.restoreIndex);

    return { fromIds, viewIndex, leftView, joinedView };
  }

  /**
   * Put a card back into the open view - the settling half of an Undo, and
   * the mirror of `commitCardOut`.
   *
   * The card was hidden, never detached (issues #67, #89), so it is still
   * pooled with its mounted X embeds: reinstating it is a matter of the view's
   * id list and a repaint, and its post never reloads. It is only reinstated
   * when it genuinely belongs on screen - the open TAB still has to accept it,
   * which category membership alone does not decide.
   */
  function restoreCardToView(bm, card, index) {
    if (!card || !window.XBOFilterCache.survivesFilter(activeFilter, bm)) return;
    if (currentViewBookmarks.indexOf(bm) === -1) {
      // The view may have emptied out behind this post; the empty-state
      // message has to go before a card can be shown again.
      const emptyMsg = listEl.querySelector(":scope > .state-empty");
      if (emptyMsg) emptyMsg.remove();
      const at =
        Number.isInteger(index) && index >= 0 && index <= currentViewBookmarks.length
          ? index
          : currentViewBookmarks.length;
      currentViewBookmarks.splice(at, 0, bm);
      pageOffset += 1;
    }
    paintViewCards();
    updateTail();
  }

  /** How a category reads in a sentence ("Reading › Essays"), or a fallback. */
  function whereLabel(categoryIds) {
    const node = categoryIds.length === 1 ? categoryIndex.get(categoryIds[0]) : null;
    if (node) return picker().pathLabel(node);
    return categoryIds.length > 1 ? "its previous categories" : "another category";
  }

  /**
   * The manual move, with the toast that makes it reversible (issue #99).
   *
   * The toast carries BOTH follow-ups a move leaves open - "that was wrong"
   * (Undo) and "where did it go?" (View) - and stays long enough to read and
   * choose between them. Undo re-files the post to the membership snapshot
   * taken before the write; a post that was filed nowhere has no prior state
   * to restore, so it is simply not offered.
   */
  async function moveBookmarkToCategory(bm, card, targetId) {
    const snapshot = window.XBOMoveUndo.snapshotMove(bm, [targetId]);
    const result = await refileBookmark(bm, card, [targetId]);

    const where = whereLabel([targetId]);
    announceMove(`Moved @${bm.authorUsername}’s post to ${where}.`);

    const actions = [];
    if (window.XBOMoveUndo.canUndo(snapshot)) {
      actions.push({
        label: "Undo",
        onClick: () => {
          undoMove(bm, card, snapshot, result.viewIndex);
        },
      });
    }
    actions.push({ label: "View", onClick: () => void revealBookmark(bm, targetId) });
    showToast(`Moved to ${where}.`, {
      duration: window.XBOMoveUndo.MOVE_UNDO_MS,
      actions,
    });
  }

  /** Re-file the post back to the membership the move overwrote. */
  async function undoMove(bm, card, snapshot, restoreIndex) {
    const back = window.XBOMoveUndo.undoTargets(snapshot);
    try {
      await refileBookmark(bm, card, back, { restoreIndex });
    } catch (err) {
      showToast(err.message || "Could not undo that move.");
      return;
    }
    const where = whereLabel(back);
    announceMove(`Moved @${bm.authorUsername}’s post back to ${where}.`);
    showToast(`Moved back to ${where}.`);
  }

  /**
   * Jump to a post in the category it was just moved to: select that
   * category, page far enough to reach the post, then scroll it into view
   * and focus it.
   *
   * Two things it has to get out of the way first. The open TAB may exclude
   * the post (a read post while Unread is showing), so the tab falls back to
   * All; and the post may be several pages down under the current ordering,
   * so the loader is driven directly rather than waiting for a scroll to
   * reach the sentinel. The walk is bounded - a post that is a hundred pages
   * deep is not worth fetching the library for, and the category is open
   * either way.
   */
  const REVEAL_MAX_PAGES = 10;

  async function revealBookmark(bm, categoryId) {
    if (!window.XBOFilterCache.survivesFilter(activeFilter, bm)) {
      if (selectedCategoryId != null) saveCurrentViewToCache();
      activeFilter = "all";
      renderFilterTabs();
      persistSelection();
    }
    await selectCategoryById(categoryId);

    for (let i = 0; i < REVEAL_MAX_PAGES; i += 1) {
      if (currentViewBookmarks.some((other) => other.id === bm.id)) break;
      if (!pageHasMore) break;
      await loadMore();
    }

    const pooled = cardPool.get(bm.id);
    if (!pooled || pooled.card.hidden) {
      announceMove(`@${bm.authorUsername}’s post is further down this category.`);
      return;
    }
    locateCard(pooled.card);
  }

  /**
   * Bring a card to the owner's attention: focus it (so a screen reader lands
   * on the post rather than on wherever the toast's button was) and ring it
   * briefly. The scroll is the platform's own, so `prefers-reduced-motion`
   * turns the travel off without turning the jump off.
   */
  function locateCard(card) {
    card.tabIndex = -1;
    card.focus({ preventScroll: true });
    card.scrollIntoView({
      block: "center",
      behavior: window.XBOScrollTop.scrollBehavior(reducedMotion.matches),
    });
    card.classList.remove("is-located");
    // Restart the ring even if the same card is located twice in a row.
    void card.offsetWidth;
    card.classList.add("is-located");
    card.addEventListener(
      "animationend",
      () => card.classList.remove("is-located"),
      { once: true },
    );
  }

  // ---- drag the handle onto a sidebar category ----------------------------
  // Pointer events (not HTML5 drag-and-drop), the same idiom the roots'
  // reorder grip uses: it works with a finger, it survives the cross-origin
  // X embeds a card is full of, and it leaves the hover-expand timing here
  // rather than in the browser's drag machinery.

  /** How long a category must be hovered before it opens to show its children. */
  const DRAG_EXPAND_MS = 420;
  /** Distance from a scrollable edge that starts auto-scrolling, and the step. */
  const DRAG_SCROLL_EDGE = 56;
  const DRAG_SCROLL_STEP = 10;
  /**
   * Which of the handle's two gestures happened - press or drag - is decided
   * in the pure `card-drag.js`, because it is what gates BOTH destinations:
   * a drag needs the sidebar tree as a drop target, a press opens the picker
   * (which brings its own tree) and must leave the drawer alone.
   */
  const cardGesture = () => window.XBOCardDrag;

  let cardDrag = null;

  function setGhostLabel(bm, targetNode) {
    if (!moveGhostEl) return;
    moveGhostEl.replaceChildren();
    if (targetNode) {
      moveGhostEl.classList.add("is-over");
      moveGhostEl.appendChild(el("span", "move-ghost-verb", "Move to"));
      moveGhostEl.appendChild(el("span", "move-ghost-target", targetNode.name));
    } else {
      moveGhostEl.classList.remove("is-over");
      moveGhostEl.appendChild(el("span", "move-ghost-verb", "Drop on a category"));
      moveGhostEl.appendChild(el("span", "move-ghost-target", `@${bm.authorUsername}`));
    }
  }

  function positionGhost(x, y) {
    if (!moveGhostEl) return;
    // transform-only so following the pointer never triggers layout.
    moveGhostEl.style.transform = `translate3d(${x + 14}px, ${y + 14}px, 0)`;
  }

  function clearDropTarget(drag) {
    if (drag.expandTimer) {
      clearTimeout(drag.expandTimer);
      drag.expandTimer = null;
    }
    if (drag.targetBtn) drag.targetBtn.classList.remove("is-drop-target");
    drag.targetBtn = null;
    drag.targetId = null;
  }

  /**
   * Point the drag at whatever category is under the pointer, and start the
   * hover-expand timer for a collapsed one. Expanding is delegated to the
   * tree's own toggle, so drilling in is recursive for free: the revealed
   * children are ordinary rows, and hovering one arms the same timer again.
   */
  function hoverTreeTarget(drag, x, y) {
    const under = document.elementFromPoint(x, y);
    const btn = under && under.closest ? under.closest(".tree-node") : null;
    if (btn === drag.targetBtn) return;
    clearDropTarget(drag);
    if (!btn) {
      setGhostLabel(drag.bm, null);
      return;
    }
    drag.targetBtn = btn;
    drag.targetId = Number(btn.dataset.categoryId);
    btn.classList.add("is-drop-target");
    setGhostLabel(drag.bm, categoryIndex.get(drag.targetId));
    const row = btn.closest(".tree-row");
    const toggle = row && row.querySelector(".tree-toggle");
    if (!toggle || toggle.classList.contains("is-leaf")) return;
    if (toggle.getAttribute("aria-expanded") === "true") return;
    drag.expandTimer = setTimeout(() => {
      drag.expandTimer = null;
      toggle.click();
    }, DRAG_EXPAND_MS);
  }

  /** Scroll the sidebar while the pointer rests near its top or bottom edge. */
  function autoScrollSidebar(drag) {
    const pane = treeEl.closest(".sidebar-inner");
    if (!pane || pane.scrollHeight <= pane.clientHeight) return;
    const rect = pane.getBoundingClientRect();
    const { x, y } = drag.pointer;
    if (x < rect.left || x > rect.right) return;
    if (y > rect.top && y - rect.top < DRAG_SCROLL_EDGE) pane.scrollTop -= DRAG_SCROLL_STEP;
    else if (y < rect.bottom && rect.bottom - y < DRAG_SCROLL_EDGE) pane.scrollTop += DRAG_SCROLL_STEP;
  }

  function startCardDrag(e, handle, bm, card) {
    if (cardDrag) return;
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    try {
      handle.setPointerCapture(e.pointerId);
    } catch (_) {
      /* no active pointer to capture (synthetic event); moves still reach the handle */
    }
    const drag = {
      bm,
      card,
      handle,
      origin: { x: e.clientX, y: e.clientY },
      pointer: { x: e.clientX, y: e.clientY },
      started: false,
      targetId: null,
      targetBtn: null,
      expandTimer: null,
      raf: null,
    };
    cardDrag = drag;

    const begin = () => {
      drag.started = true;
      // The tree is the only drop target there is, so a closed drawer would
      // make the gesture impossible: open it the moment the press becomes a
      // DRAG. Opening it at pointerdown instead - before the gesture had
      // declared itself - is what made a tap on the handle open the sidebar
      // behind the picker modal on a phone (issue #100). `moveFocus: false`
      // because focus belongs to the pointer for the rest of the gesture.
      if (isCollapsed()) setCollapsed(false, { moveFocus: false });
      card.classList.add("is-moving");
      document.body.classList.add("is-card-dragging");
      if (moveGhostEl) moveGhostEl.hidden = false;
      setGhostLabel(bm, null);
      positionGhost(drag.pointer.x, drag.pointer.y);
      const tick = () => {
        if (cardDrag !== drag) return;
        autoScrollSidebar(drag);
        drag.raf = window.requestAnimationFrame(tick);
      };
      drag.raf = window.requestAnimationFrame(tick);
    };

    const onMove = (ev) => {
      drag.pointer = { x: ev.clientX, y: ev.clientY };
      if (!drag.started) {
        if (!cardGesture().passedSlop(drag.origin, drag.pointer)) return;
        begin();
      }
      positionGhost(ev.clientX, ev.clientY);
      hoverTreeTarget(drag, ev.clientX, ev.clientY);
    };

    const finish = (ev, cancelled) => {
      if (cardDrag !== drag) return;
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onCancel);
      document.removeEventListener("keydown", onKey, true);
      try {
        if (ev) handle.releasePointerCapture(ev.pointerId);
      } catch (_) {
        /* capture already gone */
      }
      if (drag.raf != null) window.cancelAnimationFrame(drag.raf);
      const targetId = drag.targetId;
      clearDropTarget(drag);
      card.classList.remove("is-moving");
      document.body.classList.remove("is-card-dragging");
      if (moveGhostEl) moveGhostEl.hidden = true;
      const outcome = cardGesture().gestureOutcome({
        started: drag.started,
        cancelled,
        targetId,
      });
      cardDrag = null;
      // A press that never became a drag is a press: open the picker, so the
      // handle is never a control that does nothing when you click it.
      if (outcome === "picker") {
        openMovePicker(bm, card, handle);
        return;
      }
      if (outcome !== "move") return;
      moveBookmarkToCategory(bm, card, targetId).catch((err) => {
        showToast(err.message || "Could not move that post.");
      });
    };

    const onUp = (ev) => finish(ev, false);
    const onCancel = (ev) => finish(ev, true);
    const onKey = (ev) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      finish(null, true);
    };

    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onCancel);
    document.addEventListener("keydown", onKey, true);
  }

  // ---- the picker modal (the keyboard path) -------------------------------
  // The sidebar's tree and search filter, minus the roots' reorder grips (a
  // sidebar-only affordance, #82), plus single-select and a confirm. It is a
  // real ARIA `tree`, so it owns that contract in full: arrow keys walk the
  // visible rows, Right opens a node then steps into it, Left closes it then
  // climbs out, Home/End jump, Enter/Space select.

  let movePicker = null;

  function isMovePickerOpen() {
    return !!moveModalEl && !moveModalEl.hidden;
  }

  function openMovePicker(bm, card, triggerEl) {
    if (!moveModalEl) return;
    movePicker = {
      bm,
      card,
      trigger: triggerEl,
      selectedId: null,
      focusedId: null,
      expanded: new Set(),
    };
    // Open the path the post is filed under now, so the picker starts where
    // the owner is rather than at a wall of collapsed roots.
    const current = (bm.categoryIds || [])[0];
    if (current != null && window.XBOCategoryPicker) {
      for (const id of picker().ancestorIds(categoryIndex, current)) movePicker.expanded.add(id);
      if (categoryIndex.has(current)) movePicker.focusedId = current;
    }
    moveSearchInput.value = "";
    moveSearchClear.hidden = true;
    moveErrorEl.hidden = true;
    moveErrorEl.textContent = "";
    renderMoveTree();
    updateMoveSelection();
    moveBackdropEl.hidden = false;
    moveModalEl.hidden = false;
    moveSearchInput.focus();
    document.addEventListener("keydown", onMoveModalKeydown);
  }

  function closeMovePicker(fallbackEl) {
    if (!isMovePickerOpen()) return;
    moveModalEl.hidden = true;
    moveBackdropEl.hidden = true;
    document.removeEventListener("keydown", onMoveModalKeydown);
    const trigger = movePicker && movePicker.trigger;
    movePicker = null;
    returnFocusFromPicker(trigger, fallbackEl);
  }

  /**
   * Hand the keyboard back on the way out. Normally that is the control the
   * picker was opened from - but a post that has just LEFT the open category
   * has a HIDDEN card (it stays pooled, mounted and hidden, never detached),
   * and focusing a control inside a hidden subtree is a silent no-op that
   * would strand focus on <body>. So the destination in the sidebar takes it
   * instead, which is also where the post just went.
   */
  function returnFocusFromPicker(trigger, fallbackEl) {
    if (trigger && trigger.isConnected) {
      trigger.focus();
      if (document.activeElement === trigger) return;
    }
    if (fallbackEl && fallbackEl.isConnected) fallbackEl.focus();
  }

  function moveSearchQuery() {
    return moveSearchInput ? moveSearchInput.value.trim() : "";
  }

  /** The roots the picker is showing: the whole tree, or the search's pruned copy. */
  function moveVisibleRoots() {
    const query = moveSearchQuery().toLowerCase();
    return query ? picker().filterTree(treeRoots, query) : treeRoots;
  }

  /** While searching every surviving branch is forced open, exactly as the sidebar does. */
  function moveIsExpanded(node) {
    if (moveSearchQuery().length > 0) return true;
    return movePicker.expanded.has(node.id);
  }

  function moveItems() {
    return picker().visibleItems(moveVisibleRoots(), moveIsExpanded);
  }

  function renderMoveTree() {
    if (!movePicker) return;
    const raw = moveSearchQuery();
    if (treeRoots.length === 0) {
      stateMessage(moveTreeEl, "empty", "No categories yet. Sync your bookmarks first.");
      return;
    }
    const roots = moveVisibleRoots();
    if (roots.length === 0) {
      stateMessage(moveTreeEl, "empty", `No categories match “${raw}”.`);
      return;
    }
    const items = moveItems();
    if (!items.some((i) => i.id === movePicker.focusedId)) {
      movePicker.focusedId = items.length ? items[0].id : null;
    }
    const list = el("ul", "move-tree-list");
    list.setAttribute("role", "tree");
    list.setAttribute("aria-label", "Categories");
    buildMoveNodes(roots, list, 1, raw.toLowerCase());
    moveTreeEl.replaceChildren(list);
  }

  function buildMoveNodes(nodes, parentList, level, query) {
    for (const node of nodes) {
      const hasChildren = !!(node.children && node.children.length);
      const expanded = hasChildren && moveIsExpanded(node);
      const selected = movePicker.selectedId === node.id;

      const li = el("li", "move-item");
      li.setAttribute("role", "treeitem");
      li.setAttribute("aria-level", String(level));
      // Named explicitly: the nested group lives INSIDE this treeitem, so
      // without this its accessible name would swallow its whole subtree.
      li.setAttribute("aria-label", node.name);
      li.setAttribute("aria-selected", String(selected));
      if (hasChildren) li.setAttribute("aria-expanded", String(expanded));
      li.dataset.categoryId = String(node.id);
      li.tabIndex = node.id === movePicker.focusedId ? 0 : -1;

      const row = el("div", "move-row");
      if (selected) row.classList.add("is-selected");
      const chev = el("span", hasChildren ? "move-chev" : "move-chev is-leaf");
      chev.setAttribute("aria-hidden", "true");
      if (hasChildren) chev.textContent = "▶";
      row.appendChild(chev);
      const label = el("span", "move-label");
      appendHighlighted(label, node.name, query);
      row.appendChild(label);
      // The selection is carried by a mark as well as the tint, never by
      // color alone.
      const mark = el("span", "move-check");
      mark.setAttribute("aria-hidden", "true");
      if (selected) mark.appendChild(checkIcon());
      row.appendChild(mark);
      li.appendChild(row);

      if (hasChildren) {
        const group = el("ul", "move-group");
        group.setAttribute("role", "group");
        buildMoveNodes(node.children, group, level + 1, query);
        group.hidden = !expanded;
        li.appendChild(group);
      }
      parentList.appendChild(li);
    }
  }

  function focusMoveItem(id) {
    if (!movePicker) return;
    movePicker.focusedId = id;
    moveTreeEl.querySelectorAll('[role="treeitem"]').forEach((node) => {
      node.tabIndex = Number(node.dataset.categoryId) === id ? 0 : -1;
    });
    const target = moveTreeEl.querySelector(`[role="treeitem"][data-category-id="${id}"]`);
    if (target) target.focus();
  }

  function setMoveExpanded(id, open) {
    if (!movePicker) return;
    if (open) movePicker.expanded.add(id);
    else movePicker.expanded.delete(id);
    renderMoveTree();
    focusMoveItem(id);
  }

  function selectMoveCategory(id) {
    if (!movePicker) return;
    movePicker.selectedId = id;
    movePicker.focusedId = id;
    moveErrorEl.hidden = true;
    renderMoveTree();
    updateMoveSelection();
    focusMoveItem(id);
  }

  /** The chosen destination in prose, plus whether confirming would do anything. */
  function updateMoveSelection() {
    if (!movePicker) return;
    const node = movePicker.selectedId != null ? categoryIndex.get(movePicker.selectedId) : null;
    const noop = picker().isNoOp(movePicker.selectedId, movePicker.bm.categoryIds);
    moveConfirmBtn.disabled = noop;
    if (!node) {
      moveSelectionEl.textContent = "No category chosen yet.";
    } else if (noop) {
      moveSelectionEl.textContent = `This post is already filed under ${picker().pathLabel(node)}.`;
    } else {
      moveSelectionEl.textContent = `Move to ${picker().pathLabel(node)}.`;
    }
  }

  async function confirmMove() {
    if (!movePicker || movePicker.selectedId == null) return;
    const { bm, card, selectedId } = movePicker;
    moveConfirmBtn.disabled = true;
    moveConfirmBtn.classList.add("is-loading");
    moveErrorEl.hidden = true;
    try {
      await moveBookmarkToCategory(bm, card, selectedId);
    } catch (err) {
      moveErrorEl.textContent = err.message || "Could not move that post.";
      moveErrorEl.hidden = false;
      moveConfirmBtn.disabled = false;
      moveConfirmBtn.classList.remove("is-loading");
      return;
    }
    moveConfirmBtn.classList.remove("is-loading");
    closeMovePicker(treeEl.querySelector(`[data-category-id="${selectedId}"]`));
  }

  function onMoveTreeKeydown(e) {
    if (!movePicker) return;
    const li = e.target.closest ? e.target.closest('[role="treeitem"]') : null;
    if (!li) return;
    const id = Number(li.dataset.categoryId);
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      selectMoveCategory(id);
      return;
    }
    const items = moveItems();
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      // A search force-expands every surviving branch, so there is nothing
      // to open or close while one is running - only the walk applies.
      if (moveSearchQuery().length > 0) return;
      const action = picker().lateralTarget(items, id, e.key, (node) => node.parentId);
      if (!action) return;
      e.preventDefault();
      if (action.action === "focus") focusMoveItem(action.id);
      else setMoveExpanded(action.id, action.action === "expand");
      return;
    }
    const target = picker().focusTarget(items, id, e.key);
    if (!target) return;
    e.preventDefault();
    focusMoveItem(target.id);
  }

  function onMoveTreeClick(e) {
    if (!movePicker) return;
    const li = e.target.closest ? e.target.closest('[role="treeitem"]') : null;
    if (!li) return;
    const id = Number(li.dataset.categoryId);
    if (e.target.closest(".move-chev")) {
      const expanded = li.getAttribute("aria-expanded");
      if (expanded === null) return; // a leaf: its chevron column is a spacer
      if (moveSearchQuery().length > 0) return;
      setMoveExpanded(id, expanded !== "true");
      return;
    }
    selectMoveCategory(id);
  }

  function onMoveModalKeydown(e) {
    if (!isMovePickerOpen()) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      // Escape in the search field clears the query first, exactly as the
      // sidebar's own filter does; a second press leaves the dialog.
      if (document.activeElement === moveSearchInput && moveSearchInput.value.length > 0) {
        moveSearchInput.value = "";
        moveSearchClear.hidden = true;
        renderMoveTree();
        return;
      }
      closeMovePicker();
      return;
    }
    trapModalFocus(moveModalEl, e);
  }

  function initMovePicker() {
    if (!moveModalEl) return;
    moveCloseBtn.addEventListener("click", closeMovePicker);
    moveCancelBtn.addEventListener("click", closeMovePicker);
    moveBackdropEl.addEventListener("click", closeMovePicker);
    moveConfirmBtn.addEventListener("click", () => void confirmMove());
    moveTreeEl.addEventListener("click", onMoveTreeClick);
    moveTreeEl.addEventListener("keydown", onMoveTreeKeydown);
    moveSearchInput.addEventListener("input", () => {
      moveSearchClear.hidden = moveSearchInput.value.trim().length === 0;
      renderMoveTree();
    });
    moveSearchClear.addEventListener("click", () => {
      moveSearchInput.value = "";
      moveSearchClear.hidden = true;
      renderMoveTree();
      moveSearchInput.focus();
    });
    // ArrowDown from the search field steps into the tree, so the whole
    // picker is reachable without hunting for a tab stop.
    moveSearchInput.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowDown") return;
      const items = moveItems();
      if (items.length === 0) return;
      e.preventDefault();
      focusMoveItem(movePicker && movePicker.focusedId != null ? movePicker.focusedId : items[0].id);
    });
  }

  /** Tab/Shift+Tab wraps within `modalEl` while it is open (a real modal). Shared by every modal. */
  function trapModalFocus(modalEl, e) {
    if (e.key !== "Tab") return;
    // Fields count, and an element that is `hidden` (or otherwise unrendered)
    // does NOT: focusing one is a no-op, which would strand the wrap on a
    // control the owner can neither see nor leave.
    const focusable = Array.from(
      modalEl.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]),' +
          ' textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((node) => !node.hidden && node.offsetParent !== null);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  // ---- category editor (issue #101) ---------------------------------------
  // Add a category anywhere in the tree, or delete one. A delete cascades to
  // the sub-categories AND permanently deletes every post the cascade would
  // leave filed nowhere else (the owner's rule), so the destructive half of
  // this section is deliberately slow and loud: the counts are read fresh
  // from the server immediately before they are shown, the dialog names them,
  // and "don't ask again" can never silence a ROOT delete.
  //
  // The tree here is a nested <ul> DISCLOSURE list, not an ARIA `tree`: each
  // row carries real buttons (a bin, a twisty, an add), which is the opposite
  // of a tree's single-focus keyboard contract. Native semantics mean Tab,
  // Enter and Space all work with nothing custom to promise.

  const catEditorOpenBtn = document.getElementById("cat-editor-open");
  const catEditorModalEl = document.getElementById("cat-editor-modal");
  const catEditorBackdropEl = document.getElementById("cat-editor-backdrop");
  const catEditorTreeEl = document.getElementById("cat-editor-tree");
  const catEditorErrorEl = document.getElementById("cat-editor-error");
  const catEditorDoneBtn = document.getElementById("cat-editor-done");
  const catEditorCloseBtn = document.getElementById("cat-editor-close");
  const catEditorAnnouncerEl = document.getElementById("cat-editor-announcer");

  const catDeleteModalEl = document.getElementById("cat-delete-modal");
  const catDeleteBackdropEl = document.getElementById("cat-delete-backdrop");
  const catDeleteTextEl = document.getElementById("cat-delete-text");
  const catDeleteDetailEl = document.getElementById("cat-delete-detail");
  const catDeleteSkipInput = document.getElementById("cat-delete-skip-input");
  const catDeleteErrorEl = document.getElementById("cat-delete-error");
  const catDeleteCancelBtn = document.getElementById("cat-delete-cancel");
  const catDeleteConfirmBtn = document.getElementById("cat-delete-confirm");

  /** Open state: the trigger to hand focus back to, and which rows are open. */
  let catEditor = null;
  /** The pending destructive confirmation: its node, its counts, its trigger. */
  let catDelete = null;

  function editor() {
    return window.XBOCategoryEditor;
  }

  function isCatEditorOpen() {
    return !!catEditorModalEl && !catEditorModalEl.hidden;
  }

  function isCatDeleteOpen() {
    return !!catDeleteModalEl && !catDeleteModalEl.hidden;
  }

  function announceCatEditor(message) {
    if (catEditorAnnouncerEl) catEditorAnnouncerEl.textContent = message;
  }

  function showCatEditorError(message) {
    if (!catEditorErrorEl) return;
    catEditorErrorEl.textContent = message || "";
    catEditorErrorEl.hidden = !message;
  }

  function openCategoryEditor(triggerEl) {
    if (!catEditorModalEl || !editor()) return;
    // Start from the expansion state the sidebar is showing, so the editor
    // opens on the part of the tree the owner is already looking at.
    const expanded = new Set();
    for (const [id, open] of expansionState) if (open) expanded.add(id);
    catEditor = { trigger: triggerEl, expanded, adding: undefined, busy: false };
    showCatEditorError(null);
    renderCategoryEditor();
    catEditorBackdropEl.hidden = false;
    catEditorModalEl.hidden = false;
    catEditorCloseBtn.focus();
    document.addEventListener("keydown", onCatEditorKeydown);
  }

  function closeCategoryEditor() {
    if (!isCatEditorOpen()) return;
    if (isCatDeleteOpen()) closeCatDelete({ returnFocus: false });
    catEditorModalEl.hidden = true;
    catEditorBackdropEl.hidden = true;
    document.removeEventListener("keydown", onCatEditorKeydown);
    const trigger = catEditor && catEditor.trigger;
    catEditor = null;
    if (trigger && trigger.isConnected) trigger.focus();
  }

  /** Every id in `node`'s subtree, which is exactly what a delete removes. */
  function catSubtreeIds(node) {
    const out = [];
    const walk = (n) => {
      out.push(n.id);
      for (const child of n.children || []) walk(child);
    };
    if (node) walk(node);
    return out;
  }

  // --- rendering ------------------------------------------------------------

  function renderCategoryEditor() {
    if (!catEditor) return;
    const list = el("ul", "cat-editor-list");
    // The root-level add leads the list, so "a new top-level category" is the
    // first thing the editor offers - and the one affordance an empty library
    // still needs.
    list.appendChild(buildCatAddRow(null, 0));
    if (treeRoots.length === 0) {
      const empty = el("li", "ced-empty-row");
      empty.appendChild(
        el("p", "state state-empty", "No categories yet. Add one above, or run a sync to build them."),
      );
      list.appendChild(empty);
    } else {
      buildCatEditorNodes(treeRoots, list, 0);
    }
    catEditorTreeEl.replaceChildren(list);
  }

  function catIsExpanded(node) {
    return !!catEditor && catEditor.expanded.has(node.id);
  }

  function buildCatEditorNodes(nodes, parentList, depth) {
    for (const node of nodes) {
      const hasChildren = !!(node.children && node.children.length);
      const expanded = catIsExpanded(node);
      const groupId = `ced-group-${node.id}`;

      const li = el("li", "ced-item");
      const row = el("div", "ced-row");
      row.style.setProperty("--ced-depth", String(depth));

      const bin = el("button", "ced-bin");
      bin.type = "button";
      bin.dataset.categoryId = String(node.id);
      bin.setAttribute("aria-label", `Delete “${node.name}”`);
      bin.title = `Delete “${node.name}”`;
      bin.appendChild(trashIcon());
      bin.addEventListener("click", () => void requestCategoryDelete(node, bin));
      row.appendChild(bin);

      const indent = el("span", "ced-indent");
      indent.setAttribute("aria-hidden", "true");
      row.appendChild(indent);

      // EVERY node gets a twisty here, including a leaf - unlike the sidebar,
      // where one would open on nothing. Opening a leaf reveals the "+" that
      // files a child under it, and without that a category with no children
      // yet (every category the owner has just created) would be a dead end.
      const twisty = el("button", "ced-twisty");
      twisty.type = "button";
      twisty.setAttribute("aria-expanded", String(expanded));
      twisty.setAttribute("aria-controls", groupId);
      twisty.setAttribute(
        "aria-label",
        expanded
          ? `Collapse “${node.name}”`
          : hasChildren
            ? `Expand “${node.name}”`
            : `Open “${node.name}” to add a category in it`,
      );
      const chev = el("span", "ced-chev", "▶");
      chev.setAttribute("aria-hidden", "true");
      twisty.appendChild(chev);
      twisty.addEventListener("click", () => setCatEditorExpanded(node.id, !expanded));
      row.appendChild(twisty);

      row.appendChild(el("span", "ced-name", node.name));
      const count = el("span", "ced-count", String(node.total));
      count.setAttribute("aria-label", `${node.total} bookmarks`);
      row.appendChild(count);
      li.appendChild(row);

      // The group holds this node's children AND the one "+" that files a
      // new child under it - which is what "one add per level" means here.
      const group = el("ul", "ced-group");
      group.id = groupId;
      if (hasChildren) buildCatEditorNodes(node.children, group, depth + 1);
      group.appendChild(buildCatAddRow(node, depth + 1));
      group.hidden = !expanded;
      li.appendChild(group);
      parentList.appendChild(li);
    }
  }

  /**
   * The "+" for `parent` (null: a new root) - or, once it is pressed, the
   * inline name form it becomes. One per level, and the form replaces the
   * button in place so the owner's eye never leaves where the category lands.
   */
  function buildCatAddRow(parent, depth) {
    const parentId = parent ? parent.id : null;
    const li = el("li", "ced-add-row");
    li.style.setProperty("--ced-depth", String(depth));
    const indent = el("span", "ced-indent");
    indent.setAttribute("aria-hidden", "true");
    li.appendChild(indent);

    if (catEditor && catEditor.adding === parentId) {
      li.appendChild(buildCatAddForm(parent));
      return li;
    }

    const btn = el("button", "ced-add");
    btn.type = "button";
    const plus = el("span", "ced-plus", "+");
    plus.setAttribute("aria-hidden", "true");
    btn.appendChild(plus);
    btn.appendChild(
      el("span", null, parent ? `Add a category in “${parent.name}”` : "Add a top-level category"),
    );
    btn.addEventListener("click", () => startCatAdd(parentId));
    li.appendChild(btn);
    return li;
  }

  function buildCatAddForm(parent) {
    const parentId = parent ? parent.id : null;
    const form = el("form", "ced-form");
    const fieldId = `ced-name-${parentId == null ? "root" : parentId}`;
    const errorId = `${fieldId}-error`;

    const label = el("label", "visually-hidden", parent ? `Name of the new category in ${parent.name}` : "Name of the new top-level category");
    label.setAttribute("for", fieldId);
    form.appendChild(label);

    const field = el("div", "search-field");
    const input = el("input", "search-input");
    input.id = fieldId;
    input.type = "text";
    input.autocomplete = "off";
    input.spellcheck = false;
    field.appendChild(input);
    form.appendChild(field);

    const save = el("button", "btn btn-primary", "Add");
    save.type = "submit";
    const cancel = el("button", "btn btn-secondary", "Cancel");
    cancel.type = "button";
    cancel.addEventListener("click", () => {
      cancelCatAdd(parentId);
    });
    form.append(save, cancel);

    const error = el("p", "setup-error ced-form-error");
    error.id = errorId;
    error.hidden = true;
    form.appendChild(error);

    const fail = (message) => {
      error.textContent = message;
      error.hidden = false;
      input.setAttribute("aria-invalid", "true");
      input.setAttribute("aria-describedby", errorId);
      input.focus();
    };

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const siblings = editor().siblingsOf(treeRoots, parentId);
      const check = editor().validateName(input.value, siblings);
      if (!check.ok) {
        fail(check.error);
        return;
      }
      error.hidden = true;
      input.removeAttribute("aria-invalid");
      save.disabled = true;
      save.classList.add("is-loading");
      // The typed value is never cleared on a failure - it is the owner's
      // input, and the fix is usually one character.
      void createCategory(check.name, parentId).catch((err) => {
        save.disabled = false;
        save.classList.remove("is-loading");
        fail(err.message || "Could not add that category.");
      });
    });
    // Escape backs out of the form without closing the whole editor.
    form.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      cancelCatAdd(parentId);
    });
    queueMicrotask(() => input.focus());
    return form;
  }

  function setCatEditorExpanded(id, open) {
    if (!catEditor) return;
    if (open) catEditor.expanded.add(id);
    else catEditor.expanded.delete(id);
    renderCategoryEditor();
    focusCatEditorRow(id);
  }

  function startCatAdd(parentId) {
    if (!catEditor) return;
    showCatEditorError(null);
    catEditor.adding = parentId;
    // A category can only take a child where its children are visible.
    if (parentId != null) catEditor.expanded.add(parentId);
    renderCategoryEditor();
  }

  function cancelCatAdd(parentId) {
    if (!catEditor) return;
    catEditor.adding = undefined;
    renderCategoryEditor();
    const back = parentId == null
      ? catEditorTreeEl.querySelector(".ced-add")
      : catEditorTreeEl.querySelector(`.ced-bin[data-category-id="${parentId}"]`);
    if (back) back.focus();
  }

  /** Put focus back on a row's bin - the one control every row is guaranteed. */
  function focusCatEditorRow(id) {
    const bin = catEditorTreeEl.querySelector(`.ced-bin[data-category-id="${id}"]`);
    if (bin) bin.focus();
  }

  // --- add ------------------------------------------------------------------

  async function createCategory(name, parentId) {
    const res = await fetch("/api/categories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(parentId == null ? { name } : { name, parentId }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || "Could not add that category.");
    }
    const created = (await res.json()).category;
    catEditor.adding = undefined;
    // A new category is empty, so nothing that is cached can be stale: only
    // the tree itself has to catch up.
    await loadTree();
    if (parentId != null) catEditor.expanded.add(parentId);
    renderCategoryEditor();
    focusCatEditorRow(created.id);
    announceCatEditor(`Added “${created.name}”.`);
  }

  // --- delete ---------------------------------------------------------------

  /**
   * The bin. Always reads the counts first - even when "don't ask again" will
   * skip the dialog - because those counts are also what the confirmation
   * toast reports, and because a preview that fails must stop the delete
   * rather than let it run blind.
   */
  async function requestCategoryDelete(node, triggerEl) {
    if (!catEditor || catEditor.busy) return;
    showCatEditorError(null);
    let preview;
    try {
      preview = await getJSON(`/api/categories/${node.id}/deletion`);
    } catch (err) {
      showCatEditorError(
        (err.body && err.body.error) || "Could not work out what deleting that would remove.",
      );
      return;
    }
    const removes = preview.removes;
    if (!editor().needsConfirm(node, editor().readSkipConfirm(window.localStorage))) {
      await runCategoryDelete(node, removes, triggerEl);
      return;
    }
    openCatDelete(node, removes, triggerEl);
  }

  function openCatDelete(node, removes, triggerEl) {
    if (!catDeleteModalEl) return;
    catDelete = { node, removes, trigger: triggerEl };
    catDeleteTextEl.textContent = editor().confirmSentence(node.name, removes);
    catDeleteDetailEl.textContent = editor().confirmDetail(removes);
    catDeleteConfirmBtn.textContent = editor().confirmLabel(removes);
    catDeleteConfirmBtn.disabled = false;
    catDeleteConfirmBtn.classList.remove("is-loading");
    catDeleteErrorEl.hidden = true;
    catDeleteErrorEl.textContent = "";
    catDeleteSkipInput.checked = editor().readSkipConfirm(window.localStorage);
    // A root can never be silenced, so offering the switch there would be a
    // promise the dialog does not keep.
    const isRoot = node.parentId == null;
    catDeleteSkipInput.closest(".cat-delete-skip").hidden = isRoot;
    catDeleteBackdropEl.hidden = false;
    catDeleteModalEl.hidden = false;
    // Cancel first: the destructive button is never the default target.
    catDeleteCancelBtn.focus();
    document.addEventListener("keydown", onCatDeleteKeydown);
  }

  function closeCatDelete(opts) {
    if (!isCatDeleteOpen()) return;
    catDeleteModalEl.hidden = true;
    catDeleteBackdropEl.hidden = true;
    document.removeEventListener("keydown", onCatDeleteKeydown);
    const trigger = catDelete && catDelete.trigger;
    catDelete = null;
    if (opts && opts.returnFocus === false) return;
    if (trigger && trigger.isConnected) trigger.focus();
    else if (catEditorCloseBtn && isCatEditorOpen()) catEditorCloseBtn.focus();
  }

  async function confirmCatDelete() {
    if (!catDelete) return;
    const { node, removes, trigger } = catDelete;
    // The preference is the owner's, recorded whichever way the box is left.
    editor().writeSkipConfirm(window.localStorage, catDeleteSkipInput.checked === true);
    catDeleteConfirmBtn.disabled = true;
    catDeleteConfirmBtn.classList.add("is-loading");
    catDeleteErrorEl.hidden = true;
    try {
      await runCategoryDelete(node, removes, trigger, { keepDialog: true });
    } catch (err) {
      catDeleteErrorEl.textContent = err.message || "Could not delete that category.";
      catDeleteErrorEl.hidden = false;
      catDeleteConfirmBtn.disabled = false;
      catDeleteConfirmBtn.classList.remove("is-loading");
      return;
    }
    closeCatDelete({ returnFocus: false });
  }

  /**
   * Carry out the delete and put the viewer back in step with it.
   *
   * Every cached view is dropped and the card pool reset: a category delete
   * removes posts outright and re-files the ones it spared, so any page that
   * was fetched before it could now be wrong. The open category falls back to
   * the empty state when it was inside the subtree that just went.
   */
  async function runCategoryDelete(node, removes, triggerEl, opts) {
    const removedIds = catSubtreeIds(node);
    const parentId = node.parentId;
    catEditor.busy = true;
    let body;
    try {
      const res = await fetch(`/api/categories/${node.id}`, { method: "DELETE" });
      if (!res.ok) {
        const failure = await res.json().catch(() => ({}));
        throw new Error(failure.error || "Could not delete that category.");
      }
      body = await res.json();
    } catch (err) {
      catEditor.busy = false;
      if (opts && opts.keepDialog) throw err;
      showCatEditorError(err.message);
      return;
    }
    catEditor.busy = false;

    clearPersistedViews();
    viewCaches = new Map();
    cacheOrder = [];
    resetPool();
    const survives = editor().selectionSurvives(selectedCategoryId, removedIds);
    const keepId = survives ? selectedCategoryId : null;
    if (!survives) {
      selectedCategoryId = null;
      selectedButton = null;
      renderEmptyTitle();
      persistSelection();
      ensureViewHost();
      renderSelectPrompt();
    }
    for (const id of removedIds) catEditor.expanded.delete(id);
    await loadTree();
    await fetchSetup();
    if (keepId != null) {
      const stillThere = categoryIndex.get(keepId);
      const button = treeEl.querySelector(`[data-category-id="${keepId}"]`);
      if (stillThere && button) {
        selectedCategoryId = null; // force a real re-select, not a cache hit
        await selectCategory(stillThere, button);
      }
    }
    if (isCatEditorOpen()) {
      renderCategoryEditor();
      // The row is gone, so focus goes to the nearest thing that outlived it.
      const back =
        (parentId != null && catEditorTreeEl.querySelector(`.ced-bin[data-category-id="${parentId}"]`)) ||
        catEditorTreeEl.querySelector(".ced-add") ||
        catEditorCloseBtn;
      if (back && (!triggerEl || !triggerEl.isConnected)) back.focus();
    }
    const summary = editor().deletedSummary(node.name, body.removed || removes);
    announceCatEditor(summary);
    showToast(summary);
  }

  // --- keyboard -------------------------------------------------------------

  function onCatEditorKeydown(e) {
    if (!isCatEditorOpen()) return;
    // The confirmation is on top and owns the keyboard while it is open.
    if (isCatDeleteOpen()) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeCategoryEditor();
      return;
    }
    trapModalFocus(catEditorModalEl, e);
  }

  function onCatDeleteKeydown(e) {
    if (!isCatDeleteOpen()) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeCatDelete();
      return;
    }
    trapModalFocus(catDeleteModalEl, e);
  }

  function initCategoryEditor() {
    if (!catEditorOpenBtn || !catEditorModalEl) return;
    catEditorOpenBtn.addEventListener("click", () => openCategoryEditor(catEditorOpenBtn));
    catEditorCloseBtn.addEventListener("click", () => closeCategoryEditor());
    catEditorDoneBtn.addEventListener("click", () => closeCategoryEditor());
    catEditorBackdropEl.addEventListener("click", () => closeCategoryEditor());
    catDeleteCancelBtn.addEventListener("click", () => closeCatDelete());
    catDeleteBackdropEl.addEventListener("click", () => closeCatDelete());
    catDeleteConfirmBtn.addEventListener("click", () => void confirmCatDelete());
  }

  // ---- the Jev rules (rubric) editor (issue #102) --------------------------
  //
  // One dialog with two views: the saved sets of rules (a native radiogroup -
  // exactly one ranks) and the authoring form for one of them. `app.js` owns
  // only the markup and the round trips; every RULE - what is valid, what a
  // weight is as a share of the score, what switching would leave unranked -
  // is the pure `rubric-editor.js`.
  //
  // The paid-safety line, and it is the whole reason this dialog may exist at
  // all: nothing in here spends anything. Authoring, saving, switching and
  // deleting are free server-side (`/api/rubric*` never calls TypeSafe), so
  // the re-rank a new set of rules invites is surfaced as a SENTENCE, never as
  // an action. Spending still happens in exactly one place: the confirmation
  // dialog above, behind `{ confirm: true }`.
  const rubricModalEl = document.getElementById("rubric-modal");
  const rubricBackdropEl = document.getElementById("rubric-backdrop");
  const rubricOpenBtn = document.getElementById("rubric-open");
  const rubricCloseBtn = document.getElementById("rubric-close");
  const rubricDoneBtn = document.getElementById("rubric-done");
  const rubricNewBtn = document.getElementById("rubric-new");
  const rubricCancelBtn = document.getElementById("rubric-cancel");
  const rubricSaveBtn = document.getElementById("rubric-save");
  const rubricListViewEl = document.getElementById("rubric-list-view");
  const rubricEditViewEl = document.getElementById("rubric-edit-view");
  const rubricListEl = document.getElementById("rubric-list");
  const rubricSwitchNoteEl = document.getElementById("rubric-switch-note");
  const rubricListActionsEl = document.getElementById("rubric-list-actions");
  const rubricEditActionsEl = document.getElementById("rubric-edit-actions");
  const rubricNameInput = document.getElementById("rubric-name");
  const rubricDimensionsEl = document.getElementById("rubric-dimensions");
  const rubricAddDimensionBtn = document.getElementById("rubric-add-dimension");
  const rubricErrorEl = document.getElementById("rubric-error");
  const rubricAnnouncerEl = document.getElementById("rubric-announcer");
  const rubricRulesActiveEl = document.getElementById("rank-rules-active");

  /** The last `/api/rubric` payload. */
  let rubricState = null;
  /** The preset being authored, or null while the list is showing. */
  let rubricDraft = null;
  /** The id being edited; undefined while authoring a brand-new set. */
  let rubricDraftId;
  let rubricTrigger = null;
  let rubricBusy = false;
  /** The preset id whose Delete is one press from happening. */
  let rubricPendingDelete = null;

  const NO_RUBRIC_EDITOR = {
    blankDraft: () => ({ name: "", dimensions: [] }),
    blankDimension: () => ({ label: "", instructions: "", levels: ["", ""], weight: 1 }),
    draftFromPreset: (p) => ({ name: (p && p.name) || "", dimensions: [] }),
    moveItem: (list) => list,
    weightShares: (list) => (list || []).map(() => 0),
    validate: () => [],
    toPayload: (d) => d,
    canEdit: () => false,
    canDelete: () => false,
    presetLabel: (p) => (p && p.name) || "Ranking rules",
    coverageLine: () => "",
    switchWarning: () => null,
    activePreset: () => undefined,
  };

  function rubricApi() {
    return window.XBORubricEditor || NO_RUBRIC_EDITOR;
  }

  function isRubricOpen() {
    return !!rubricModalEl && !rubricModalEl.hidden;
  }

  function rubricAnnounce(message) {
    if (rubricAnnouncerEl) rubricAnnouncerEl.textContent = message;
  }

  function showRubricError(message) {
    if (!rubricErrorEl) return;
    rubricErrorEl.textContent = message || "";
    rubricErrorEl.hidden = !message;
  }

  /**
   * The active set of rules, named in the ranking popover.
   *
   * It reads off `/api/setup`'s ranking block, not off `/api/rubric`, so the
   * line is correct before the editor has ever been opened - and stays correct
   * after a run, since every path that re-reads setup passes through here.
   */
  function updateRubricSummary() {
    if (!rubricRulesActiveEl) return;
    const preset = setupState && setupState.ranking && setupState.ranking.preset;
    if (!preset) {
      rubricRulesActiveEl.textContent = "Ranking rules are unavailable.";
      return;
    }
    rubricRulesActiveEl.textContent = `Ranking with: ${rubricApi().presetLabel(preset)}`;
  }

  async function openRubricEditor(triggerEl) {
    if (!rubricModalEl) return;
    rubricTrigger = triggerEl || null;
    rubricDraft = null;
    rubricDraftId = undefined;
    rubricPendingDelete = null;
    showRubricError("");
    // The popover the button lives in is closed on the way out: a dialog over
    // a popover leaves the popover unreachable but still painted.
    const rankPopover = popovers.find((p) => p.name === "ranking");
    if (rankPopover && isPopoverOpen(rankPopover)) setPopoverOpen(rankPopover, false, { returnFocus: false });

    rubricModalEl.hidden = false;
    rubricBackdropEl.hidden = false;
    rubricCloseBtn.focus();
    document.addEventListener("keydown", onRubricKeydown);
    renderRubricList();
    await loadRubricState();
  }

  function closeRubricEditor() {
    if (!isRubricOpen()) return;
    rubricModalEl.hidden = true;
    rubricBackdropEl.hidden = true;
    document.removeEventListener("keydown", onRubricKeydown);
    rubricDraft = null;
    rubricDraftId = undefined;
    rubricPendingDelete = null;
    const trigger = rubricTrigger;
    rubricTrigger = null;
    // Back to where it was opened from, but only while that control is still
    // on screen: the ranking popover was closed on the way in, so its button
    // is usually not focusable by now and focusing it would strand focus on
    // <body>. The popover's own toggle is the visible thing that stands for it.
    const visible = (node) => !!node && !node.disabled && node.offsetParent !== null;
    const fallback = visible(trigger) ? trigger : document.getElementById("rank-toggle");
    if (fallback) fallback.focus();
  }

  async function loadRubricState() {
    try {
      rubricState = await getJSON("/api/rubric");
    } catch (_) {
      rubricState = null;
      showRubricError("Could not load your ranking rules. Please try again.");
      return;
    }
    if (rubricDraft) renderRubricEdit();
    else renderRubricList();
  }

  function rubricPresets() {
    return (rubricState && rubricState.presets) || [];
  }

  function rubricTotal() {
    return (rubricState && rubricState.total) || 0;
  }

  function setRubricView(editing) {
    rubricListViewEl.hidden = editing;
    rubricEditViewEl.hidden = !editing;
    rubricListActionsEl.hidden = editing;
    rubricEditActionsEl.hidden = !editing;
  }

  // --- view A: the saved sets ----------------------------------------------

  function renderRubricList() {
    setRubricView(false);
    if (!rubricState) {
      rubricListEl.replaceChildren(el("p", "rubric-item-meta", "Loading your ranking rules…"));
      if (rubricSwitchNoteEl) rubricSwitchNoteEl.hidden = true;
      return;
    }

    const api = rubricApi();
    const group = el("div", "rubric-list-group");
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-label", "Which ranking rules to score with");
    group.append(...rubricPresets().map((preset) => renderRubricItem(preset)));
    rubricListEl.replaceChildren(group);

    // What switching has already cost the library, stated once for the ACTIVE
    // set rather than repeated under every row.
    const active = api.activePreset(rubricState);
    const warning = active ? api.switchWarning(active, rubricTotal()) : null;
    if (rubricSwitchNoteEl) {
      rubricSwitchNoteEl.textContent = warning || "";
      rubricSwitchNoteEl.hidden = !warning;
    }
  }

  function renderRubricItem(preset) {
    const api = rubricApi();
    const active = rubricState && rubricState.activeId === preset.id;
    const item = el("div", "rubric-item");
    if (active) item.classList.add("is-active");

    const radio = document.createElement("input");
    radio.type = "radio";
    radio.className = "rubric-radio";
    radio.name = "rubric-active";
    radio.id = `rubric-preset-${preset.id}`;
    radio.value = preset.id;
    radio.checked = !!active;
    radio.disabled = rubricBusy;
    radio.addEventListener("change", () => {
      if (radio.checked) void activateRubricPreset(preset.id);
    });

    const main = el("div", "rubric-item-main");
    const name = el("label", "rubric-item-name", api.presetLabel(preset));
    name.htmlFor = radio.id;
    const questions = (preset.dimensions || []).length;
    const meta = el(
      "p",
      "rubric-item-meta",
      `${questions} question${questions === 1 ? "" : "s"} · ${api.coverageLine(preset, rubricTotal())}`,
    );
    meta.id = `${radio.id}-meta`;
    radio.setAttribute("aria-describedby", meta.id);
    main.append(name, meta);

    const actions = el("div", "rubric-item-actions");
    // The built-in set is the fallback everything else depends on, so it is
    // offered as clone-to-edit rather than edited in place.
    const duplicate = el("button", "rubric-link", "Duplicate");
    duplicate.type = "button";
    duplicate.disabled = rubricBusy;
    duplicate.addEventListener("click", () => startRubricEdit(preset, { clone: true }));
    actions.append(duplicate);

    if (api.canEdit(preset)) {
      const edit = el("button", "rubric-link", "Edit");
      edit.type = "button";
      edit.disabled = rubricBusy;
      edit.addEventListener("click", () => startRubricEdit(preset, { clone: false }));
      actions.append(edit);
    }
    if (api.canDelete(preset)) {
      // Two presses, inline: deleting a set of rules destroys no posts and no
      // scores (they are keyed by the rules' CONTENT, so re-creating the same
      // rules finds them again), which makes a whole confirmation dialog
      // heavier than the act deserves - but not so light it happens by
      // accident.
      const pending = rubricPendingDelete === preset.id;
      const remove = el("button", "rubric-link is-danger", pending ? "Confirm delete" : "Delete");
      remove.type = "button";
      remove.disabled = rubricBusy;
      remove.setAttribute(
        "aria-label",
        pending
          ? `Confirm deleting the ranking rules "${preset.name}"`
          : `Delete the ranking rules "${preset.name}"`,
      );
      remove.addEventListener("click", () => {
        if (pending) {
          void deleteRubricPreset(preset);
          return;
        }
        rubricPendingDelete = preset.id;
        renderRubricList();
        // Focus follows the button through the re-render, so the second press
        // is where the first one left the keyboard.
        const again = Array.from(rubricListEl.querySelectorAll(".rubric-radio")).find(
          (input) => input.value === preset.id,
        );
        const btn = again && again.closest(".rubric-item").querySelector(".is-danger");
        if (btn) btn.focus();
        rubricAnnounce(`Press again to delete "${preset.name}". Your scores are kept.`);
      });
      actions.append(remove);
    }

    item.append(radio, main, actions);
    return item;
  }

  async function activateRubricPreset(id) {
    if (rubricBusy) return;
    rubricBusy = true;
    showRubricError("");
    try {
      const body = await sendRubric("PUT", "/api/rubric/active", { id });
      await afterRubricChange(body);
      const preset = rubricApi().activePreset(rubricState);
      rubricAnnounce(`Now ranking with ${rubricApi().presetLabel(preset)}.`);
    } catch (err) {
      showRubricError(err.message);
    } finally {
      rubricBusy = false;
      renderRubricList();
    }
  }

  async function deleteRubricPreset(preset) {
    if (rubricBusy) return;
    rubricBusy = true;
    showRubricError("");
    try {
      const body = await sendRubric("DELETE", `/api/rubric/presets/${encodeURIComponent(preset.id)}`);
      await afterRubricChange(body);
      rubricAnnounce(`Deleted "${preset.name}". Any scores it produced are kept.`);
    } catch (err) {
      showRubricError(err.message);
    } finally {
      rubricBusy = false;
      rubricPendingDelete = null;
      renderRubricList();
      if (rubricNewBtn) rubricNewBtn.focus();
    }
  }

  // --- view B: authoring one set -------------------------------------------

  function startRubricNew() {
    rubricDraft = rubricApi().blankDraft();
    rubricDraftId = undefined;
    showRubricError("");
    renderRubricEdit();
    if (rubricNameInput) rubricNameInput.focus();
  }

  function startRubricEdit(preset, opts) {
    const clone = !!(opts && opts.clone);
    // A duplicate is a NEW set: it carries the source's questions and gets its
    // own name, so the original keeps its scores untouched.
    rubricDraft = rubricApi().draftFromPreset(
      clone ? { ...preset, builtIn: true } : preset,
      rubricPresets(),
    );
    rubricDraftId = clone ? undefined : preset.id;
    rubricPendingDelete = null;
    showRubricError("");
    renderRubricEdit();
    if (rubricNameInput) rubricNameInput.focus();
  }

  function cancelRubricEdit() {
    rubricDraft = null;
    rubricDraftId = undefined;
    showRubricError("");
    renderRubricList();
    if (rubricNewBtn) rubricNewBtn.focus();
  }

  function renderRubricEdit() {
    if (!rubricDraft) return;
    setRubricView(true);
    rubricNameInput.value = rubricDraft.name || "";
    const shares = rubricApi().weightShares(rubricDraft.dimensions);
    rubricDimensionsEl.replaceChildren(
      ...rubricDraft.dimensions.map((dim, index) => renderRubricDimension(dim, index, shares[index])),
    );
    const max = (rubricState && rubricState.limits && rubricState.limits.maxDimensions) || 12;
    rubricAddDimensionBtn.disabled = rubricDraft.dimensions.length >= max;
    rubricAddDimensionBtn.title = rubricAddDimensionBtn.disabled
      ? `A set of rules can hold at most ${max} dimensions.`
      : "";
    rubricSaveBtn.textContent = rubricDraftId ? "Save rules" : "Create rules";
  }

  function renderRubricDimension(dim, index, share) {
    const card = el("section", "rubric-dimension");
    const titleId = `rubric-dim-${index}-title`;
    // Named by its own dimension, not by the word "Dimension": a form of five
    // identically-labelled regions tells a screen-reader user nothing about
    // which one they have landed in.
    const describeCard = () => {
      const label = (dim.label || "").trim();
      card.setAttribute("aria-label", label ? `Dimension ${index + 1}: ${label}` : `Dimension ${index + 1}`);
    };
    describeCard();

    // The card's own header: which dimension this is, and the three controls
    // that act on the WHOLE dimension. They sat beside the name input in a
    // first cut, where they read as acting on the name.
    const head = el("div", "rubric-dim-head");
    const position = el("span", "rubric-dim-position", `Dimension ${index + 1}`);
    head.append(
      position,
      renderRubricRowTools(index, rubricDraft.dimensions.length, {
        move: (delta) => {
          rubricDraft.dimensions = rubricApi().moveItem(rubricDraft.dimensions, index, delta);
          renderRubricEdit();
          focusDimensionTool(index + delta, delta);
        },
        remove: () => {
          rubricDraft.dimensions.splice(index, 1);
          renderRubricEdit();
          focusAfterRemoval();
        },
        name: dim.label || `dimension ${index + 1}`,
        canRemove: rubricDraft.dimensions.length > 1,
      }),
    );

    const fields = el("div", "rubric-dim-fields");
    const nameField = el("div", "field");
    // "Name", not "Dimension": the card's own header already says which
    // dimension this is, and repeating it labels the field with its container.
    const nameLabel = el("label", "field-label", "Name");
    nameLabel.id = titleId;
    nameLabel.htmlFor = `rubric-dim-${index}-name`;
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "field-input";
    nameInput.id = nameLabel.htmlFor;
    nameInput.value = dim.label || rubricApi().humanizeKey(dim.id);
    nameInput.maxLength = 40;
    nameInput.autocomplete = "off";
    nameInput.addEventListener("input", () => {
      dim.label = nameInput.value;
      describeCard();
      relabelRowTools(card, dim.label || `dimension ${index + 1}`);
    });
    nameField.append(nameLabel, nameInput);

    const weightField = el("div", "field rubric-dim-weight");
    const weightLabel = el("label", "field-label", "Weight");
    weightLabel.htmlFor = `rubric-dim-${index}-weight`;
    const weightInput = document.createElement("input");
    weightInput.type = "number";
    weightInput.className = "field-input";
    weightInput.id = weightLabel.htmlFor;
    weightInput.min = "0.5";
    weightInput.max = "100";
    weightInput.step = "0.5";
    weightInput.value = String(dim.weight);
    const weightHint = el("p", "field-hint", shareLabel(share));
    weightHint.id = `${weightInput.id}-hint`;
    weightInput.setAttribute("aria-describedby", weightHint.id);
    weightInput.addEventListener("input", () => {
      dim.weight = Number(weightInput.value);
      // Only ratios matter, so every share moves when one weight does - they
      // are repainted in place rather than by re-rendering, which would take
      // the caret out of the field being typed in.
      refreshWeightShares();
    });
    weightField.append(weightLabel, weightInput, weightHint);

    fields.append(nameField, weightField);

    const questionField = el("div", "field");
    const questionLabel = el("label", "field-label", "Question");
    questionLabel.htmlFor = `rubric-dim-${index}-question`;
    const question = document.createElement("textarea");
    question.className = "field-textarea";
    question.id = questionLabel.htmlFor;
    question.rows = 2;
    question.value = dim.instructions || "";
    const questionHint = el(
      "p",
      "field-hint",
      "One specific thing to judge. A question weighing several independent factors scores worse than two questions do.",
    );
    questionHint.id = `${question.id}-hint`;
    question.setAttribute("aria-describedby", questionHint.id);
    question.addEventListener("input", () => {
      dim.instructions = question.value;
      autoGrow(question);
    });
    growWhenMounted(question);
    questionField.append(questionLabel, question, questionHint);

    card.append(head, fields, questionField, renderRubricLevels(dim, index));
    return card;
  }

  /**
   * Grow a prose field to its content.
   *
   * The levels ARE the tuning surface - the model reads them, not the weights -
   * so a field that shows two of their four lines hides the thing the editor
   * exists for. `resize: vertical` still lets the owner shrink one back.
   */
  function autoGrow(field) {
    field.style.height = "auto";
    field.style.height = `${field.scrollHeight}px`;
  }

  /**
   * The same, once the field is actually in the document: `scrollHeight` is 0
   * on an element that has never been laid out, so sizing it at build time
   * would collapse every field to nothing.
   */
  function growWhenMounted(field) {
    requestAnimationFrame(() => {
      if (field.isConnected) autoGrow(field);
    });
  }

  /** Keep the row tools' accessible names in step with a renamed dimension. */
  function relabelRowTools(card, name) {
    const tools = card.querySelectorAll(".rubric-dim-head .rubric-icon-btn");
    const labels = [`Move ${name} up`, `Move ${name} down`, `Remove ${name}`];
    tools.forEach((btn, i) => btn.setAttribute("aria-label", labels[i]));
  }

  function shareLabel(share) {
    return `${share || 0}% of the score`;
  }

  function refreshWeightShares() {
    const shares = rubricApi().weightShares(rubricDraft.dimensions);
    rubricDimensionsEl.querySelectorAll(".rubric-dim-weight .field-hint").forEach((hint, i) => {
      hint.textContent = shareLabel(shares[i]);
    });
  }

  /**
   * The levels: the ordered descriptions of what each score MEANS, lowest
   * first. They are the real tuning surface - the model reads these, not the
   * weights - which is why they get a labelled list of their own rather than
   * one comma-separated field.
   */
  function renderRubricLevels(dim, dimIndex) {
    const wrap = el("div", "rubric-levels");
    const head = el("div", "rubric-levels-head");
    const heading = el("span", "field-label", "Levels, lowest first");
    heading.id = `rubric-dim-${dimIndex}-levels`;
    const min = (rubricState && rubricState.limits && rubricState.limits.minLevels) || 2;
    const max = (rubricState && rubricState.limits && rubricState.limits.maxLevels) || 10;
    head.append(heading, el("span", "field-hint", `${min}–${max}; the model reads these`));

    const list = el("div", "rubric-level-list");
    list.setAttribute("role", "group");
    list.setAttribute("aria-labelledby", heading.id);
    dim.levels.forEach((level, index) => {
      const row = el("div", "rubric-level-row");
      const position = el("span", "rubric-level-index", String(index + 1));
      position.setAttribute("aria-hidden", "true");
      // A textarea, not an input: a level is a sentence describing what that
      // score MEANS, and a single-line field shows the owner the first six
      // words of the thing they came here to tune.
      const input = document.createElement("textarea");
      input.className = "field-textarea rubric-level-input";
      input.rows = 2;
      input.value = level;
      input.setAttribute("aria-label", `Level ${index + 1} of dimension ${dimIndex + 1}`);
      input.addEventListener("input", () => {
        dim.levels[index] = input.value;
        autoGrow(input);
      });
      growWhenMounted(input);
      row.append(
        position,
        input,
        renderRubricRowTools(index, dim.levels.length, {
          move: (delta) => {
            dim.levels = rubricApi().moveItem(dim.levels, index, delta);
            renderRubricEdit();
            focusLevel(dimIndex, index + delta);
          },
          remove: () => {
            dim.levels.splice(index, 1);
            renderRubricEdit();
            focusLevel(dimIndex, Math.max(0, index - 1));
          },
          what: "level",
          name: `level ${index + 1}`,
          canRemove: dim.levels.length > min,
        }),
      );
      list.append(row);
    });

    const add = el("button", "rubric-add");
    add.type = "button";
    add.append(el("span", "rubric-plus", "+"), document.createTextNode("Add a level"));
    add.querySelector(".rubric-plus").setAttribute("aria-hidden", "true");
    add.disabled = dim.levels.length >= max;
    add.addEventListener("click", () => {
      dim.levels.push("");
      renderRubricEdit();
      focusLevel(dimIndex, dim.levels.length - 1);
    });

    wrap.append(head, list, add);
    return wrap;
  }

  /** Move up / move down / remove, the same three controls at both depths. */
  function renderRubricRowTools(index, count, opts) {
    const tools = el("div", "rubric-dim-tools");
    const button = (glyph, label, disabled, onClick, danger) => {
      const btn = el("button", `rubric-icon-btn${danger ? " is-danger" : ""}`, glyph);
      btn.type = "button";
      btn.setAttribute("aria-label", label);
      btn.disabled = disabled;
      btn.addEventListener("click", onClick);
      return btn;
    };
    tools.append(
      button("↑", `Move ${opts.name} up`, index === 0, () => opts.move(-1)),
      button("↓", `Move ${opts.name} down`, index === count - 1, () => opts.move(1)),
      button("×", `Remove ${opts.name}`, !opts.canRemove, () => opts.remove(), true),
    );
    return tools;
  }

  /** Keep the keyboard on the control that just moved, not back at the top. */
  function focusDimensionTool(index, delta) {
    const cards = rubricDimensionsEl.querySelectorAll(".rubric-dimension");
    const card = cards[index];
    if (!card) return;
    const buttons = card.querySelectorAll(".rubric-dim-head .rubric-icon-btn");
    const target = delta < 0 ? buttons[0] : buttons[1];
    if (target && !target.disabled) target.focus();
    else if (card.querySelector(".rubric-dim-fields .field-input")) {
      card.querySelector(".rubric-dim-fields .field-input").focus();
    }
  }

  function focusAfterRemoval() {
    const first = rubricDimensionsEl.querySelector(".rubric-dim-fields .field-input");
    if (first) first.focus();
    else if (rubricAddDimensionBtn) rubricAddDimensionBtn.focus();
  }

  function focusLevel(dimIndex, levelIndex) {
    const card = rubricDimensionsEl.querySelectorAll(".rubric-dimension")[dimIndex];
    if (!card) return;
    const input = card.querySelectorAll(".rubric-level-row .rubric-level-input")[levelIndex];
    if (input) input.focus();
  }

  async function saveRubricDraft() {
    if (!rubricDraft || rubricBusy) return;
    rubricDraft.name = rubricNameInput.value;
    const others = rubricPresets().filter((p) => p.id !== rubricDraftId);
    const errors = rubricApi().validate(rubricDraft, others, rubricState);
    if (errors.length > 0) {
      showRubricError(errors.join("\n"));
      rubricAnnounce(`${errors.length} problem${errors.length === 1 ? "" : "s"} to fix.`);
      return;
    }

    rubricBusy = true;
    rubricSaveBtn.disabled = true;
    showRubricError("");
    try {
      const payload = rubricApi().toPayload(rubricDraft);
      const body = rubricDraftId
        ? await sendRubric("PUT", `/api/rubric/presets/${encodeURIComponent(rubricDraftId)}`, payload)
        : await sendRubric("POST", "/api/rubric/presets", payload);
      await afterRubricChange(body);
      rubricDraft = null;
      rubricDraftId = undefined;
      // Cleared BEFORE the list is rendered: every control in it is disabled
      // while a request is in flight, and rendering inside the busy window
      // painted the whole list - radios included - greyed out.
      rubricBusy = false;
      renderRubricList();
      rubricAnnounce("Ranking rules saved.");
      if (rubricNewBtn) rubricNewBtn.focus();
    } catch (err) {
      showRubricError(err.message);
    } finally {
      rubricBusy = false;
      rubricSaveBtn.disabled = false;
    }
  }

  async function sendRubric(method, url, payload) {
    const res = await fetch(url, {
      method,
      ...(payload === undefined
        ? {}
        : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      // The server's own sentences, which are written to be shown: one per
      // problem, naming the field and what is wrong with it.
      throw new Error((body.errors && body.errors.join("\n")) || body.error || "That did not work. Please try again.");
    }
    return body;
  }

  /**
   * Put the viewer back in step with a change to the rules.
   *
   * Which scores are CURRENT is a function of the active set of rules, so a
   * change here has exactly the consequences a finished ranking run has: the
   * chips, the unranked dot and the "Top score" order all move, and every
   * cached page was fetched under the old answer. `refreshAfterRank` is that
   * refresh, reused rather than restated - no bookmark, category or count is
   * touched either way.
   */
  async function afterRubricChange(body) {
    if (body && body.rubric) rubricState = body.rubric;
    if (body && body.ranking && setupState) setupState.ranking = body.ranking;
    await refreshAfterRank();
  }

  function onRubricKeydown(e) {
    if (!isRubricOpen()) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      // One level at a time: from the form, Escape goes back to the list
      // rather than discarding the draft AND the dialog in one press.
      if (rubricDraft) cancelRubricEdit();
      else closeRubricEditor();
      return;
    }
    trapModalFocus(rubricModalEl, e);
  }

  function initRubricEditor() {
    if (!rubricOpenBtn || !rubricModalEl) return;
    rubricOpenBtn.addEventListener("click", () => void openRubricEditor(rubricOpenBtn));
    rubricCloseBtn.addEventListener("click", () => closeRubricEditor());
    rubricDoneBtn.addEventListener("click", () => closeRubricEditor());
    rubricBackdropEl.addEventListener("click", () => closeRubricEditor());
    rubricNewBtn.addEventListener("click", () => startRubricNew());
    rubricCancelBtn.addEventListener("click", () => cancelRubricEdit());
    rubricSaveBtn.addEventListener("click", () => void saveRubricDraft());
    rubricAddDimensionBtn.addEventListener("click", () => {
      if (!rubricDraft) return;
      rubricDraft.dimensions.push(rubricApi().blankDimension());
      renderRubricEdit();
      const cards = rubricDimensionsEl.querySelectorAll(".rubric-dimension");
      const last = cards[cards.length - 1];
      const field = last && last.querySelector(".rubric-dim-fields .field-input");
      if (field) field.focus();
    });
    if (rubricNameInput) {
      rubricNameInput.addEventListener("input", () => {
        if (rubricDraft) rubricDraft.name = rubricNameInput.value;
      });
    }
  }

  // ---- summary modal -------------------------------------------------------
  // Fetches (or serves from cache) an on-demand LLM summary of a bookmark's
  // content - the post text, plus its extracted article when available - in
  // a large in-app modal: a spinner while generating, the summary text once
  // ready, a clear no-token message when summaries are disabled, or a
  // retryable error on failure.
  function isSummaryOpen() {
    return !summaryModalEl.hidden;
  }

  function openSummary(bm, triggerEl) {
    summaryReturnFocusEl = triggerEl;
    summaryMetaEl.hidden = true;
    summaryMetaEl.textContent = "";
    renderSummaryLoading();

    summaryBackdropEl.hidden = false;
    summaryModalEl.hidden = false;
    summaryCloseBtn.focus();
    document.addEventListener("keydown", onSummaryKeydown);

    fetchSummary(bm);
  }

  function fetchSummary(bm) {
    const seq = ++summaryRequestSeq;
    renderSummaryLoading();

    getJSON(`/api/bookmarks/${bm.id}/summary`)
      .then((data) => {
        if (seq !== summaryRequestSeq) return; // superseded by a newer open/retry
        renderSummaryResult(data.summary);
        markSummarized(bm);
      })
      .catch((err) => {
        if (seq !== summaryRequestSeq) return;
        if (err && err.status === 503) {
          // No provider is available at all - stop offering the control.
          summaryAvailable = false;
          if (err.body && err.body.error) summaryUnavailableReason = err.body.error;
          renderSummaryUnavailable(err.body && err.body.error);
        } else if (err && err.status === 422) {
          // The bookmark holds nothing summarizable (a link-only post whose
          // link could not be read). Not a failure - an explanation, with no
          // Retry, since retrying cannot change the answer.
          renderSummaryNothing(err.body && err.body.error);
        } else {
          // The provider is there but the call failed (CLI not logged in,
          // quota, network). Keep the button enabled and show what to fix.
          renderSummaryError(bm, err && err.body && err.body.error);
        }
      });
  }

  /**
   * Flips a bookmark's in-memory `hasSummary` flag and its action-row
   * button (whichever card triggered the open/generate) to the "Summary"
   * state, without a full reload - a fresh generation, or a summary the
   * server already had cached, both count.
   */
  function markSummarized(bm) {
    if (bm.hasSummary) return;
    bm.hasSummary = true;
    if (summaryReturnFocusEl) applySummarizeButtonLabel(summaryReturnFocusEl, true);
  }

  function closeSummary() {
    if (!isSummaryOpen()) return;
    summaryModalEl.hidden = true;
    summaryBackdropEl.hidden = true;
    summaryRequestSeq += 1; // discard any in-flight fetch's result
    document.removeEventListener("keydown", onSummaryKeydown);
    if (summaryReturnFocusEl && summaryReturnFocusEl.isConnected) summaryReturnFocusEl.focus();
    summaryReturnFocusEl = null;
  }

  function renderSummaryLoading() {
    const loading = el("div", "reader-loading");
    loading.setAttribute("role", "status");
    const spinner = el("span", "reader-spinner");
    spinner.setAttribute("aria-hidden", "true");
    loading.append(spinner, el("span", null, "Generating summary…"));
    summaryBodyEl.replaceChildren(loading);
  }

  function renderSummaryResult(record) {
    summaryMetaEl.textContent = record.generatedAt
      ? `Summarized ${formatDate(record.generatedAt)}`
      : "";
    summaryMetaEl.hidden = !record.generatedAt;
    const content = el("div", "summary-text");
    content.innerHTML = renderSummaryMarkdown(record.summary);
    summaryBodyEl.replaceChildren(content);
  }

  function renderSummaryUnavailable(message) {
    const fallback = el("div", "reader-fallback");
    fallback.setAttribute("role", "status");
    fallback.appendChild(el("span", "reader-fallback-icon", "🔑"));
    fallback.appendChild(
      el("p", "reader-fallback-msg", message || summaryUnavailableReason),
    );
    summaryBodyEl.replaceChildren(fallback);
  }

  /**
   * The "nothing to summarize" state: a calm explanation, not an error. Reuses
   * the reader modal's fallback layout (and its tokens) and deliberately omits
   * a Retry - the server settled this without calling the model, so a repeat
   * request returns the same answer.
   */
  function renderSummaryNothing(message) {
    const fallback = el("div", "reader-fallback");
    fallback.setAttribute("role", "status");
    fallback.appendChild(el("span", "reader-fallback-icon", "📄"));
    fallback.appendChild(
      el(
        "p",
        "reader-fallback-msg",
        message ||
          "Nothing to summarize: this bookmark has no readable text or article content.",
      ),
    );
    summaryBodyEl.replaceChildren(fallback);
  }

  function renderSummaryError(bm, message) {
    const fallback = el("div", "reader-fallback");
    fallback.setAttribute("role", "alert");
    fallback.appendChild(el("span", "reader-fallback-icon", "⚠️"));
    fallback.appendChild(
      el(
        "p",
        "reader-fallback-msg",
        message || "Couldn't generate a summary. Please try again.",
      ),
    );
    const retry = el("button", "btn btn-secondary", "Retry");
    retry.type = "button";
    retry.addEventListener("click", () => fetchSummary(bm));
    fallback.appendChild(retry);
    summaryBodyEl.replaceChildren(fallback);
  }

  function onSummaryKeydown(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      closeSummary();
      return;
    }
    trapModalFocus(summaryModalEl, e);
  }

  function initSummary() {
    summaryCloseBtn.addEventListener("click", closeSummary);
    summaryBackdropEl.addEventListener("click", closeSummary);
  }

  /** Check once whether summaries are enabled server-side (an LLM provider is available). */
  async function loadSummaryStatus() {
    try {
      const data = await getJSON("/api/summary-status");
      summaryAvailable = Boolean(data.available);
      if (data.reason) summaryUnavailableReason = data.reason;
    } catch (_) {
      // Leave the optimistic default; the endpoint itself still degrades
      // gracefully (503) if a summary is actually requested.
    }
  }

  // ---- filters -----------------------------------------------------------

  function initSearch() {
    if (!searchInput) return;
    const onInput = () => {
      searchClear.hidden = searchInput.value.trim().length === 0;
      renderTree();
    };
    searchInput.addEventListener("input", onInput);
    searchClear.addEventListener("click", () => {
      searchInput.value = "";
      searchClear.hidden = true;
      renderTree();
      searchInput.focus();
    });
    // Escape clears the query without also closing the sidebar drawer.
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && searchInput.value.length > 0) {
        e.preventDefault();
        e.stopPropagation();
        searchInput.value = "";
        searchClear.hidden = true;
        renderTree();
      }
    });
  }

  // ---- filter tab bar (issue #65) ----------------------------------------
  // The full-width bar under the top bar: Unread / Read / All / Favorites.
  // A real ARIA tablist, so it owns the keyboard contract that promises -
  // arrow keys move between tabs (roving tabindex), Home/End jump to the
  // ends, and the list of cards is its one panel.

  function filterTabButtons() {
    return filterTabsEl ? Array.from(filterTabsEl.querySelectorAll(".filter-tab")) : [];
  }

  /** Paint the selected tab and move the roving tabindex onto it. */
  function renderFilterTabs() {
    for (const tab of filterTabButtons()) {
      const selected = tab.dataset.filter === activeFilter;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      // The panel is labelled by whichever tab is showing it.
      if (selected && listRoot) listRoot.setAttribute("aria-labelledby", tab.id);
    }
  }

  /** Switch tabs: cache the view being left, then show the new one. */
  function selectFilter(filter) {
    if (filter === activeFilter) return;
    if (selectedCategoryId != null) saveCurrentViewToCache();
    activeFilter = filter;
    renderFilterTabs();
    // Changing the tab re-pages the category from the top, unless this exact
    // category+filter is already cached from a prior visit.
    if (selectedCategoryId != null) {
      showCategoryView({ sameCategory: true });
      persistSelection();
    }
  }

  function initFilterTabs() {
    if (!filterTabsEl) return;
    renderFilterTabs();
    for (const tab of filterTabButtons()) {
      tab.addEventListener("click", () => selectFilter(tab.dataset.filter));
    }
    filterTabsEl.addEventListener("keydown", (e) => {
      const tabs = filterTabButtons();
      const from = tabs.indexOf(document.activeElement);
      if (from === -1) return;
      let to = -1;
      if (e.key === "ArrowRight") to = (from + 1) % tabs.length;
      else if (e.key === "ArrowLeft") to = (from - 1 + tabs.length) % tabs.length;
      else if (e.key === "Home") to = 0;
      else if (e.key === "End") to = tabs.length - 1;
      if (to === -1) return;
      e.preventDefault();
      // Follow the focus, the standard automatic-activation tab pattern:
      // every panel is one already-paged list, so there is nothing costly
      // about arrowing across them.
      tabs[to].focus();
      selectFilter(tabs[to].dataset.filter);
    });
  }

  // ---- last-sync indicator ------------------------------------------------
  // Absolute date comes from the server; the "N ago" part is computed here so
  // it stays current across reloads (and is refreshed on an interval) without
  // needing another round trip.
  const syncStatusEl = document.getElementById("sync-status");
  const syncStatusDateEl = document.getElementById("sync-status-date");
  const syncStatusRelEl = document.getElementById("sync-status-rel");
  let lastSyncedAt = null;

  function formatRelativeTime(iso) {
    const diffMs = Date.now() - new Date(iso).getTime();
    const diffMin = Math.round(diffMs / 60000);
    if (diffMin < 1) return "just now";
    if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? "" : "s"} ago`;
    const diffHour = Math.round(diffMin / 60);
    if (diffHour < 24) return `${diffHour} hour${diffHour === 1 ? "" : "s"} ago`;
    const diffDay = Math.round(diffHour / 24);
    return `${diffDay} day${diffDay === 1 ? "" : "s"} ago`;
  }

  function renderSyncStatus() {
    if (!syncStatusEl || !syncStatusDateEl || !syncStatusRelEl) return;
    if (!lastSyncedAt) {
      syncStatusDateEl.textContent = "Never synced";
      syncStatusRelEl.textContent = "";
    } else {
      const dateText = new Date(lastSyncedAt).toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
      });
      syncStatusDateEl.textContent = `Last synced: ${dateText}`;
      syncStatusRelEl.textContent = formatRelativeTime(lastSyncedAt);
    }
    syncStatusEl.hidden = false;
  }

  async function loadSyncStatus() {
    if (!syncStatusEl) return;
    try {
      const res = await fetch("/api/sync-status");
      if (!res.ok) return;
      const data = await res.json();
      lastSyncedAt = data.lastSyncedAt;
      renderSyncStatus();
      if (lastSyncedAt) setInterval(renderSyncStatus, 60000);
    } catch (_) {
      /* leave the indicator hidden rather than show a stale/misleading state */
    }
  }


  // ======================================================================
  // In-app sync, first-run setup, and the categorization selector (#71)
  // ======================================================================
  // The viewer can now do the whole job itself: authorize X, choose how
  // categorization runs, and fetch + categorize - no terminal. The server
  // owns every durable part of that (`/api/setup`, `/api/settings`,
  // `/api/sync`); this section is the UI over it.

  const syncBtn = document.getElementById("sync-btn");
  const syncProgressEl = document.getElementById("sync-progress");
  const syncProgressTextEl = document.getElementById("sync-progress-text");
  const syncProgressDetailsEl = document.getElementById("sync-progress-details");
  const syncProgressLogEl = document.getElementById("sync-progress-log");
  const syncProgressRetryBtn = document.getElementById("sync-progress-retry");
  const syncProgressDismissBtn = document.getElementById("sync-progress-dismiss");

  // The last /api/setup payload: what is configured, what can be chosen, and
  // which prerequisites are in place. Everything below renders from it.
  let setupState = null;
  let syncPollTimer = null;

  const SYNC_POLL_MS = 1200;
  const SYNC_DONE_DISMISS_MS = 8000;

  // Every window.XBO* helper in this viewer is optional by construction (a
  // missing script must degrade, not throw); this one answers with inert
  // defaults so the sync controls simply stay disabled.
  const NO_CATEGORIZATION = {
    fieldsFor: () => ({
      taxonomyProvider: false,
      taxonomyModel: false,
      effort: false,
      assignmentProvider: false,
      assignmentModel: false,
    }),
    passProvider: () => "",
    findProvider: () => null,
    findMethod: () => null,
    modelOptions: () => [],
    effortOptions: () => [],
    sourcesOf: () => [],
    findSource: () => null,
    sourceOfModel: () => null,
    passSource: () => "",
    pickerEntries: () => [],
    sourceNotice: () => ({ text: "", state: "none" }),
    passProblems: () => [],
    toPayload: (v) => v,
    methodBlocker: () => null,
    syncBlockers: () => [],
    needsAuthorizationOnly: () => false,
    emptyStateKind: () => "none",
    showFilterTabs: (_count, categoryId) => categoryId != null,
    progressLine: () => "",
  };

  function categorization() {
    return window.XBOCategorization || NO_CATEGORIZATION;
  }

  async function fetchSetup() {
    try {
      setupState = await getJSON("/api/setup");
    } catch (_) {
      // A viewer that cannot reach its own server has bigger problems; leave
      // the sync control disabled rather than showing a half-truth.
      setupState = null;
    }
    applySetupState();
    return setupState;
  }

  /** Push the current setup payload into every control that reflects it. */
  function applySetupState() {
    updateSyncButton();
    updateRankControl();
    updateRubricSummary();
    updateEmptyLibraryState();
    updateToolbarVisibility();
    updateSortAvailability();
    if (settingsForm && setupState && !settingsDirty) {
      settingsForm.setCatalog(setupState.catalog);
      settingsForm.setValues(setupState.settings);
      updateFormNote(settingsForm, settingsNoteEl);
    }
    if (setupForm && setupState) setupForm.setCatalog(setupState.catalog);
    if (isSetupOpen()) renderSetupStep();
  }

  // ---- the Sync button ---------------------------------------------------

  function syncAvailable() {
    return !!(setupState && setupState.sync && setupState.sync.available);
  }

  function syncIsRunning() {
    const status = setupState && setupState.sync && setupState.sync.status;
    return !!status && status.state === "running";
  }

  function updateSyncButton() {
    if (!syncBtn) return;
    const running = syncIsRunning();
    const blockers = setupState ? categorization().syncBlockers(setupState) : [];
    const blocked = !setupState || !syncAvailable();

    syncBtn.classList.toggle("is-syncing", running);
    syncBtn.disabled = running || blocked;
    const label = syncBtn.querySelector(".sync-btn-label");
    if (label) label.textContent = running ? "Syncing…" : "Sync";
    syncBtn.setAttribute("aria-label", running ? "Syncing your bookmarks" : "Sync bookmarks from X");
    // The tooltip carries the first thing to fix, so a disabled control is
    // never a dead end.
    if (blocked && setupState && setupState.sync && setupState.sync.reason) {
      syncBtn.title = setupState.sync.reason;
    } else if (!running && blockers.length > 0) {
      syncBtn.title = blockers[0];
    } else {
      syncBtn.removeAttribute("title");
    }
  }

  /** Start a sync, unless something the owner must fix comes first. */
  async function startSync(opts) {
    const options = opts || {};
    if (!setupState) await fetchSetup();
    const blockers = setupState ? categorization().syncBlockers(setupState) : [];
    if (blockers.length > 0 && !options.force) {
      renderSyncProgress({ state: "error", error: blockers[0], messages: [] });
      // The guided flow is the fix for exactly one of these - an app that was
      // never authorized - so that is the only one it opens for. A missing
      // credential is fixed outside the app; saying so is all it can do.
      if (!options.fromSetup && categorization().needsAuthorizationOnly(setupState)) openSetup(1);
      return false;
    }

    renderSyncProgress({
      state: "running",
      startedAt: new Date().toISOString(),
      messages: ["Starting sync…"],
    });
    try {
      const res = await fetch("/api/sync", { method: "POST" });
      if (!res.ok && res.status !== 409) {
        const body = await res.json().catch(() => ({}));
        renderSyncProgress({ state: "error", error: body.error || "Could not start the sync.", messages: [] });
        return false;
      }
    } catch (_) {
      renderSyncProgress({ state: "error", error: "Could not reach the server.", messages: [] });
      return false;
    }
    markSyncRunning();
    pollSync();
    return true;
  }

  /**
   * The server has taken the run: put every control that reflects it in step
   * now rather than a poll interval later. The first-run view's scrim hangs
   * off this same status, so without it the get-started view would stay
   * clickable for the first second of a run it had already started.
   */
  function markSyncRunning() {
    if (setupState && setupState.sync) {
      setupState.sync.status = { state: "running", messages: ["Starting sync…"] };
    }
    updateSyncButton();
    updateFirstRun();
  }

  function pollSync() {
    if (syncPollTimer) return;
    const tick = async () => {
      let data;
      try {
        data = await getJSON("/api/sync");
      } catch (_) {
        return; // transient; the next tick tries again
      }
      if (setupState && setupState.sync) setupState.sync.status = data.status;
      if (data.lastSyncedAt) {
        lastSyncedAt = data.lastSyncedAt;
        renderSyncStatus();
      }
      renderSyncProgress(data.status);
      updateSyncButton();
      updateFirstRun(); // raises/lifts the get-started scrim with the run
      if (isSetupOpen()) renderSetupStep();

      if (data.status && (data.status.state === "done" || data.status.state === "error")) {
        stopSyncPolling();
        if (data.status.state === "done") await refreshAfterSync();
      }
    };
    syncPollTimer = setInterval(tick, SYNC_POLL_MS);
    void tick();
  }

  function stopSyncPolling() {
    if (!syncPollTimer) return;
    clearInterval(syncPollTimer);
    syncPollTimer = null;
  }

  /**
   * Bring the viewer up to date with what the sync stored: the tree (new
   * categories and counts) and the open category. Cached views are dropped
   * wholesale - their pages predate the sync, so any of them could now be
   * missing a post.
   */
  async function refreshAfterSync() {
    clearPersistedViews();
    viewCaches = new Map();
    cacheOrder = [];
    resetPool();
    const keepId = selectedCategoryId;
    await loadTree();
    await fetchSetup();
    if (keepId == null) return;
    const node = categoryIndex.get(keepId);
    const button = treeEl.querySelector(`[data-category-id="${keepId}"]`);
    if (node && button) {
      selectedCategoryId = null; // force a real re-select, not a cache hit
      await selectCategory(node, button);
    }
  }

  // ---- the progress strip ------------------------------------------------

  /**
   * Paint one progress strip from a job status. Shared by the sync and the
   * ranking run (issue #80): both are one-at-a-time server-side jobs whose
   * progress is their own logger output, so they get the same strip rather
   * than two near-copies that drift.
   *
   * `line` is the caller's pure formatter - `XBOCategorization.progressLine`
   * for a sync, `XBORanking.progressLine` for a run.
   */
  function renderProgressStrip(els, status, line) {
    if (!els.root) return;
    if (!status || status.state === "idle") {
      els.root.hidden = true;
      return;
    }
    const state = status.state;
    els.root.hidden = false;
    els.root.setAttribute("data-state", state);
    els.text.textContent = line(status);

    const messages = status.messages || [];
    els.details.hidden = messages.length === 0;
    if (messages.length > 0) {
      els.log.replaceChildren(...messages.map((m) => el("li", "", m)));
    }
    els.retry.hidden = state !== "error";
    els.dismiss.hidden = state === "running";

    if (state === "done") {
      // A good-news strip clears itself; an error stays until acknowledged.
      window.setTimeout(() => {
        if (els.root.getAttribute("data-state") === "done") els.root.hidden = true;
      }, SYNC_DONE_DISMISS_MS);
    }
  }

  // ONE strip, two possible subjects (issue #98). A ranking run used to paint
  // its progress inside the ranking popover, where it was invisible the moment
  // the panel was dismissed - and where the owner had to know to look for it,
  // in a different place from the sync they had watched a minute earlier. Both
  // are one-at-a-time server jobs whose progress is their own log, and the
  // server refuses to run them at once, so they share the strip under the
  // filter tabs and `XBORanking.progressSource` decides which one it shows.
  const progressEls = {
    root: syncProgressEl,
    text: syncProgressTextEl,
    details: syncProgressDetailsEl,
    log: syncProgressLogEl,
    retry: syncProgressRetryBtn,
    dismiss: syncProgressDismissBtn,
  };

  // The two statuses the strip chooses between. They are held here rather than
  // read off `setupState` because several are OPTIMISTIC - "Starting sync…"
  // exists before any server has confirmed anything, and an error raised
  // before the request even left the browser has no server status at all.
  let syncStatusView = null;
  let rankStatusView = null;
  /** Which job the strip is currently showing - drives retry and dismiss. */
  let progressOwner = null;

  function renderSharedProgress() {
    progressOwner = ranking().progressSource(syncStatusView, rankStatusView);
    const isRank = progressOwner === "rank";
    if (syncProgressDismissBtn) {
      syncProgressDismissBtn.setAttribute(
        "aria-label",
        isRank ? "Dismiss ranking status" : "Dismiss sync status",
      );
    }
    if (isRank) renderProgressStrip(progressEls, rankStatusView, (s) => ranking().progressLine(s));
    else renderProgressStrip(progressEls, syncStatusView, (s) => categorization().progressLine(s));
  }

  function renderSyncProgress(status) {
    syncStatusView = status;
    renderSharedProgress();
  }

  function renderRankProgress(status) {
    rankStatusView = status;
    renderSharedProgress();
  }

  function initSync() {
    if (syncBtn) syncBtn.addEventListener("click", () => startSync());
    // Both retries are a fresh START, never a resume - and a ranking retry is
    // a fresh AUTHORIZATION, so it reopens the paid dialog rather than the run.
    if (syncProgressRetryBtn) {
      syncProgressRetryBtn.addEventListener("click", () => {
        if (progressOwner === "rank") openRankConfirm();
        else void startSync();
      });
    }
    if (syncProgressDismissBtn) {
      syncProgressDismissBtn.addEventListener("click", () => {
        syncProgressEl.hidden = true;
        // The job's own top-bar icon, not the button inside its popover: that
        // popover is normally closed by now, and focusing a hidden control
        // silently strands focus on <body>.
        const toggle = document.getElementById(progressOwner === "rank" ? "rank-toggle" : "sync-toggle");
        if (toggle) toggle.focus();
      });
    }
  }

  // ======================================================================
  // In-app ranking run (issue #80)
  // ======================================================================
  // The Jev ranking pass, startable from the app instead of the terminal -
  // but it is PAID per token, so the control is built around that fact rather
  // than around convenience. Three things stand between a press and a bill,
  // and all three are load-bearing:
  //
  //   1. The server's own gate: TYPESAFE_API_KEY must resolve. Ranking itself
  //      is ON by default now (issue #89) - the key is what decides whether a
  //      run is possible, and when it is missing the button is disabled and
  //      the panel SAYS WHY, in the credential chain's own words ("TypeSafe
  //      API key missing…") - a blocker message, not a dead control.
  //   2. An explicit confirmation dialog that names the price before the
  //      scope, and whose confirm button restates how many bookmarks are
  //      covered. This is the in-app equivalent of deliberately typing `rank`.
  //   3. `POST /api/rank` refuses without `{ confirm: true }`, so the dialog
  //      cannot be routed around.
  //
  // "Try again" after a failure reopens the DIALOG, never the run: a retry is
  // a second authorization, not a repeat of the first.

  const rankOpenBtn = document.getElementById("rank-open");
  const rankCoverageEl = document.getElementById("rank-coverage");
  const rankBlockerEl = document.getElementById("rank-blocker");
  const rankBlockerHeadlineEl = document.getElementById("rank-blocker-headline");
  const rankBlockerMoreEl = document.getElementById("rank-blocker-more");
  const rankBlockerDetailEl = document.getElementById("rank-blocker-detail");
  const rankModalEl = document.getElementById("rank-modal");
  const rankBackdropEl = document.getElementById("rank-backdrop");
  const rankCostTextEl = document.getElementById("rank-modal-cost-text");
  const rankErrorEl = document.getElementById("rank-modal-error");
  const rankCancelBtn = document.getElementById("rank-cancel");
  const rankConfirmBtn = document.getElementById("rank-confirm");
  const rankDotEl = document.getElementById("rank-dot");

  let rankPollTimer = null;
  /**
   * The card whose empty badge opened the confirmation, or null for a
   * whole-library run (issue #98). It is what makes the ONE dialog serve both
   * scopes - and it is cleared on every close, so a dialog reopened from
   * "Rank now" can never inherit a card's scope.
   */
  let rankOneTarget = null;
  const RANK_POLL_MS = 1500;

  // Inert defaults, like NO_CATEGORIZATION: a missing script must leave the
  // paid control OFF, never accidentally enabled.
  const NO_RANKING = {
    rankBlocker: () => "Ranking is unavailable in this viewer.",
    singleRankBlocker: () => "Ranking is unavailable in this viewer.",
    blockerHeadline: (m) => m,
    blockerDetail: () => "",
    canRank: () => false,
    isRunning: () => false,
    coverageLine: () => "",
    unrankedCount: () => 0,
    hasUnranked: () => false,
    confirmCost: () => "This is a paid run, billed per input token.",
    confirmLabel: () => "Rank bookmarks",
    confirmCostOne: () => "This is a paid run, billed per input token.",
    confirmLabelOne: () => "Rank this bookmark",
    progressSource: (sync) => (sync && sync.state && sync.state !== "idle" ? "sync" : null),
    progressLine: () => "",
  };

  function ranking() {
    return window.XBORanking || NO_RANKING;
  }

  function rankState() {
    return (setupState && setupState.ranking) || null;
  }

  function updateRankControl() {
    if (!rankOpenBtn) return;
    const state = rankState();
    const running = ranking().isRunning(state);
    const blocker = state ? ranking().rankBlocker(state) : "Ranking status is unavailable.";

    rankOpenBtn.classList.toggle("is-ranking", running);
    // The icon carries the run AND the backlog: a run outlives the popover
    // being open, and the dot (issue #98) is how a sync that stored new,
    // unranked bookmarks reaches an owner who is not looking at this panel.
    // The dot itself is decorative - the same fact is in the icon's title and
    // spelled out in full by the coverage line below.
    const unranked = ranking().unrankedCount(state);
    const showDot = !running && ranking().hasUnranked(state);
    const rankToggleBtn = document.getElementById("rank-toggle");
    if (rankDotEl) rankDotEl.hidden = !showDot;
    if (rankToggleBtn) {
      rankToggleBtn.classList.toggle("is-ranking", running);
      rankToggleBtn.classList.toggle("has-unranked", showDot);
      rankToggleBtn.title = running
        ? "Ranking in progress"
        : showDot
          ? `Ranking - ${unranked} bookmark${unranked === 1 ? "" : "s"} unranked`
          : "Ranking";
    }
    rankOpenBtn.disabled = running || blocker !== null;
    const label = rankOpenBtn.querySelector(".rank-btn-label");
    if (label) label.textContent = running ? "Ranking\u2026" : "Rank now";
    rankOpenBtn.setAttribute(
      "aria-label",
      running ? "Ranking your bookmarks" : "Rank bookmarks - a paid run you confirm first",
    );

    if (rankCoverageEl) {
      rankCoverageEl.textContent = state
        ? ranking().coverageLine(state)
        : "Ranking status is unavailable.";
    }
    // The reason lives in the panel, not only in a tooltip: a tooltip is a
    // dead end on touch, and this one is the owner's whole fix-it instruction.
    // The CAUSE is stated outright; the credential chain's list of places a
    // secret may live is a procedure, so it waits behind a disclosure rather
    // than burying the sentence it explains.
    if (rankBlockerEl) {
      const show = !running && !!blocker;
      rankBlockerEl.hidden = !show;
      const headline = show ? ranking().blockerHeadline(blocker) : "";
      const detail = show ? ranking().blockerDetail(blocker) : "";
      if (rankBlockerHeadlineEl) rankBlockerHeadlineEl.textContent = headline;
      if (rankBlockerMoreEl) rankBlockerMoreEl.hidden = !detail;
      if (rankBlockerDetailEl) rankBlockerDetailEl.textContent = detail;
    }
  }

  function isRankOpen() {
    return !!rankModalEl && !rankModalEl.hidden;
  }

  /**
   * Open the paid confirmation for a WHOLE-library run. Nothing is spent until
   * it is confirmed.
   */
  function openRankConfirm() {
    if (!rankModalEl) return;
    const state = rankState();
    if (state && ranking().rankBlocker(state) !== null) {
      updateRankControl();
      return;
    }
    rankOneTarget = null;
    showRankConfirm(ranking().confirmCost(state), ranking().confirmLabel(state));
  }

  /**
   * Open the same confirmation for ONE post (issue #98's empty score badge).
   *
   * Same dialog, same `{ confirm: true }` discipline, only a narrower scope -
   * a single bookmark is still a billed call, so it gets the whole gate rather
   * than a shortcut. When ranking is blocked outright (no wiring, ranking off,
   * or no key) there is nothing to confirm: the ranking panel is opened
   * instead, because that is where the blocker is stated in full.
   */
  function openRankOneConfirm(bm, card) {
    if (!rankModalEl) return;
    const state = rankState();
    if (ranking().singleRankBlocker(state) !== null) {
      const rankPopover = popovers.find((p) => p.name === "ranking");
      updateRankControl();
      if (rankPopover) setPopoverOpen(rankPopover, true);
      return;
    }
    rankOneTarget = { bm, card };
    showRankConfirm(ranking().confirmCostOne(state), ranking().confirmLabelOne(state));
  }

  /** The dialog itself, once the scope has decided what it says. */
  function showRankConfirm(costText, confirmText) {
    const rankPopover = popovers.find((p) => p.name === "ranking");
    if (rankPopover && isPopoverOpen(rankPopover)) setPopoverOpen(rankPopover, false, { returnFocus: false });

    if (rankCostTextEl) rankCostTextEl.textContent = costText;
    if (rankConfirmBtn) rankConfirmBtn.textContent = confirmText;
    rankErrorEl.hidden = true;
    rankModalEl.hidden = false;
    rankBackdropEl.hidden = false;
    // Cancel first: the button that spends money is never the default target.
    rankCancelBtn.focus();
  }

  function closeRankConfirm(focusTarget) {
    if (!rankModalEl) return;
    const target = rankOneTarget;
    rankOneTarget = null;
    rankModalEl.hidden = true;
    rankBackdropEl.hidden = true;
    // A one-post confirmation was opened FROM the card, so that is where focus
    // belongs - but only while the badge is still on screen.
    if (!focusTarget && target && target.card && target.card.isConnected && !target.card.hidden) {
      const chip = target.card.querySelector(".score-chip");
      if (chip) {
        chip.focus();
        return;
      }
    }
    // Focus goes back to a trigger the owner can actually see. "Rank now"
    // lives INSIDE the ranking popover, which opening the dialog closed, so it
    // is usually not focusable by the time we get here - focusing it then
    // would silently drop focus to <body> and strand a keyboard user. The
    // popover's own toggle is the visible thing that stands for it.
    const visible = (elm) => !!elm && !elm.disabled && elm.offsetParent !== null;
    const fallback =
      focusTarget || (visible(rankOpenBtn) ? rankOpenBtn : document.getElementById("rank-toggle"));
    if (fallback) fallback.focus();
  }

  /**
   * The authorization itself: the ONE place the viewer sends `confirm: true`,
   * for either scope. A whole-library run is started and polled; a single post
   * is one call, so it is awaited - but both report into the shared strip, and
   * both carry the server's `reportRankerBilling` line in that report.
   */
  async function confirmRank() {
    const target = rankOneTarget;
    rankConfirmBtn.disabled = true;
    rankConfirmBtn.classList.add("is-loading");
    rankErrorEl.hidden = true;
    const url = target ? `/api/bookmarks/${target.bm.id}/rank` : "/api/rank";
    let body = null;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || "Could not start the ranking run.");
      }
    } catch (err) {
      rankErrorEl.textContent = err.message;
      rankErrorEl.hidden = false;
      return;
    } finally {
      rankConfirmBtn.disabled = false;
      rankConfirmBtn.classList.remove("is-loading");
    }
    closeRankConfirm();
    if (target) {
      applyRankedOne(target, body);
      return;
    }
    renderRankProgress({
      state: "running",
      startedAt: new Date().toISOString(),
      messages: ["Starting the ranking run\u2026"],
    });
    pollRank();
  }

  /**
   * Settle a finished one-post run (issue #98).
   *
   * The card's chip is patched IN PLACE - `patchScoreChip`, the same swap a
   * whole run's re-page uses - so the post's mounted X embeds are never
   * detached and reloaded. The run's own log lines (the billing line first)
   * go into the shared strip exactly as a full run's do, so a paid call is
   * never silent even at this size.
   */
  function applyRankedOne(target, body) {
    const data = body || {};
    target.bm.score = data.score || null;
    patchScoreChip(target.bm, target.card);
    if (data.ranking) {
      if (setupState) setupState.ranking = data.ranking;
      applySetupState();
    }
    renderRankProgress({
      state: "done",
      startedAt: new Date().toISOString(),
      messages: data.messages || [],
      summary: data.summary || null,
    });
  }

  function pollRank() {
    if (rankPollTimer) return;
    const tick = async () => {
      let data;
      try {
        data = await getJSON("/api/rank");
      } catch (_) {
        return; // transient; the next tick tries again
      }
      if (setupState && data.ranking) setupState.ranking = data.ranking;
      const status = data.ranking && data.ranking.status;
      renderRankProgress(status);
      updateRankControl();
      updateSortAvailability();

      if (status && (status.state === "done" || status.state === "error")) {
        stopRankPolling();
        if (status.state === "done") await refreshAfterRank();
      }
    };
    rankPollTimer = setInterval(tick, RANK_POLL_MS);
    void tick();
  }

  function stopRankPolling() {
    if (!rankPollTimer) return;
    clearInterval(rankPollTimer);
    rankPollTimer = null;
  }

  /**
   * Bring the viewer up to date with what a run stored. A ranking run touches
   * only scores - no bookmark, category or count - so the tree is left alone;
   * but every cached view was paged under the OLD scores, so they are dropped
   * exactly as changing the Order does, and the open category re-pages. That
   * is what makes "Top score" and the new chips correct without a reload.
   */
  async function refreshAfterRank() {
    clearPersistedViews();
    viewCaches = new Map();
    cacheOrder = [];
    // The pool is kept, exactly as a sort change keeps it: the re-paged rows
    // carry the new scores, and `poolPost` folds them into the cards already
    // on screen rather than rebuilding (and reloading) them. `sameCategory`
    // keeps this a CONTENT-only refresh (issue #97) - the tab bar and its
    // badges are left alone.
    await fetchSetup();
    if (selectedCategoryId != null) await fetchAndRenderFirstPage({ sameCategory: true });
  }

  function initRanking() {
    if (!rankOpenBtn || !rankModalEl) return;
    rankOpenBtn.addEventListener("click", openRankConfirm);
    rankCancelBtn.addEventListener("click", () => closeRankConfirm());
    rankBackdropEl.addEventListener("click", () => closeRankConfirm());
    rankConfirmBtn.addEventListener("click", () => void confirmRank());
    // The run's progress (and its "Try again", which is a fresh authorization
    // rather than a silent re-run) lives in the shared strip - see `initSync`.
    document.addEventListener("keydown", (e) => {
      if (!isRankOpen()) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        closeRankConfirm();
        return;
      }
      trapModalFocus(rankModalEl, e);
    });
  }

  // ---- the categorization selector (fixowl-style dropdowns) --------------
  // One builder, two mounts: the first-run flow and the Settings panel. Both
  // render from the server's catalog, so a provider added later (issue #70)
  // appears in both with no change here.

  function buildField(idPrefix, name, labelText) {
    const field = el("div", "field");
    const select = document.createElement("select");
    select.className = "field-select";
    select.id = `${idPrefix}-${name}`;
    select.name = name;
    const label = el("label", "field-label", labelText);
    label.htmlFor = select.id;
    const hint = el("p", "field-hint");
    hint.id = `${select.id}-hint`;
    select.setAttribute("aria-describedby", hint.id);
    // The select keeps being a NATIVE select - it is styled, not replaced, so
    // the platform's own keyboard, type-ahead, screen-reader and (on a phone)
    // picker behaviour all survive. The shell exists only to hang the app's
    // chevron beside it, since `appearance: none` takes the browser's away.
    const shell = el("div", "select-shell");
    shell.append(select);
    field.append(label, shell, hint);
    return { field, select, hint };
  }

  function fillOptions(select, options, value) {
    select.replaceChildren(
      ...options.map((opt) => {
        const node = document.createElement("option");
        node.value = opt.value;
        node.textContent = opt.label;
        return node;
      }),
    );
    select.value = options.some((o) => o.value === value) ? value : "";
  }

  function hintFor(options, value) {
    const match = options.find((o) => o.value === value);
    return match && match.hint ? match.hint : "";
  }

  /**
   * The selector's source <select> (pi's upstreams), grouped the way the
   * catalog groups them so "one key, many models" gateways read as such.
   */
  const SOURCE_GROUPS = [
    { kind: "direct", label: "Model makers" },
    { kind: "gateway", label: "Gateways - one key, many models" },
    { kind: "local", label: "Your own server" },
  ];

  function fillSourceOptions(select, sources, value) {
    const groups = SOURCE_GROUPS.map((g) => {
      const members = sources.filter((src) => src.kind === g.kind);
      if (members.length === 0) return null;
      const group = document.createElement("optgroup");
      group.label = g.label;
      for (const src of members) {
        const node = document.createElement("option");
        node.value = src.id;
        node.textContent = src.label;
        group.append(node);
      }
      return group;
    }).filter(Boolean);
    select.replaceChildren(...groups);
    select.value = sources.some((src) => src.id === value) ? value : sources[0] ? sources[0].id : "";
  }

  // One cache for the whole page: a source's catalog is data bundled with the
  // server's SDK, so it cannot change under a running viewer. A failed read is
  // dropped so Retry really retries.
  const modelListCache = new Map();

  function loadModelList(providerId, sourceId) {
    const key = `${providerId}\u0000${sourceId}`;
    let pending = modelListCache.get(key);
    if (!pending) {
      const qs = new URLSearchParams({ provider: providerId, source: sourceId });
      pending = getJSON(`/api/models?${qs}`).then((body) => body.models || []);
      pending.catch(() => modelListCache.delete(key));
      modelListCache.set(key, pending);
    }
    return pending;
  }

  /**
   * A searchable model picker: an ARIA combobox over one source's full
   * catalog, which can run to hundreds of models (OpenRouter), so a native
   * <select> is no longer enough. The listbox opens IN FLOW under the input
   * rather than floating: the picker lives inside scrolling panels and a
   * dialog, and an absolutely positioned popup would be clipped by them.
   *
   * Keyboard: typing filters; ArrowDown/ArrowUp open the list and move
   * through it; Enter picks; Escape closes it (restoring the current choice)
   * without closing the panel around it; Tab leaves with the choice intact.
   */
  function buildModelPicker(idPrefix, name, labelText, onPick) {
    const field = el("div", "field model-picker");
    const inputId = `${idPrefix}-${name}`;
    const listId = `${inputId}-list`;
    const label = el("label", "field-label", labelText);
    label.htmlFor = inputId;
    const input = document.createElement("input");
    input.type = "text";
    input.id = inputId;
    input.className = "field-input model-picker-input";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-expanded", "false");
    input.setAttribute("aria-controls", listId);
    const shell = el("div", "select-shell model-picker-shell");
    shell.append(input);
    const list = el("ul", "model-picker-list");
    list.id = listId;
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", labelText);
    list.hidden = true;
    const statusRow = el("div", "model-picker-status");
    const statusText = el("span", "model-picker-status-text");
    statusText.id = `${inputId}-status`;
    statusText.setAttribute("role", "status");
    const retry = el("button", "btn btn-secondary model-picker-retry", "Retry");
    retry.type = "button";
    retry.hidden = true;
    statusRow.append(statusText, retry);
    const hint = el("p", "field-hint");
    hint.id = `${inputId}-hint`;
    input.setAttribute("aria-describedby", `${statusText.id} ${hint.id}`);
    field.append(label, shell, list, statusRow, hint);

    const state = {
      provider: null,
      sourceId: "",
      sourceLabel: "",
      pass: "taxonomy",
      models: [],
      load: "idle", // idle | loading | ready | error
      error: "",
      value: "",
      query: "",
      open: false,
      entries: [],
      active: -1,
      token: 0,
    };

    function selectedLabel() {
      if (state.load !== "ready" && state.value) return state.value;
      const all = categorization().pickerEntries(state.provider, state.sourceId, state.models, state.pass, "");
      const match = all.find((e) => e.value === state.value);
      if (match) return match.label;
      return state.value;
    }

    function hasValue() {
      if (state.value) return true;
      // "" is a real choice only where "Recommended" is on offer.
      return categorization()
        .pickerEntries(state.provider, state.sourceId, state.models, state.pass, "")
        .some((e) => e.value === "");
    }

    function renderStatus() {
      retry.hidden = state.load !== "error";
      statusRow.dataset.state = state.load;
      if (state.load === "loading") {
        statusText.textContent = `Loading ${state.sourceLabel} models…`;
      } else if (state.load === "error") {
        statusText.textContent = `Couldn't load the ${state.sourceLabel} model list: ${state.error}`;
      } else if (state.load === "ready") {
        const count = state.models.length;
        if (state.open && state.query && state.entries.length === 0) {
          statusText.textContent = `No ${state.sourceLabel} model matches "${state.query.trim()}".`;
        } else if (state.open && state.query) {
          statusText.textContent = `${state.entries.length} of ${count} models match.`;
        } else {
          statusText.textContent = `${count} ${state.sourceLabel} ${count === 1 ? "model" : "models"}, prices per 1M tokens - type to search.`;
        }
      } else {
        statusText.textContent = "";
      }
    }

    function renderList() {
      state.entries =
        state.load === "ready"
          ? categorization().pickerEntries(state.provider, state.sourceId, state.models, state.pass, state.query)
          : [];
      if (state.active >= state.entries.length) state.active = state.entries.length - 1;
      list.replaceChildren(
        ...state.entries.map((entry, i) => {
          const option = el("li", "model-picker-option");
          option.id = `${inputId}-opt-${i}`;
          option.setAttribute("role", "option");
          const selected = entry.value === state.value;
          option.setAttribute("aria-selected", selected ? "true" : "false");
          if (i === state.active) option.classList.add("is-active");
          const top = el("span", "model-picker-option-top");
          top.append(el("span", "model-picker-option-label", entry.label));
          if (entry.badge) top.append(el("span", "model-picker-badge", entry.badge));
          option.append(top);
          if (entry.meta) option.append(el("span", "model-picker-option-meta", entry.meta));
          if (entry.id && entry.id !== entry.label) {
            option.append(el("span", "model-picker-option-id", entry.id));
          }
          option.addEventListener("pointerdown", (e) => e.preventDefault());
          option.addEventListener("click", () => choose(i));
          return option;
        }),
      );
      const showList = state.open && state.entries.length > 0;
      list.hidden = !showList;
      input.setAttribute("aria-expanded", showList ? "true" : "false");
      if (showList && state.active >= 0) {
        input.setAttribute("aria-activedescendant", `${inputId}-opt-${state.active}`);
        const node = list.children[state.active];
        if (node) node.scrollIntoView({ block: "nearest" });
      } else {
        input.removeAttribute("aria-activedescendant");
      }
      renderStatus();
    }

    function syncInput() {
      input.value = selectedLabel();
      input.placeholder = hasValue() ? "" : `Type to search ${state.sourceLabel} models`;
    }

    function openList() {
      if (state.open || state.load !== "ready") return;
      state.open = true;
      state.query = "";
      state.active = Math.max(
        0,
        categorization()
          .pickerEntries(state.provider, state.sourceId, state.models, state.pass, "")
          .findIndex((e) => e.value === state.value),
      );
      renderList();
    }

    function closeList(restore) {
      state.open = false;
      state.query = "";
      state.active = -1;
      renderList();
      if (restore) syncInput();
    }

    function choose(i) {
      const entry = state.entries[i];
      if (!entry) return;
      state.value = entry.value;
      closeList(true);
      renderHint();
      if (onPick) onPick();
    }

    function renderHint() {
      const match = categorization()
        .pickerEntries(state.provider, state.sourceId, state.models, state.pass, "")
        .find((e) => e.value === state.value);
      hint.textContent = match ? match.hint || match.meta || "" : "";
      hint.classList.toggle("field-billing", !!match && match.value !== "");
    }

    async function load() {
      const token = ++state.token;
      if (!state.provider || !state.sourceId) return;
      state.load = "loading";
      state.models = [];
      closeList(true);
      try {
        const models = await loadModelList(state.provider.id, state.sourceId);
        if (token !== state.token) return;
        state.models = models;
        state.load = "ready";
      } catch (err) {
        if (token !== state.token) return;
        state.load = "error";
        state.error = (err.body && err.body.error) || err.message || "request failed";
      }
      renderList();
      syncInput();
      renderHint();
    }

    function move(delta) {
      if (!state.open) {
        openList();
        return;
      }
      const n = state.entries.length;
      if (n === 0) return;
      state.active = state.active < 0 ? (delta > 0 ? 0 : n - 1) : Math.min(n - 1, Math.max(0, state.active + delta));
      renderList();
    }

    input.addEventListener("focus", () => input.select());
    input.addEventListener("click", () => (state.open ? closeList(true) : openList()));
    input.addEventListener("input", () => {
      if (state.load !== "ready") return;
      state.open = true;
      state.query = input.value;
      state.active = 0;
      renderList();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        move(e.altKey && !state.open ? 0 : 1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        move(-1);
      } else if (e.key === "PageDown" && state.open) {
        e.preventDefault();
        move(10);
      } else if (e.key === "PageUp" && state.open) {
        e.preventDefault();
        move(-10);
      } else if (e.key === "Enter") {
        if (state.open && state.active >= 0) {
          e.preventDefault();
          choose(state.active);
        }
      } else if (e.key === "Escape") {
        // Close the list (or undo a half-typed query) without also closing
        // the settings popover / setup dialog the picker sits in.
        if (state.open || input.value !== selectedLabel()) {
          e.preventDefault();
          e.stopPropagation();
          closeList(true);
        }
      } else if (e.key === "Tab") {
        if (state.open) closeList(true);
      }
    });
    input.addEventListener("blur", () => {
      if (state.open || input.value !== selectedLabel()) closeList(true);
    });
    retry.addEventListener("click", () => {
      void load();
      input.focus();
    });

    return {
      field,
      input,
      hint,
      /** Point the picker at one source of a provider; loads its catalog when it changed. */
      setSource(provider, sourceId, pass, value) {
        const source = categorization().findSource(provider, sourceId);
        const changed = !state.provider || state.provider.id !== provider.id || state.sourceId !== sourceId;
        state.provider = provider;
        state.pass = pass;
        state.sourceId = sourceId;
        state.sourceLabel = source ? source.label : sourceId;
        state.value = value || "";
        if (changed || state.load === "error" || state.load === "idle") void load();
        else {
          renderList();
          syncInput();
          renderHint();
        }
      },
      getValue() {
        return state.value;
      },
    };
  }

  function buildPhase(idPrefix, name, title, helper, fields) {
    const section = el("section", "phase");
    section.setAttribute("role", "group");
    const heading = el("h4", "phase-title", title);
    heading.id = `${idPrefix}-${name}-title`;
    section.setAttribute("aria-labelledby", heading.id);
    section.append(heading, el("p", "phase-helper", helper), ...fields);
    return section;
  }

  /**
   * A provider / model / effort selector over the server's catalog, one
   * provider per pass (issue #70): the tree can be designed on one provider
   * and the bookmarks filed on another. Returns the mounted root plus the
   * small API `app.js` drives it with.
   */
  function createCategorizationForm(container, idPrefix, onChange) {
    const method = buildField(idPrefix, "categorizer", "Method");
    const taxonomyProvider = buildField(idPrefix, "taxonomyProvider", "Taxonomy provider");
    const taxonomy = buildField(idPrefix, "taxonomyModel", "Taxonomy model");
    const effort = buildField(idPrefix, "effort", "Reasoning effort");
    const assignmentProvider = buildField(idPrefix, "assignmentProvider", "Filing provider");
    const assignment = buildField(idPrefix, "assignmentModel", "Filing model");

    /**
     * The fields a provider with a full catalog (pi) swaps in for the model
     * select: which of its sources (upstreams) to use, then a searchable
     * picker over that source's models - or, for a local server, a typed
     * model name.
     */
    function catalogFields(pass, noun) {
      const source = buildField(idPrefix, `${pass}Source`, `${noun} API provider`);
      const picker = buildModelPicker(idPrefix, `${pass}ModelSearch`, `${noun} model`, () => {
        renderHints();
        if (onChange) onChange();
      });
      const local = el("div", "field");
      const localInput = document.createElement("input");
      localInput.type = "text";
      localInput.className = "field-input";
      localInput.id = `${idPrefix}-${pass}LocalModel`;
      localInput.autocomplete = "off";
      localInput.spellcheck = false;
      const localLabel = el("label", "field-label", `${noun} model name on your server`);
      localLabel.htmlFor = localInput.id;
      const localHint = el("p", "field-hint", "Exactly as your server lists it, e.g. llama3.1:8b.");
      localHint.id = `${localInput.id}-hint`;
      localInput.setAttribute("aria-describedby", localHint.id);
      local.append(localLabel, localInput, localHint);
      return { source, picker, local: { field: local, input: localInput } };
    }
    const taxonomyCatalog = catalogFields("taxonomy", "Taxonomy");
    const assignmentCatalog = catalogFields("assignment", "Filing");

    // Two phases, in the order the app runs them: design the tree, then file
    // each bookmark into it.
    const phase1 = buildPhase(
      idPrefix,
      "phase1",
      "Phase 1 - Taxonomy",
      "Designs the category tree from all your bookmarks at once. This pass always runs on a language model.",
      [
        taxonomyProvider.field,
        taxonomyCatalog.source.field,
        taxonomy.field,
        taxonomyCatalog.picker.field,
        taxonomyCatalog.local.field,
        effort.field,
      ],
    );
    const phase2 = buildPhase(
      idPrefix,
      "phase2",
      "Phase 2 - Categorization method",
      "Files each bookmark into a category of that tree - with a language model, or with Jev.",
      [
        method.field,
        assignmentProvider.field,
        assignmentCatalog.source.field,
        assignment.field,
        assignmentCatalog.picker.field,
        assignmentCatalog.local.field,
      ],
    );
    container.replaceChildren(phase1, phase2);

    let catalog = null;

    /** Each pass's fields: its provider select, the model select it drives, and the catalog trio. */
    const passes = {
      taxonomy: { provider: taxonomyProvider, model: taxonomy, ...taxonomyCatalog },
      assignment: { provider: assignmentProvider, model: assignment, ...assignmentCatalog },
    };

    function providerOf(pass) {
      return categorization().findProvider(catalog, passes[pass].provider.select.value);
    }

    function usesCatalog(pass) {
      return categorization().sourcesOf(providerOf(pass)).length > 0;
    }

    function chosenSource(pass) {
      return categorization().findSource(providerOf(pass), passes[pass].source.select.value);
    }

    /** Point a catalog pass at its chosen source, keeping `modelValue` only if it belongs there. */
    function applySource(pass, modelValue) {
      const P = passes[pass];
      const p = providerOf(pass);
      const src = chosenSource(pass);
      if (!src) return;
      const own = categorization().sourceOfModel(p, modelValue);
      const belongs = !!own && own.id === src.id;
      if (src.freeform) {
        P.local.input.value = belongs ? modelValue.slice(src.id.length + 1) : "";
      } else {
        P.picker.setSource(p, src.id, pass, belongs ? modelValue : "");
      }
    }

    /** Which of a pass's model controls are on screen, for its provider and source. */
    function showPassFields(pass, visible) {
      const P = passes[pass];
      const catalogPass = usesCatalog(pass);
      const src = catalogPass ? chosenSource(pass) : null;
      P.model.field.hidden = !visible || catalogPass;
      P.source.field.hidden = !visible || !catalogPass;
      P.picker.field.hidden = !visible || !catalogPass || !!(src && src.freeform);
      P.local.field.hidden = !visible || !catalogPass || !(src && src.freeform);
    }

    /** Refill one pass's model list (and, for pass 1, the effort list) for its provider. */
    function renderPass(pass, values) {
      const P = passes[pass];
      const p = providerOf(pass);
      const modelValue = (values && values[pass + "Model"]) || "";
      const sources = categorization().sourcesOf(p);
      if (sources.length > 0) {
        const sourceId = (values && values[pass + "Source"]) || categorization().passSource(p, pass, modelValue);
        fillSourceOptions(P.source.select, sources, sourceId);
        applySource(pass, modelValue);
      } else {
        fillOptions(P.model.select, categorization().modelOptions(p, pass), modelValue);
      }
      if (pass === "taxonomy") {
        const effortOptions = categorization().effortOptions(p);
        fillOptions(effort.select, effortOptions, (values && values.effort) || "");
        effort.field.hidden = effortOptions.length <= 1;
      }
    }

    function renderModelFields(values) {
      renderPass("taxonomy", values);
      renderPass("assignment", values);
      renderHints();
    }

    function modelValueOf(pass) {
      const P = passes[pass];
      if (!usesCatalog(pass)) return P.model.select.value;
      const src = chosenSource(pass);
      if (src && src.freeform) {
        const name = P.local.input.value.trim();
        return name ? `${src.id}/${name}` : "";
      }
      return P.picker.getValue();
    }

    /**
     * The label is already in each select; the hint says what the owner cannot
     * see there - how a provider bills, and what a model costs and needs. A
     * per-token choice wears the same billing emphasis as the paid method.
     */
    function renderHints() {
      const chosenMethod = categorization().findMethod(catalog, method.select.value);
      method.hint.textContent = chosenMethod ? chosenMethod.description : "";
      method.hint.classList.toggle("field-billing", !!chosenMethod && chosenMethod.billing === "per-token");
      const providerKeys = (setupState && setupState.credentials && setupState.credentials.providerKeys) || {};
      for (const pass of ["taxonomy", "assignment"]) {
        const p = providerOf(pass);
        const paid = !!p && p.billing === "per-token";
        const { provider, model, source } = passes[pass];
        const notice = categorization().providerNotice(p);
        provider.hint.textContent = notice.text;
        provider.hint.classList.toggle("field-billing", notice.emphasis);
        model.hint.textContent = hintFor(categorization().modelOptions(p, pass), model.select.value);
        model.hint.classList.toggle("field-billing", paid && model.select.value !== "");
        const keyNotice = categorization().sourceNotice(usesCatalog(pass) ? chosenSource(pass) : null, providerKeys);
        source.hint.textContent = keyNotice.text;
        source.hint.dataset.key = keyNotice.state;
        source.hint.classList.toggle("field-billing", keyNotice.state !== "none" || paid);
      }
      effort.hint.textContent = hintFor(categorization().effortOptions(providerOf("taxonomy")), effort.select.value);
      // Jev files bookmarks without a prompt, so it has no filing provider or
      // model; the taxonomy pass is always a model, so Phase 1 never goes away.
      const fields = categorization().fieldsFor(method.select.value);
      assignmentProvider.field.hidden = !fields.assignmentProvider;
      showPassFields("taxonomy", true);
      showPassFields("assignment", fields.assignmentModel);
    }

    const notify = () => {
      renderHints();
      if (onChange) onChange();
    };
    method.select.addEventListener("change", notify);
    for (const pass of ["taxonomy", "assignment"]) {
      passes[pass].provider.select.addEventListener("change", () => {
        // A model id only means something to the provider it came from.
        renderPass(pass, null);
        renderHints();
        if (onChange) onChange();
      });
      passes[pass].source.select.addEventListener("change", () => {
        // ...and to the source it came from: a new source starts on its own
        // Recommended pick if it hosts one, else on no choice at all.
        applySource(pass, "");
        renderHints();
        if (onChange) onChange();
      });
      passes[pass].local.input.addEventListener("input", notify);
    }
    for (const f of [taxonomy, assignment, effort]) f.select.addEventListener("change", notify);

    const api = {
      setCatalog(next) {
        // A catalog refresh (every /api/setup poll) must not throw away a
        // choice the owner is in the middle of making.
        const current = catalog ? api.getValues() : null;
        catalog = next;
        fillOptions(
          method.select,
          (next.methods || []).map((m) => ({ value: m.id, label: m.label, hint: m.description })),
          method.select.value,
        );
        const providerOptions = (next.providers || []).map((p) => ({
          value: p.id,
          label: p.label,
          hint: categorization().providerNotice(p).text,
        }));
        for (const pass of ["taxonomy", "assignment"]) {
          const select = passes[pass].provider.select;
          fillOptions(select, providerOptions, select.value);
          // `fillOptions` falls back to "" for an unknown value; a provider
          // select has no empty option, so land on the first (the default).
          if (!select.value && providerOptions[0]) select.value = providerOptions[0].value;
        }
        renderModelFields(current);
      },
      setValues(values) {
        if (!values) return;
        method.select.value = values.categorizer || "";
        for (const pass of ["taxonomy", "assignment"]) {
          const select = passes[pass].provider.select;
          select.value = categorization().passProvider(values, pass);
          if (!select.value && select.options[0]) select.value = select.options[0].value;
        }
        renderModelFields(values);
      },
      getValues() {
        const values = {
          categorizer: method.select.value,
          taxonomyProvider: taxonomyProvider.select.value,
          taxonomyModel: modelValueOf("taxonomy"),
          assignmentProvider: assignmentProvider.select.value,
          assignmentModel: modelValueOf("assignment"),
          effort: effort.select.value,
        };
        for (const pass of ["taxonomy", "assignment"]) {
          if (usesCatalog(pass)) values[pass + "Source"] = passes[pass].source.select.value;
        }
        return values;
      },
    };
    return api;
  }

  /** Show why the currently selected method cannot run, or hide the note. */
  function updateFormNote(form, noteEl) {
    if (!form || !noteEl || !setupState) return;
    const values = form.getValues();
    const credentials = setupState.credentials || {};
    const blocker = categorization().methodBlocker(setupState.catalog, values.categorizer, credentials);
    const lines = [blocker]
      .concat(categorization().passProblems(values, setupState.catalog, credentials.providerKeys).map((p) => p.text))
      .filter(Boolean);
    noteEl.textContent = lines.join(" ");
    noteEl.hidden = lines.length === 0;
  }

  async function saveCategorization(form) {
    const values = form.getValues();
    const unsaveable = categorization()
      .passProblems(values, setupState && setupState.catalog, {})
      .filter((p) => p.blocksSave);
    if (unsaveable.length > 0) throw new Error(unsaveable.map((p) => p.text).join(" "));
    const payload = categorization().toPayload(values);
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || "Could not save these settings.");
    if (setupState) {
      setupState.settings = body.settings;
      setupState.configured = true;
    }
    return body.settings;
  }

  // ---- Settings panel: the categorization group --------------------------

  const settingsFormEl = document.getElementById("settings-categorization");
  const settingsNoteEl = document.getElementById("settings-categorization-note");
  const settingsSaveBtn = document.getElementById("settings-save");
  const settingsSaveStatusEl = document.getElementById("settings-save-status");
  let settingsForm = null;
  // True between an edit and its save: a background poll must not overwrite
  // a choice the owner is still making.
  let settingsDirty = false;

  function setSaveStatus(message, state) {
    if (!settingsSaveStatusEl) return;
    settingsSaveStatusEl.textContent = message;
    if (state) settingsSaveStatusEl.setAttribute("data-state", state);
    else settingsSaveStatusEl.removeAttribute("data-state");
  }

  function initCategorizationSettings() {
    if (!settingsFormEl || !window.XBOCategorization) return;
    settingsForm = createCategorizationForm(settingsFormEl, "settings", () => {
      settingsDirty = true;
      setSaveStatus("");
      updateFormNote(settingsForm, settingsNoteEl);
    });
    if (!settingsSaveBtn) return;
    settingsSaveBtn.addEventListener("click", async () => {
      settingsSaveBtn.classList.add("is-loading");
      settingsSaveBtn.disabled = true;
      setSaveStatus("");
      try {
        await saveCategorization(settingsForm);
        settingsDirty = false;
        setSaveStatus("Saved. The next sync uses it.");
        updateSyncButton();
      } catch (err) {
        setSaveStatus(err.message, "error");
      } finally {
        settingsSaveBtn.classList.remove("is-loading");
        settingsSaveBtn.disabled = false;
      }
    });
  }

  // ---- first-run setup ---------------------------------------------------

  const setupBackdropEl = document.getElementById("setup-backdrop");
  const setupModalEl = document.getElementById("setup-modal");
  const setupCloseBtn = document.getElementById("setup-close");
  const setupStepsEl = document.getElementById("setup-steps");
  const setupStepHintEl = document.getElementById("setup-step-hint");
  const setupXStateEl = document.getElementById("setup-x-state");
  const setupXErrorEl = document.getElementById("setup-x-error");
  const setupFormEl = document.getElementById("setup-categorization");
  const setupNoteEl = document.getElementById("setup-categorization-note");
  const setupSummaryEl = document.getElementById("setup-summary");
  const setupSyncStateEl = document.getElementById("setup-sync-state");
  const setupBlockersEl = document.getElementById("setup-blockers");
  const setupBackBtn = document.getElementById("setup-back");
  const setupNextBtn = document.getElementById("setup-next");
  let setupForm = null;
  let setupStep = 1;
  let setupReturnFocusEl = null;
  let setupPollTimer = null;

  const SETUP_STEP_HINTS = {
    1: "Step 1 of 3 - authorize this app to read your bookmarks.",
    2: "Step 2 of 3 - pick how new bookmarks are sorted.",
    3: "Step 3 of 3 - fetch and categorize your bookmarks.",
  };

  function isSetupOpen() {
    return !!setupModalEl && !setupModalEl.hidden;
  }

  function openSetup(step) {
    if (!setupModalEl) return;
    // On first load nothing is focused, and `document.body` is not somewhere
    // focus can usefully return to - the fallback below handles that case.
    const active = document.activeElement;
    setupReturnFocusEl = active && active !== document.body ? active : null;
    setupModalEl.hidden = false;
    setupBackdropEl.hidden = false;
    setupStep = step || (setupState && setupState.x && setupState.x.connected ? 2 : 1);
    if (setupForm && setupState) {
      setupForm.setCatalog(setupState.catalog);
      setupForm.setValues(setupState.settings);
    }
    renderSetupStep();
    setupNextBtn.focus();
    startSetupPolling();
  }

  function closeSetup() {
    if (!isSetupOpen()) return;
    setupModalEl.hidden = true;
    setupBackdropEl.hidden = true;
    stopSetupPolling();
    // Re-render the pane BEFORE restoring focus: closing an empty library
    // replaces the content with its own call to action, which would destroy
    // the element focus was about to return to and drop focus onto <body>.
    updateEmptyLibraryState();
    const fallback = listRoot.querySelector(".state-welcome .btn") || syncBtn;
    const target =
      setupReturnFocusEl && document.contains(setupReturnFocusEl) ? setupReturnFocusEl : fallback;
    if (target) target.focus();
  }

  /**
   * While the flow is open, the X authorization it started completes in
   * ANOTHER tab - nothing in this one would otherwise tell us. Polling is how
   * step 1 notices, and it stops as soon as the flow closes.
   */
  function startSetupPolling() {
    if (setupPollTimer) return;
    setupPollTimer = setInterval(() => void fetchSetup(), 2000);
  }

  function stopSetupPolling() {
    if (!setupPollTimer) return;
    clearInterval(setupPollTimer);
    setupPollTimer = null;
  }

  /** The first sync has succeeded - the flow's only real exit condition. */
  function setupFinished() {
    const status = setupState && setupState.sync ? setupState.sync.status : null;
    return !!status && status.state === "done";
  }

  function renderSetupStep() {
    if (!setupModalEl) return;
    for (const item of setupStepsEl.querySelectorAll(".setup-step")) {
      const step = Number(item.getAttribute("data-step"));
      if (step === setupStep) item.setAttribute("aria-current", "step");
      else item.removeAttribute("aria-current");
      item.setAttribute("data-done", String(step < setupStep));
    }
    setupStepHintEl.textContent = SETUP_STEP_HINTS[setupStep] || "";
    for (const step of [1, 2, 3]) {
      document.getElementById(`setup-pane-${step}`).hidden = step !== setupStep;
    }

    if (setupStep === 1) renderSetupConnect();
    if (setupStep === 3) renderSetupSync();
    if (setupStep === 2) updateFormNote(setupForm, setupNoteEl);

    setupBackBtn.disabled = setupStep === 1 || setupFinished();
    const running = syncIsRunning();
    // Disabled with a label that says what is happening, rather than the
    // `is-loading` spinner - which hides the text, and this run is minutes
    // long with its own progress right below the button.
    setupNextBtn.textContent =
      setupStep !== 3
        ? "Continue"
        : setupFinished()
          ? "Browse my bookmarks"
          : running
            ? "Syncing…"
            : "Start first sync";
    setupNextBtn.disabled = setupStep === 3 && running;
  }

  /** Step 1: the X credentials and the one-time consent. */
  function renderSetupConnect() {
    const creds = (setupState && setupState.credentials) || {};
    const x = (setupState && setupState.x) || {};
    const haveCreds =
      creds.xClientId && creds.xClientId.present && creds.xClientSecret && creds.xClientSecret.present;

    const badge = el("span", "setup-status-badge");
    const text = el("p", "setup-status-text");
    const children = [badge, text];

    if (!haveCreds) {
      badge.setAttribute("data-state", "todo");
      badge.textContent = "Not ready";
      text.textContent = categorization().syncBlockers(setupState || {})[0] || "";
    } else if (x.connected) {
      badge.setAttribute("data-state", "ok");
      badge.textContent = "Connected";
      text.textContent = "This app can read your bookmarks. Nothing else to do here.";
    } else {
      badge.setAttribute("data-state", "todo");
      badge.textContent = "Not connected";
      const running = x.login && x.login.state === "running";
      text.textContent = running
        ? "Waiting for you to approve the request on X, in the tab that just opened…"
        : "Authorize this app once. X opens a consent page in your browser.";
      if (x.canConnect) {
        const btn = el("button", "btn btn-primary setup-status-btn", running ? "Waiting…" : "Connect X");
        btn.type = "button";
        btn.disabled = running;
        btn.classList.toggle("is-loading", !!running);
        btn.addEventListener("click", connectX);
        children.push(btn);
      } else {
        text.textContent += " Run `node dist/index.js login` once instead.";
      }
    }
    setupXStateEl.replaceChildren(...children);

    const loginError = x.login && x.login.state === "error" ? x.login.error : "";
    setupXErrorEl.textContent = loginError || "";
    setupXErrorEl.hidden = !loginError;
  }

  async function connectX() {
    try {
      const res = await fetch("/api/x-login", { method: "POST" });
      if (!res.ok && res.status !== 409) {
        const body = await res.json().catch(() => ({}));
        setupXErrorEl.textContent = body.error || "Could not start the X authorization.";
        setupXErrorEl.hidden = false;
        return;
      }
    } catch (_) {
      setupXErrorEl.textContent = "Could not reach the server.";
      setupXErrorEl.hidden = false;
      return;
    }
    await fetchSetup();
  }

  /** Step 3: what was chosen, what is missing, and how the run is going. */
  function renderSetupSync() {
    const settings = (setupState && setupState.settings) || {};
    const catalog = (setupState && setupState.catalog) || {};
    const method = categorization().findMethod(catalog, settings.categorizer);
    /** "Provider label - model label", as the dropdowns showed them (never raw ids). */
    const passLine = (pass) => {
      const provider = categorization().findProvider(catalog, categorization().passProvider(settings, pass));
      if (!provider) return "-";
      const id = settings[pass + "Model"] || (provider.suggested || {})[pass];
      const match = (provider.models || []).find((m) => m.id === id);
      return `${provider.label} - ${match ? match.label : id || "-"}`;
    };
    const rows = [
      ["Taxonomy", passLine("taxonomy")],
      ["Effort", settings.effort || "high"],
      ["Method", method ? method.label : "-"],
      ["Filing", categorization().fieldsFor(settings.categorizer).assignmentModel
        ? passLine("assignment")
        : "Not used - Jev walks the tree itself"],
    ];
    setupSummaryEl.replaceChildren(
      ...rows.flatMap(([term, value]) => [el("dt", "", term), el("dd", "", String(value))]),
    );

    const blockers = setupState ? categorization().syncBlockers(setupState) : [];
    setupBlockersEl.textContent = blockers.join(" ");
    setupBlockersEl.hidden = blockers.length === 0;

    const status = setupState && setupState.sync ? setupState.sync.status : null;
    if (!status || status.state === "idle") {
      setupSyncStateEl.hidden = true;
      return;
    }
    setupSyncStateEl.hidden = false;
    const badge = el("span", "setup-status-badge");
    badge.setAttribute("data-state", status.state === "done" ? "ok" : "todo");
    badge.textContent =
      status.state === "running" ? "Running" : status.state === "done" ? "Done" : "Failed";
    const text = el("p", "setup-status-text", categorization().progressLine(status));
    setupSyncStateEl.replaceChildren(badge, text);
  }

  async function onSetupNext() {
    if (setupStep === 1) {
      setupStep = 2;
      renderSetupStep();
      return;
    }
    if (setupStep === 2) {
      setupNextBtn.classList.add("is-loading");
      setupNextBtn.disabled = true;
      try {
        await saveCategorization(setupForm);
        setupStep = 3;
      } catch (err) {
        setupNoteEl.textContent = err.message;
        setupNoteEl.hidden = false;
      } finally {
        setupNextBtn.classList.remove("is-loading");
        setupNextBtn.disabled = false;
        renderSetupStep();
      }
      return;
    }
    // Step 3's button is the flow's exit once the sync has succeeded.
    if (setupFinished()) {
      closeSetup();
      return;
    }
    const started = await startSync({ fromSetup: true });
    if (started) renderSetupStep();
    else await fetchSetup();
  }

  function initSetup() {
    if (!setupModalEl || !window.XBOCategorization) return;
    setupForm = createCategorizationForm(setupFormEl, "setup", () =>
      updateFormNote(setupForm, setupNoteEl),
    );
    setupCloseBtn.addEventListener("click", closeSetup);
    setupBackdropEl.addEventListener("click", closeSetup);
    setupBackBtn.addEventListener("click", () => {
      setupStep = Math.max(1, setupStep - 1);
      renderSetupStep();
    });
    setupNextBtn.addEventListener("click", () => void onSetupNext());
    document.addEventListener("keydown", (e) => {
      if (!isSetupOpen()) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        closeSetup();
        return;
      }
      trapModalFocus(setupModalEl, e);
    });
  }

  // ---- empty states ------------------------------------------------------
  // Two distinct ones (XBOCategorization.emptyStateKind): a library with no
  // bookmarks at all gets the guided first run right in the landing; one with
  // bookmarks and no category picked keeps the plain prompt.

  let firstRunEl = null;
  let firstRunForm = null;
  let firstRunDirty = false;
  let firstRunNoteEl = null;
  let firstRunStatusEl = null;
  let firstRunSyncBtn = null;
  // Everything the sync scrim covers, and whether it is covering it right now
  // (#95) - the flag is what makes the hand-off of focus to the progress
  // strip happen once, on the transition into the run, and not on every poll.
  let firstRunBodyEl = null;
  let firstRunScrimmed = false;
  let firstRunCredsEl = null;

  function renderSelectPrompt() {
    const box = el("div", "state state-empty state-welcome state-prompt");
    box.setAttribute("role", "button");
    box.tabIndex = 0;
    box.setAttribute("aria-controls", "sidebar");
    box.setAttribute("data-open-categories", "");
    box.append(
      el("span", "state-icon", "🔖"),
      el("p", "state-title", "Nothing selected yet"),
      el("p", "state-body", "Choose a category from the sidebar to see its bookmarks."),
    );
    box.firstChild.setAttribute("aria-hidden", "true");
    listEl.replaceChildren(box);
  }

  function buildFirstRun() {
    const root = el("section", "first-run");
    root.setAttribute("aria-labelledby", "first-run-title");
    const intro = el("div", "first-run-intro");
    const icon = el("span", "state-icon", "🔖");
    icon.setAttribute("aria-hidden", "true");
    const title = el("h2", "state-title", "No bookmarks yet - get started");
    title.id = "first-run-title";
    intro.append(
      icon,
      title,
      el("p", "state-body", "Pick how your X bookmarks get sorted, then sync. You can change this later in Settings."),
    );

    const body = el("div", "first-run-body");
    firstRunCredsEl = el("div", "creds-alert");
    firstRunCredsEl.hidden = true;
    const formHost = el("div", "first-run-steps");
    firstRunForm = createCategorizationForm(formHost, "firstrun", () => {
      firstRunDirty = true;
      updateFirstRun();
    });
    firstRunNoteEl = el("p", "settings-note");
    firstRunNoteEl.hidden = true;
    firstRunStatusEl = el("p", "phase-helper");
    firstRunStatusEl.setAttribute("aria-live", "polite");
    firstRunSyncBtn = el("button", "btn btn-primary", "Sync my bookmarks");
    firstRunSyncBtn.type = "button";
    firstRunSyncBtn.addEventListener("click", () => void onFirstRunSync());
    const syncPhase = buildPhase(
      "firstrun",
      "sync",
      "Sync",
      "Fetches your bookmarks from X and files them into a category tree.",
      [firstRunNoteEl, firstRunStatusEl, firstRunSyncBtn],
    );
    formHost.appendChild(syncPhase);
    // The scrim is a SIBLING of everything it dims, so it is never itself
    // dimmed or made inert. The body below it is what a running sync takes
    // out of reach (#95).
    body.append(intro, firstRunCredsEl, formHost);
    firstRunBodyEl = body;
    const scrim = el("div", "first-run-scrim");
    scrim.setAttribute("aria-hidden", "true");
    root.append(body, scrim);
    return root;
  }

  async function onFirstRunSync() {
    firstRunSyncBtn.disabled = true;
    try {
      const saved = await saveCategorization(firstRunForm);
      firstRunDirty = false;
      if (settingsForm && !settingsDirty) settingsForm.setValues(saved);
    } catch (err) {
      firstRunNoteEl.textContent = err.message;
      firstRunNoteEl.hidden = false;
      updateFirstRun();
      return;
    }
    await startSync();
    updateFirstRun();
  }

  // One line of "why this credential matters" per id, kept beside the alert
  // builder rather than in missing-credentials.js: the pure module owns the
  // MISSING/required-vs-optional decision, not owner-facing prose.
  const CREDENTIAL_PURPOSE = {
    xClientId: "Needed to connect to X and sync your bookmarks.",
    xClientSecret: "Needed to connect to X and sync your bookmarks.",
    typesafeApiKey:
      "Only needed if you want to use TypeSafe for categorization and scoring/ranking - the app works without it.",
  };

  function credentialItem(cred) {
    const li = el("li", "creds-alert-item");
    li.append(el("strong", null, cred.label), document.createTextNode(` (${cred.envVar}) - `));
    li.append(document.createTextNode(CREDENTIAL_PURPOSE[cred.id] || ""));
    return li;
  }

  function credentialGroup(title, creds) {
    if (creds.length === 0) return null;
    const group = el("div", "creds-alert-group");
    group.append(el("p", "creds-alert-group-title", title));
    const list = el("ul", "creds-alert-list");
    for (const cred of creds) list.appendChild(credentialItem(cred));
    group.appendChild(list);
    return group;
  }

  /**
   * Renders the missing-credentials alert on the never-synced landing from
   * pure derived state (`XBOMissingCredentials.missingCredentialsAlert`) -
   * `setupState.bookmarkCount` plus the three `credentials.*.present` flags
   * `/api/setup` reports. Hidden entirely once something is synced or
   * nothing is missing; never fabricates a "ready to sync" list.
   */
  function renderMissingCredentialsAlert() {
    if (!firstRunCredsEl || !setupState || !window.XBOMissingCredentials) return;
    const alert = window.XBOMissingCredentials.missingCredentialsAlert(setupState.bookmarkCount, setupState.credentials);
    if (!alert) {
      firstRunCredsEl.hidden = true;
      firstRunCredsEl.replaceChildren();
      return;
    }
    const blocking = alert.kind === "blocking";
    firstRunCredsEl.dataset.kind = alert.kind;
    firstRunCredsEl.setAttribute("role", "status");
    firstRunCredsEl.setAttribute("aria-labelledby", "creds-alert-title");
    const icon = el("span", "creds-alert-icon");
    icon.setAttribute("aria-hidden", "true");
    const badge = el("p", "creds-alert-badge", blocking ? "Action needed to sync" : "Optional");
    const title = el("h3", "creds-alert-title", "Missing credentials");
    title.id = "creds-alert-title";
    const bodyEl = el("div", "creds-alert-body");
    bodyEl.append(badge, title);
    const requiredGroup = credentialGroup("Required to sync", alert.required);
    if (requiredGroup) bodyEl.appendChild(requiredGroup);
    const optionalGroup = credentialGroup("Optional", alert.optional);
    if (optionalGroup) bodyEl.appendChild(optionalGroup);
    bodyEl.append(
      el(
        "p",
        "creds-alert-hint",
        "Set these through an environment variable, a .env file in the project root, your OS keychain, or " +
          "~/.config/x-bookmarks-organizer/credentials.json, then restart the viewer.",
      ),
    );
    firstRunCredsEl.replaceChildren(icon, bodyEl);
    firstRunCredsEl.hidden = false;
  }

  function updateFirstRun() {
    if (!firstRunEl || !setupState) return;
    updateFormNote(firstRunForm, firstRunNoteEl);
    renderMissingCredentialsAlert();
    const running = syncIsRunning();
    // A run is not interruptible and takes minutes, so the get-started view
    // goes behind a scrim for its duration: dimmed (CSS, keyed off this
    // attribute), click-proof, and `inert` so nothing behind it can be
    // tabbed to or re-pressed. The progress strip lives ABOVE the scrim, in
    // the column's own row, and is where the keyboard is handed on the way in.
    firstRunEl.dataset.syncing = running ? "true" : "false";
    if (firstRunBodyEl) firstRunBodyEl.inert = running;
    if (running && !firstRunScrimmed && firstRunEl.isConnected && syncProgressEl && !syncProgressEl.hidden) {
      syncProgressEl.focus();
    }
    firstRunScrimmed = running;
    firstRunSyncBtn.disabled = running || !syncAvailable();
    firstRunSyncBtn.textContent = running ? "Syncing…" : "Sync my bookmarks";
    const status = setupState.sync && setupState.sync.status;
    firstRunStatusEl.textContent =
      status && status.state !== "idle"
        ? categorization().progressLine(status)
        : !syncAvailable() && setupState.sync.reason
          ? setupState.sync.reason
          : "";
  }

  function updateEmptyLibraryState() {
    if (!setupState) return;
    const kind = categorization().emptyStateKind(setupState.bookmarkCount, selectedCategoryId);
    if (kind === "first-run" && selectedCategoryId == null) {
      if (!firstRunEl) firstRunEl = buildFirstRun();
      if (firstRunEl.parentNode !== listEl) {
        listEl.replaceChildren(firstRunEl);
        firstRunDirty = false;
      }
      firstRunForm.setCatalog(setupState.catalog);
      if (!firstRunDirty) firstRunForm.setValues(setupState.settings);
      updateFirstRun();
      return;
    }
    // The first sync landed (or a category is open): the landing has done its job.
    if (firstRunEl && firstRunEl.parentNode === listEl) {
      if (kind === "select-category") renderSelectPrompt();
      else firstRunEl.remove();
    }
  }

  // ---- reset library -----------------------------------------------------

  const resetOpenBtn = document.getElementById("reset-open");
  const resetModalEl = document.getElementById("reset-modal");
  const resetBackdropEl = document.getElementById("reset-backdrop");
  const resetCancelBtn = document.getElementById("reset-cancel");
  const resetConfirmBtn = document.getElementById("reset-confirm");
  const resetErrorEl = document.getElementById("reset-error");

  function isResetOpen() {
    return !!resetModalEl && !resetModalEl.hidden;
  }

  function openReset() {
    const syncPopover = popovers.find((p) => p.name === "sync");
    if (syncPopover && isPopoverOpen(syncPopover)) setPopoverOpen(syncPopover, false, { returnFocus: false });
    resetErrorEl.hidden = true;
    resetModalEl.hidden = false;
    resetBackdropEl.hidden = false;
    // Cancel first: the destructive button is never the default target.
    resetCancelBtn.focus();
  }

  function closeReset() {
    resetModalEl.hidden = true;
    resetBackdropEl.hidden = true;
    const toggle = document.getElementById("sync-toggle");
    if (toggle) toggle.focus();
  }

  async function confirmReset() {
    resetConfirmBtn.disabled = true;
    resetConfirmBtn.classList.add("is-loading");
    resetErrorEl.hidden = true;
    try {
      const res = await fetch("/api/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Could not reset the library.");
      }
    } catch (err) {
      resetErrorEl.textContent = err.message;
      resetErrorEl.hidden = false;
      return;
    } finally {
      resetConfirmBtn.disabled = false;
      resetConfirmBtn.classList.remove("is-loading");
    }
    // Back to the never-synced state everywhere the viewer remembers the old library.
    clearPersistedViews();
    viewCaches = new Map();
    cacheOrder = [];
    resetPool();
    selectedCategoryId = null;
    renderEmptyTitle();
    persistSelection();
    lastSyncedAt = null;
    renderSyncStatus();
    if (syncProgressEl) syncProgressEl.hidden = true;
    resetModalEl.hidden = true;
    resetBackdropEl.hidden = true;
    await loadTree();
    await fetchSetup();
    const target = firstRunSyncBtn && firstRunSyncBtn.isConnected ? firstRunSyncBtn : document.getElementById("sync-toggle");
    if (target) target.focus();
  }

  function initReset() {
    if (!resetOpenBtn || !resetModalEl) return;
    resetOpenBtn.addEventListener("click", openReset);
    resetCancelBtn.addEventListener("click", closeReset);
    resetBackdropEl.addEventListener("click", closeReset);
    resetConfirmBtn.addEventListener("click", () => void confirmReset());
    document.addEventListener("keydown", (e) => {
      if (!isResetOpen()) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        closeReset();
        return;
      }
      trapModalFocus(resetModalEl, e);
    });
  }

  // ---- init --------------------------------------------------------------
  initSidebar();
  initSidebarResizer();
  initScrollTop();
  initCrumbMenu();
  initScoreDetail();
  initSettingsPanel();
  initPostScale();
  initSortOrder();
  initThemeToggle();
  initColorToggle();
  initSearch();
  initFilterTabs();
  initSummary();
  initSync();
  initCategorizationSettings();
  initSetup();
  initReset();
  initRanking();
  initMovePicker();
  initCategoryEditor();
  initRubricEditor();
  void restoreLastView();
  window.addEventListener("pagehide", persistViewSnapshot);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") persistViewSnapshot();
  });
  loadSyncStatus();
  loadSummaryStatus();
  // Last: it decides whether the guided flow opens, which needs the tree's
  // state (an already-selected category suppresses it).
  void fetchSetup().then(() => {
    if (syncIsRunning()) pollSync();
    // A ranking run started in another tab (or before a reload) owns the strip
    // just as a sync does - it is the same one-at-a-time server job.
    if (ranking().isRunning(rankState())) pollRank();
  });
})();
