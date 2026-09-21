"use strict";

/**
 * X Bookmarks Organizer — local web viewer.
 * Vanilla JS: renders the category tree, lists a node's bookmarks, embeds the
 * X post where possible (link fallback otherwise), and marks a bookmark read
 * when it is opened.
 */
(function () {
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
  // How the list is ordered (issue #62): "recent" (always the default) or
  // "score", the opt-in ranking pass's verdict. Ordering happens SERVER-side
  // because paging does - sorting one page here would only shuffle whichever
  // batch happened to arrive. Persisted through XBOSortOrder's guarded storage.
  let activeSort = "recent";

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
   * detached node. A bookmark with no verdict simply ends up with no chip.
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
    const chip = renderScoreChip(bm);
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
    window.XBOViewPersist.writeSnapshot(window.sessionStorage, views, activeSort, Date.now());
  }

  /** Seed `viewCaches` from the stored snapshot, for categories that still exist. */
  function hydrateViewSnapshot() {
    const views = window.XBOViewPersist.readSnapshot(window.sessionStorage, activeSort, Date.now());
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
    await loadTree();
    try {
      const saved = window.XBOViewPersist && window.XBOViewPersist.readSelection(window.localStorage);
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
      setCollapsed(true);
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

  // ---- list ordering (issue #62) -----------------------------------------
  // This control only chooses how to ORDER what has already been scored; it
  // never starts a run. Starting one lives behind the confirm-gated "Rank now"
  // in the ranking popover (issues #80, #89), where the paid decision belongs.
  const sortOrderEl = document.getElementById("sort-order");
  const sortOrderHintEl = document.getElementById("sort-order-hint");

  function applySortOrder(id) {
    activeSort = id;
    if (!sortOrderEl) return;
    sortOrderEl.querySelectorAll(".seg-input").forEach((input) => {
      input.checked = input.value === id;
    });
  }

  /**
   * Say how much of the library is actually ranked, so "Top score" is never a
   * control that silently does nothing. Falls back to the static markup when
   * /api/setup could not be read.
   */
  function updateSortOrderHint() {
    if (!sortOrderHintEl || !setupState || !setupState.ranking) return;
    const { scored, total } = setupState.ranking;
    if (scored === 0) {
      sortOrderHintEl.textContent =
        total === 0
          ? "Nothing is ranked yet."
          : `None of your ${total} bookmarks are ranked yet. Ranking is paid per token; start a run from "Rank now" in the ranking panel.`;
      return;
    }
    sortOrderHintEl.textContent =
      scored === total
        ? `All ${total} bookmarks are ranked. Top score orders them by learning value.`
        : `${scored} of ${total} bookmarks are ranked; the rest sort last under Top score.`;
  }

  /**
   * Switch ordering: every cached view was paged under the OLD order, so any of
   * them could now be in the wrong sequence - they are dropped wholesale rather
   * than patched, exactly as a completed sync drops them.
   */
  function selectSortOrder(id) {
    if (id === activeSort || !window.XBOSortOrder) return;
    window.XBOSortOrder.writeSortOrder(window.localStorage, id);
    applySortOrder(id);
    clearPersistedViews();
    viewCaches = new Map();
    cacheOrder = [];
    // The POOL is deliberately kept: re-paging only re-sequences the cards it
    // already holds (`paintViewCards` sets `order` and LRU-evicts the cold
    // ones), so no loaded post - and no mounted X embed - reloads.
    if (selectedCategoryId != null) void fetchAndRenderFirstPage();
  }

  function initSortOrder() {
    if (!window.XBOSortOrder) return;
    applySortOrder(window.XBOSortOrder.readSortOrder(window.localStorage));
    if (!sortOrderEl) return;
    sortOrderEl.querySelectorAll(".seg-input").forEach((input) => {
      input.addEventListener("change", () => {
        if (input.checked) selectSortOrder(input.value);
      });
    });
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

  /** Paint each filter tab's count badge (issue #72). */
  function renderCountLine() {
    const counts = tabCounts();
    for (const tab of filterTabButtons()) {
      const badge = tab.querySelector(".filter-tab-count");
      if (!badge) continue;
      const n = counts[tab.dataset.filter];
      badge.textContent = String(n);
      tab.setAttribute(
        "aria-label",
        `${tab.querySelector(".filter-tab-label").textContent}, ${n}`,
      );
    }
  }

  /**
   * Show or hide the whole tab bar (PR-VB4).
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
    const sort = window.XBOSortOrder ? window.XBOSortOrder.sortParam(activeSort) : "recent";
    const url =
      `/api/categories/${selectedCategoryId}/bookmarks` +
      `?filter=${encodeURIComponent(activeFilter)}&sort=${encodeURIComponent(sort)}` +
      `&offset=${offset}`;
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
    left.appendChild(renderPill(bm, card));
    left.appendChild(renderFavoriteButton(bm, card));

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

    const scoreChip = renderScoreChip(bm);
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
   * controls - or nothing at all for a bookmark the paid ranking pass has never
   * scored, which is not the same as a score of zero.
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
  function renderScoreChip(bm) {
    if (!window.XBOSortOrder) return null;
    const breakdown = window.XBOSortOrder.scoreBreakdown(bm.score);
    if (breakdown === null) return null;

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
    // Show a skeleton + spinner immediately and reveal only the finished
    // result: the official embed once widgets.js reports it fully rendered, or
    // the text+link fallback on failure/timeout/non-embeddable post. This
    // avoids the previous flash where raw text showed first and then "popped"
    // into the embed.
    const loader = el("div", "embed-loader");
    loader.setAttribute("role", "status");
    loader.setAttribute("aria-label", "Loading post…");
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

  // ---- leaving the live view (PR-VB4) ---------------------------------
  // Marking a post read in the Unread tab used to make it disappear on the
  // spot and the next post jump up into its place. It is now a movement with
  // a direction: the card slides out to the RIGHT while fading, and only then
  // do the posts below travel up to close the gap. `transform` and `opacity`
  // only, on both halves - the gap is closed with a FLIP, never by animating
  // a layout property.

  const reducedMotion =
    typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)")
      : { matches: false };

  /** How far right the card travels, as a share of its own width. */
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
  function animateCardExit(card, commit) {
    if (reducedMotion.matches || typeof card.animate !== "function" || card.hidden) {
      commit();
      return;
    }
    const followers = cardsAfter(card);
    const before = followers.map((other) => other.getBoundingClientRect().top);
    const slide = card.animate(
      [
        { transform: "translateX(0)", opacity: 1 },
        { transform: `translateX(${EXIT_SLIDE_DISTANCE})`, opacity: 0 },
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
  function dropCardFromView(bm, card) {
    animateCardExit(card, () => {
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
      if (dropsOut) dropCardFromView(bm, card);
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

  function showToast(message, actionLabel, onAction) {
    const toast = el("div", "toast");
    toast.setAttribute("role", "status");
    toast.appendChild(el("span", "toast-msg", message));
    if (actionLabel && onAction) {
      const actionBtn = el("button", "btn btn-ghost toast-action", actionLabel);
      actionBtn.type = "button";
      actionBtn.addEventListener("click", () => {
        toast.remove();
        onAction();
      });
      toast.appendChild(actionBtn);
    }
    toastContainerEl.appendChild(toast);
    if (!onAction) setTimeout(() => toast.remove(), 4000);
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
    const toast = showToast(
      `Deleted @${bm.authorUsername}’s post.`,
      "Undo",
      () => {
        undone = true;
        clearTimeout(timer);
        restore();
      },
    );

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

  /** Tab/Shift+Tab wraps within `modalEl` while it is open (a real modal). Shared by every modal. */
  function trapModalFocus(modalEl, e) {
    if (e.key !== "Tab") return;
    const focusable = modalEl.querySelectorAll(
      'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
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
    fieldsFor: () => ({ provider: false, taxonomyModel: false, effort: false, assignmentModel: false }),
    findProvider: () => null,
    findMethod: () => null,
    modelOptions: () => [],
    effortOptions: () => [],
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
    updateEmptyLibraryState();
    updateToolbarVisibility();
    updateSortOrderHint();
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

    renderSyncProgress({ state: "running", messages: ["Starting sync…"] });
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

  const syncProgressEls = {
    root: syncProgressEl,
    text: syncProgressTextEl,
    details: syncProgressDetailsEl,
    log: syncProgressLogEl,
    retry: syncProgressRetryBtn,
    dismiss: syncProgressDismissBtn,
  };

  function renderSyncProgress(status) {
    renderProgressStrip(syncProgressEls, status, (s) => categorization().progressLine(s));
  }

  function initSync() {
    if (syncBtn) syncBtn.addEventListener("click", () => startSync());
    if (syncProgressRetryBtn) syncProgressRetryBtn.addEventListener("click", () => startSync());
    if (syncProgressDismissBtn) {
      syncProgressDismissBtn.addEventListener("click", () => {
        syncProgressEl.hidden = true;
        syncBtn.focus();
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
  const rankProgressEls = {
    root: document.getElementById("rank-progress"),
    text: document.getElementById("rank-progress-text"),
    details: document.getElementById("rank-progress-details"),
    log: document.getElementById("rank-progress-log"),
    retry: document.getElementById("rank-progress-retry"),
    dismiss: document.getElementById("rank-progress-dismiss"),
  };

  let rankPollTimer = null;
  const RANK_POLL_MS = 1500;

  // Inert defaults, like NO_CATEGORIZATION: a missing script must leave the
  // paid control OFF, never accidentally enabled.
  const NO_RANKING = {
    rankBlocker: () => "Ranking is unavailable in this viewer.",
    blockerHeadline: (m) => m,
    blockerDetail: () => "",
    canRank: () => false,
    isRunning: () => false,
    coverageLine: () => "",
    confirmCost: () => "This is a paid run, billed per input token.",
    confirmLabel: () => "Rank bookmarks",
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
    // The progress strip lives inside the popover now, so the icon itself has
    // to carry "a run is going" for an owner who closed the panel.
    const rankToggleBtn = document.getElementById("rank-toggle");
    if (rankToggleBtn) {
      rankToggleBtn.classList.toggle("is-ranking", running);
      rankToggleBtn.title = running ? "Ranking in progress" : "Ranking";
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

  /** Open the paid confirmation. Nothing is spent until it is confirmed. */
  function openRankConfirm() {
    if (!rankModalEl) return;
    const state = rankState();
    if (state && ranking().rankBlocker(state) !== null) {
      updateRankControl();
      return;
    }
    const rankPopover = popovers.find((p) => p.name === "ranking");
    if (rankPopover && isPopoverOpen(rankPopover)) setPopoverOpen(rankPopover, false, { returnFocus: false });

    if (rankCostTextEl) rankCostTextEl.textContent = ranking().confirmCost(state);
    if (rankConfirmBtn) rankConfirmBtn.textContent = ranking().confirmLabel(state);
    rankErrorEl.hidden = true;
    rankModalEl.hidden = false;
    rankBackdropEl.hidden = false;
    // Cancel first: the button that spends money is never the default target.
    rankCancelBtn.focus();
  }

  function closeRankConfirm(focusTarget) {
    if (!rankModalEl) return;
    rankModalEl.hidden = true;
    rankBackdropEl.hidden = true;
    // Focus goes back to a trigger the owner can actually see. "Rank now"
    // lives INSIDE the ranking popover, which opening the dialog closed, so it
    // is usually not focusable by the time we get here - focusing it then
    // would silently drop focus to <body> and strand a keyboard user. The
    // popover's own toggle is the visible thing that stands for it.
    const visible = (elm) => !!elm && !elm.disabled && elm.offsetParent !== null;
    const target =
      focusTarget || (visible(rankOpenBtn) ? rankOpenBtn : document.getElementById("rank-toggle"));
    if (target) target.focus();
  }

  /** The authorization itself: the ONE place the viewer sends `confirm: true`. */
  async function confirmRank() {
    rankConfirmBtn.disabled = true;
    rankConfirmBtn.classList.add("is-loading");
    rankErrorEl.hidden = true;
    try {
      const res = await fetch("/api/rank", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
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
    renderRankProgress({ state: "running", messages: ["Starting the ranking run\u2026"] });
    pollRank();
  }

  function renderRankProgress(status) {
    renderProgressStrip(rankProgressEls, status, (s) => ranking().progressLine(s));
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
      updateSortOrderHint();

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
    // on screen rather than rebuilding (and reloading) them.
    await fetchSetup();
    if (selectedCategoryId != null) await fetchAndRenderFirstPage();
  }

  function initRanking() {
    if (!rankOpenBtn || !rankModalEl) return;
    rankOpenBtn.addEventListener("click", openRankConfirm);
    rankCancelBtn.addEventListener("click", () => closeRankConfirm());
    rankBackdropEl.addEventListener("click", () => closeRankConfirm());
    rankConfirmBtn.addEventListener("click", () => void confirmRank());
    // A retry is a fresh authorization, never a silent re-run.
    if (rankProgressEls.retry) rankProgressEls.retry.addEventListener("click", openRankConfirm);
    if (rankProgressEls.dismiss) {
      rankProgressEls.dismiss.addEventListener("click", () => {
        rankProgressEls.root.hidden = true;
        const toggle = document.getElementById("sync-toggle");
        if (toggle) toggle.focus();
      });
    }
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

  /** How each billing model reads to the owner, in one line. */
  const BILLING_HINTS = {
    subscription: "Runs on your Claude subscription - no per-call charge.",
    "per-token": "Billed per token.",
    local: "Runs locally.",
  };

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
   * A provider / model / effort selector over the server's catalog. Returns
   * the mounted root plus the small API `app.js` drives it with.
   */
  function createCategorizationForm(container, idPrefix, onChange) {
    const method = buildField(idPrefix, "categorizer", "Method");
    const provider = buildField(idPrefix, "provider", "Model provider");
    const taxonomy = buildField(idPrefix, "taxonomyModel", "Taxonomy model");
    const assignment = buildField(idPrefix, "assignmentModel", "Filing model");
    const effort = buildField(idPrefix, "effort", "Reasoning effort");
    // Two phases, in the order the app runs them: design the tree, then file
    // each bookmark into it.
    const phase1 = buildPhase(
      idPrefix,
      "phase1",
      "Phase 1 - Taxonomy",
      "Designs the category tree from all your bookmarks at once. This pass always runs on Claude.",
      [provider.field, taxonomy.field, effort.field],
    );
    const phase2 = buildPhase(
      idPrefix,
      "phase2",
      "Phase 2 - Categorization method",
      "Files each bookmark into a category of that tree. Choose Claude Code or Jev.",
      [method.field, assignment.field],
    );
    container.replaceChildren(phase1, phase2);

    let catalog = null;

    function currentProvider() {
      return categorization().findProvider(catalog, provider.select.value);
    }

    function renderModelFields(values) {
      const p = currentProvider();
      const taxonomyOptions = categorization().modelOptions(p, "taxonomy");
      const assignmentOptions = categorization().modelOptions(p, "assignment");
      const effortOptions = categorization().effortOptions(p);
      fillOptions(taxonomy.select, taxonomyOptions, (values && values.taxonomyModel) || "");
      fillOptions(assignment.select, assignmentOptions, (values && values.assignmentModel) || "");
      fillOptions(effort.select, effortOptions, (values && values.effort) || "");
      effort.field.hidden = effortOptions.length <= 1;
      renderHints();
    }

    function renderHints() {
      const p = currentProvider();
      const chosenMethod = categorization().findMethod(catalog, method.select.value);
      method.hint.textContent = chosenMethod ? chosenMethod.description : "";
      method.hint.classList.toggle("field-billing", !!chosenMethod && chosenMethod.billing === "per-token");
      // The label is already in the select; the hint says the thing the
      // owner cannot see there - how this provider is billed.
      provider.hint.textContent = p ? BILLING_HINTS[p.billing] || "" : "";
      taxonomy.hint.textContent = hintFor(categorization().modelOptions(p, "taxonomy"), taxonomy.select.value);
      assignment.hint.textContent = hintFor(
        categorization().modelOptions(p, "assignment"),
        assignment.select.value,
      );
      effort.hint.textContent = hintFor(categorization().effortOptions(p), effort.select.value);
      // Jev files bookmarks without a prompt, so it has no filing model; the
      // taxonomy pass is always Claude, so Phase 1 never goes away.
      assignment.field.hidden = !categorization().fieldsFor(method.select.value).assignmentModel;
    }

    const notify = () => {
      renderHints();
      if (onChange) onChange();
    };
    method.select.addEventListener("change", notify);
    provider.select.addEventListener("change", () => {
      renderModelFields(null);
      if (onChange) onChange();
    });
    for (const f of [taxonomy, assignment, effort]) f.select.addEventListener("change", notify);

    return {
      setCatalog(next) {
        catalog = next;
        fillOptions(
          method.select,
          (next.methods || []).map((m) => ({ value: m.id, label: m.label, hint: m.description })),
          method.select.value,
        );
        fillOptions(
          provider.select,
          (next.providers || []).map((p) => ({
            value: p.id,
            label: p.label,
            hint: BILLING_HINTS[p.billing] || "",
          })),
          provider.select.value,
        );
        renderModelFields(null);
      },
      setValues(values) {
        if (!values) return;
        method.select.value = values.categorizer || "";
        provider.select.value = values.provider || "";
        renderModelFields(values);
      },
      getValues() {
        return {
          categorizer: method.select.value,
          provider: provider.select.value,
          taxonomyModel: taxonomy.select.value,
          assignmentModel: assignment.select.value,
          effort: effort.select.value,
        };
      },
    };
  }

  /** Show why the currently selected method cannot run, or hide the note. */
  function updateFormNote(form, noteEl) {
    if (!form || !noteEl || !setupState) return;
    const blocker = categorization().methodBlocker(
      setupState.catalog,
      form.getValues().categorizer,
      setupState.credentials,
    );
    noteEl.textContent = blocker || "";
    noteEl.hidden = !blocker;
  }

  async function saveCategorization(form) {
    const payload = categorization().toPayload(form.getValues());
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
    const provider = categorization().findProvider(catalog, settings.provider);
    const method = categorization().findMethod(catalog, settings.categorizer);
    const suggested = provider && provider.suggested ? provider.suggested : {};
    // Show what the dropdowns showed - the model's label, not its raw id.
    const modelLabel = (id) => {
      const models = (provider && provider.models) || [];
      const match = models.find((m) => m.id === id);
      return match ? match.label : id || "-";
    };
    const rows = [
      ["Method", method ? method.label : "-"],
      ["Provider", provider ? provider.label : "-"],
      ["Taxonomy model", modelLabel(settings.taxonomyModel || suggested.taxonomy)],
      ["Filing model", categorization().fieldsFor(settings.categorizer).assignmentModel
        ? modelLabel(settings.assignmentModel || suggested.assignment)
        : "Not used - Jev walks the tree itself"],
      ["Effort", settings.effort || "high"],
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
  // (PR-VB4) - the flag is what makes the hand-off of focus to the progress
  // strip happen once, on the transition into the run, and not on every poll.
  let firstRunBodyEl = null;
  let firstRunScrimmed = false;

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
    // out of reach (PR-VB4).
    body.append(intro, formHost);
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

  function updateFirstRun() {
    if (!firstRunEl || !setupState) return;
    updateFormNote(firstRunForm, firstRunNoteEl);
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
    // A run started in another tab (or before a reload) keeps reporting here.
    if (ranking().isRunning(rankState())) pollRank();
  });
})();
