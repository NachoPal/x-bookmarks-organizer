"use strict";

/**
 * X Bookmarks Organizer — local web viewer.
 * Vanilla JS: renders the category tree, lists a node's bookmarks, embeds the
 * X post where possible (link fallback otherwise), and marks a bookmark read
 * when it is opened.
 */
(function () {
  const treeEl = document.getElementById("tree");
  const listEl = document.getElementById("bookmark-list");
  const titleEl = document.getElementById("content-title");
  const countEl = document.getElementById("content-count");
  const searchInput = document.getElementById("category-search");
  const searchClear = document.getElementById("category-search-clear");
  const readFilterEl = document.getElementById("read-filter");

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
  let expansionState = new Map();
  // Full category tree (roots) kept in memory so the search filter can
  // re-render from source without re-fetching.
  let treeRoots = [];
  // id -> node, flattened from treeRoots (same object references) so a
  // read-state toggle or delete can walk straight to a category's ancestors
  // and patch counts in place, without touching the rest of the sidebar DOM.
  let categoryIndex = new Map();
  let readFilter = "all"; // "all" | "unread" | "read"

  // ---- lazy loading (paged, filtered, infinite scroll) ------------------
  // The selected category is loaded one batch at a time as the owner scrolls,
  // so a large category never renders (or embeds) every post up front. Counts
  // come from the server so totals stay accurate without downloading each row.
  let categoryCounts = { total: 0, unread: 0 };
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

  // ---- client-side filter cache (issue #33) -------------------------------
  // Switching the read-state filter (or switching back to a category already
  // visited) reuses already-fetched pages and already-rendered DOM instead of
  // re-fetching and re-rendering - no reload flash and no reloading the X
  // embeds that were already loaded. Keyed by category id -> { counts,
  // filters: Map(filter -> { ids, cardEls, bmById, offset, hasMore }) }.
  // Bounded to XBOFilterCache.MAX_CACHED_CATEGORIES categories via LRU
  // eviction so it never grows unbounded across a long browsing session.
  let viewCaches = new Map();
  let cacheOrder = []; // LRU order of cached category ids, oldest first

  function touchCategoryCache(categoryId) {
    const { order, evicted } = window.XBOFilterCache.touchLru(cacheOrder, categoryId);
    cacheOrder = order;
    for (const id of evicted) viewCaches.delete(id);
  }

  function ensureCategoryCache(categoryId) {
    touchCategoryCache(categoryId);
    let entry = viewCaches.get(categoryId);
    if (!entry) {
      entry = { counts: { total: 0, unread: 0 }, filters: new Map() };
      viewCaches.set(categoryId, entry);
    }
    return entry;
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
    catCache.filters.set(readFilter, {
      ids,
      cardEls: Array.from(listEl.querySelectorAll(":scope > .bookmark-card")),
      bmById,
      offset: pageOffset,
      hasMore: pageHasMore,
    });
  }

  /** Sync cached category counts (rollup total/unread) from tree-count updates. */
  function syncCacheCounts(updatedNodes) {
    for (const node of updatedNodes) {
      const catCache = viewCaches.get(node.id);
      if (catCache) catCache.counts = { total: node.total, unread: node.unread };
    }
  }

  /**
   * Render a cache-hit view directly from stored DOM nodes: no fetch, no
   * re-render, and the embeds inside those nodes are reused as-is.
   */
  function restoreViewFromCache(entry) {
    teardownObserver();
    pageLoading = false;
    viewReady = true; // an already-settled snapshot, safe to re-cache as-is
    requestSeq += 1; // cancel any in-flight fetch from the view being left
    pageOffset = entry.offset;
    pageHasMore = entry.hasMore;
    currentViewBookmarks = entry.ids.map((id) => entry.bmById.get(id)).filter(Boolean);

    readFilterEl.hidden = categoryCounts.total === 0;
    listEl.replaceChildren();
    if (categoryCounts.total === 0) {
      countEl.textContent = "";
      stateMessage(listEl, "empty", "No bookmarks are filed under this category.");
      return;
    }
    renderCountLine();
    if (currentViewBookmarks.length === 0) {
      stateMessage(listEl, "empty", emptyFilterMessage());
      return;
    }
    for (const cardEl of entry.cardEls) listEl.appendChild(cardEl);
    updateTail();
  }

  /**
   * After a read-state change, keep every cached view (other than the one
   * currently on screen, which the live DOM/bm patch already handles)
   * consistent, across every category the bookmark is filed under. A cached
   * Unread/Read entry whose membership for this bookmark is now stale is
   * fully invalidated (deleted, so the next visit fetches fresh) rather than
   * patched: dropping the id alone would correctly make it disappear from
   * the cache it left, but silently leave it missing from the cache it now
   * belongs to (the correct sort position for a newly-qualifying post isn't
   * knowable client-side). `all` membership never changes on a read-state
   * change, so that entry is patched in place instead of invalidated.
   */
  function invalidateCachedViewsOnReadChange(bm) {
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

      for (const filterName of ["unread", "read"]) {
        if (categoryId === selectedCategoryId && filterName === readFilter) continue; // live view, already patched
        const entry = catCache.filters.get(filterName);
        if (!entry) continue;
        if (window.XBOFilterCache.isFilterEntryStale(entry.ids, filterName, bm.id, bm.read)) {
          catCache.filters.delete(filterName);
        }
      }

      const allEntry = catCache.filters.get("all");
      if (allEntry && allEntry.bmById.has(bm.id)) {
        const cachedBm = allEntry.bmById.get(bm.id);
        cachedBm.read = bm.read;
        cachedBm.readAt = bm.readAt;
        const idx = allEntry.ids.indexOf(bm.id);
        const cardEl = idx !== -1 ? allEntry.cardEls[idx] : null;
        // When this cached "all" card IS the one on screen it was already
        // patched by the caller; only touch the detached copy.
        if (cardEl && !(categoryId === selectedCategoryId && readFilter === "all")) {
          cardEl.classList.toggle("is-unread", !cachedBm.read);
          const oldPill = cardEl.querySelector(".read-pill");
          if (oldPill) oldPill.replaceWith(renderPill(cachedBm, cardEl));
        }
      }
    }
  }

  /** Permanently remove a deleted bookmark from every cached filter entry. */
  function purgeFromCache(bm) {
    const affected = window.XBOTreeCounts
      ? window.XBOTreeCounts.affectedCategoryIds(categoryIndex, bm.categoryIds || [])
      : new Set(bm.categoryIds || []);
    for (const categoryId of affected) {
      const catCache = viewCaches.get(categoryId);
      if (!catCache) continue;
      for (const [, entry] of catCache.filters) {
        const idx = entry.ids.indexOf(bm.id);
        if (idx === -1) continue;
        entry.ids.splice(idx, 1);
        entry.cardEls.splice(idx, 1);
        entry.bmById.delete(bm.id);
        entry.offset = Math.max(0, entry.offset - 1);
      }
    }
  }

  /** Show the selected category+filter: a cache hit restores instantly, a miss fetches. */
  async function showCategoryView() {
    const catCache = viewCaches.get(selectedCategoryId);
    if (catCache) categoryCounts = catCache.counts;
    const cached = catCache && catCache.filters.get(readFilter);
    if (cached) {
      touchCategoryCache(selectedCategoryId);
      restoreViewFromCache(cached);
      return;
    }
    await fetchAndRenderFirstPage();
  }

  // ---- sidebar (overlay drawer) -----------------------------------------
  // The drawer overlays the content at every width (issue #42): the content
  // column is centered and never reflows, so opening/closing is purely a
  // visibility change. Only the *auto-dismiss on pick* still depends on
  // width, where the drawer covers nearly the whole viewport.

  const bodyEl = document.body;
  const contentEl = document.getElementById("bookmarks"); // the scrolling pane
  const sidebarEl = document.getElementById("sidebar");
  const toggleBtn = document.getElementById("sidebar-toggle");
  const closeBtn = document.getElementById("sidebar-close");
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
    closeBtn.addEventListener("click", () => setCollapsed(true));
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
      // The settings popover owns Escape while it is open.
      if (isSettingsOpen()) return;
      setCollapsed(true);
    });
  }

  // ---- settings popover (issue #37) --------------------------------------
  // The gear in the bar's right region. Canonical home of the text-size,
  // theme and category-color settings; the bar's theme/colors icon buttons
  // are wide-screen quick access to exactly the same state.
  const settingsToggleBtn = document.getElementById("settings-toggle");
  const settingsPanelEl = document.getElementById("settings-panel");

  function isSettingsOpen() {
    return !!settingsPanelEl && !settingsPanelEl.hidden;
  }

  function setSettingsOpen(open, opts) {
    const options = opts || {};
    if (!settingsPanelEl || !settingsToggleBtn) return;
    settingsPanelEl.hidden = !open;
    settingsToggleBtn.setAttribute("aria-expanded", String(open));
    settingsToggleBtn.setAttribute("aria-label", open ? "Close settings" : "Open settings");

    if (open) {
      const first =
        settingsPanelEl.querySelector(".seg-input:checked") ||
        settingsPanelEl.querySelector("button, input");
      if (first) first.focus();
    } else if (options.returnFocus !== false) {
      settingsToggleBtn.focus();
    }
  }

  function initSettingsPanel() {
    if (!settingsToggleBtn || !settingsPanelEl) return;
    settingsToggleBtn.addEventListener("click", () => setSettingsOpen(!isSettingsOpen()));

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && isSettingsOpen()) setSettingsOpen(false);
    });
    // A click anywhere outside dismisses it; inside it (or on the gear,
    // which toggles) does not.
    document.addEventListener("pointerdown", (e) => {
      if (!isSettingsOpen()) return;
      if (settingsPanelEl.contains(e.target) || settingsToggleBtn.contains(e.target)) return;
      setSettingsOpen(false, { returnFocus: false });
    });
  }

  // ---- text size (issue #37) ---------------------------------------------
  // One --text-scale multiplier on :root that every --text-* token derives
  // from, so the whole viewer's type resizes without any layout measure
  // moving. Persisted through XBOTextSize's guarded storage.
  const textSizeEl = document.getElementById("text-size");

  function applyTextSize(id) {
    if (!window.XBOTextSize) return;
    document.documentElement.style.setProperty(
      "--text-scale",
      String(window.XBOTextSize.scaleFor(id)),
    );
    if (!textSizeEl) return;
    textSizeEl.querySelectorAll(".seg-input").forEach((input) => {
      input.checked = input.value === id;
    });
  }

  function initTextSize() {
    if (!window.XBOTextSize) return;
    applyTextSize(window.XBOTextSize.readTextSize(window.localStorage));
    if (!textSizeEl) return;
    textSizeEl.querySelectorAll(".seg-input").forEach((input) => {
      input.addEventListener("change", () => {
        if (!input.checked) return;
        window.XBOTextSize.writeTextSize(window.localStorage, input.value);
        applyTextSize(input.value);
      });
    });
  }

  // ---- category-color toggle ---------------------------------------------
  // Lets the owner compare a plain (indentation + guide lines only) tree
  // against the per-root-hue colored one and persists the choice, so a
  // reload keeps whichever they picked. Defaults to off (the plain tree).
  // Two controls drive the one state: the settings panel's switch (always
  // present) and the bar's quick icon button (wide screens only).
  const colorSwitchEl = document.getElementById("category-color-toggle");
  const colorQuickBtn = document.getElementById("color-toggle");

  function isColorEnabled() {
    return bodyEl.getAttribute("data-tree-colors") === "on";
  }

  function setColorEnabled(enabled, opts) {
    if (enabled) bodyEl.setAttribute("data-tree-colors", "on");
    else bodyEl.removeAttribute("data-tree-colors");
    // The switch's visible label stays "Category colors"; aria-checked alone
    // communicates on/off (the standard switch pattern), so the accessible
    // name keeps matching the visible text.
    if (colorSwitchEl) colorSwitchEl.setAttribute("aria-checked", String(enabled));
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
    if (colorSwitchEl) colorSwitchEl.addEventListener("click", onToggle);
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
  const themeSwitchEl = document.getElementById("theme-switch");

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
    if (themeSwitchEl) themeSwitchEl.setAttribute("aria-checked", String(isDark));
  }

  function initThemeToggle() {
    if (!window.XBOTheme) return;
    applyTheme(window.XBOTheme.effectiveTheme(window.localStorage, systemPrefersDark()));

    // Same state from two places: the bar's quick icon (wide screens) and
    // the settings panel's switch (every width).
    const onToggle = () => {
      const next = isDarkTheme() ? "light" : "dark";
      window.XBOTheme.writeTheme(window.localStorage, next);
      applyTheme(next);
    };
    if (themeToggleBtn) themeToggleBtn.addEventListener("click", onToggle);
    if (themeSwitchEl) themeSwitchEl.addEventListener("click", onToggle);

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
    } catch (err) {
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
        "No categories yet. Run the ingest command to fetch and sort your bookmarks.",
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
      li.append(row, childList);
    } else {
      toggle.classList.add("is-leaf");
      toggle.setAttribute("aria-hidden", "true");
      toggle.tabIndex = -1;
      row.append(toggle, button);
      li.append(row);
    }
    return li;
  }

  // ---- bookmarks ---------------------------------------------------------

  async function selectCategory(node, button) {
    if (selectedButton) selectedButton.removeAttribute("aria-current");
    button.setAttribute("aria-current", "true");
    selectedButton = button;

    if (selectedCategoryId !== node.id) saveCurrentViewToCache();
    selectedCategoryId = node.id;

    renderTitle(node.path);

    // On narrow screens the sidebar is an overlay; picking a category should
    // reveal the content it covers.
    if (drawerQuery.matches && !isCollapsed()) setCollapsed(true, { returnFocus: false });

    await showCategoryView();
  }

  /**
   * The bar's centered title. The ancestor crumb and the leaf are separate
   * spans so a long path ellipsizes the crumb (flex-shrink is weighted
   * toward it in styles.css) and keeps the leaf - the part that actually
   * names the open category - readable on the one line it gets.
   */
  function renderTitle(path) {
    titleEl.replaceChildren();
    if (path.length > 1) {
      titleEl.appendChild(el("span", "topbar-crumb", `${path.slice(0, -1).join(" › ")} › `));
    }
    titleEl.appendChild(el("span", "topbar-leaf", path[path.length - 1]));
    titleEl.title = path.join(" › ");
  }

  /** How many bookmarks match the active read-state filter in this category. */
  function filteredTotal() {
    if (readFilter === "unread") return categoryCounts.unread;
    if (readFilter === "read") return categoryCounts.total - categoryCounts.unread;
    return categoryCounts.total;
  }

  /** Count line reflecting the active filter: total when All, filtered vs total otherwise. */
  function renderCountLine() {
    const total = categoryCounts.total;
    if (readFilter === "all") {
      countEl.textContent = `${total} bookmark${total === 1 ? "" : "s"} · ${categoryCounts.unread} unread`;
    } else {
      const noun = readFilter === "unread" ? "unread" : "read";
      countEl.textContent = `${filteredTotal()} ${noun} · ${total} total`;
    }
  }

  function emptyFilterMessage() {
    if (readFilter === "unread") return "No unread bookmarks in this category.";
    if (readFilter === "read") return "No read bookmarks in this category yet.";
    return "No bookmarks are filed under this category.";
  }

  /** Fetch one page of the current category under the active filter. */
  function fetchPage(offset) {
    const url =
      `/api/categories/${selectedCategoryId}/bookmarks` +
      `?filter=${encodeURIComponent(readFilter)}&offset=${offset}`;
    return getJSON(url);
  }

  /**
   * Fetch and render the first batch of the selected category+filter,
   * resetting all paging state. Only runs on a cache miss - `showCategoryView`
   * restores instantly from `viewCaches` instead when this exact
   * category+filter was already loaded.
   */
  async function fetchAndRenderFirstPage() {
    const seq = ++requestSeq;
    teardownObserver();
    pageLoading = false;
    viewReady = false; // mid-fetch: not safe to cache until this settles
    pageOffset = 0;
    pageHasMore = false;
    currentViewBookmarks = [];
    countEl.textContent = "";
    readFilterEl.hidden = true;
    stateMessage(listEl, "loading", "Loading bookmarks…");

    let data;
    try {
      data = await fetchPage(0);
    } catch (err) {
      if (seq !== requestSeq) return; // a newer view took over
      readFilterEl.hidden = true;
      stateMessage(listEl, "error", "Could not load bookmarks for this category.");
      return;
    }
    if (seq !== requestSeq) return; // superseded while awaiting

    viewReady = true;
    categoryCounts = data.counts || { total: 0, unread: 0 };
    // Keep the category's rollup counts fresh in the cache even before this
    // view itself is saved there (e.g. a sibling filter is cached already).
    ensureCategoryCache(selectedCategoryId).counts = categoryCounts;
    pageOffset = data.offset + data.bookmarks.length;
    pageHasMore = Boolean(data.hasMore);

    // The filter bar only makes sense once a category has bookmarks at all.
    readFilterEl.hidden = categoryCounts.total === 0;

    listEl.replaceChildren();
    if (categoryCounts.total === 0) {
      countEl.textContent = "";
      stateMessage(listEl, "empty", "No bookmarks are filed under this category.");
      return;
    }
    renderCountLine();
    if (data.bookmarks.length === 0) {
      stateMessage(listEl, "empty", emptyFilterMessage());
      return;
    }
    for (const bm of data.bookmarks) {
      currentViewBookmarks.push(bm);
      listEl.appendChild(renderCard(bm));
    }
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
    } catch (err) {
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
    for (const bm of data.bookmarks) {
      currentViewBookmarks.push(bm);
      listEl.appendChild(renderCard(bm));
    }
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
    } else if (listEl.querySelector(".bookmark-card")) {
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
   * toggle, then Summarize/Summary) and a right-aligned group (delete only -
   * opening the post on X is already reachable by clicking the card/embed,
   * see #54). No author line - the embed (or the fallback's own byline)
   * already carries who posted it.
   */
  function renderCard(bm) {
    const card = el("article", "bookmark-card");
    if (!bm.read) card.classList.add("is-unread");
    card.dataset.bookmarkId = String(bm.id);

    const actions = el("div", "bookmark-actions");

    const left = el("div", "bookmark-actions-group bookmark-actions-left");
    left.appendChild(renderPill(bm, card));

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
    renderEmbed(slot, bm, () => setRead(bm, card, true));

    card.append(actions, slot);

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

  function renderEmbed(slot, bm, onOpen) {
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
    slot.append(loader, embedHost);

    let settled = false;

    function showFallback() {
      if (settled) return;
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
      slot.appendChild(fallback);
    }

    function showEmbed() {
      if (settled) return;
      settled = true;
      loader.remove(); // the rendered embed already lives in embedHost
    }

    const backstop = setTimeout(showFallback, EMBED_RENDER_TIMEOUT_MS);

    // widgets.js loads async, so on the first card it may not be ready yet.
    // Wait for it (rather than committing to the fallback) so embeds appear.
    whenWidgetsReady().then((twttr) => {
      if (settled) return;
      if (!slot.isConnected) {
        // Card was replaced (e.g. filter/category change) before we resolved;
        // stop here so the backstop can't act on a detached node.
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
          theme: isDarkTheme() ? "dark" : "light",
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
      // A read-state change can flip which cached Unread/Read filter a post
      // belongs to for every category it's filed under; keep every OTHER
      // cached view (not the one on screen, patched below) consistent.
      invalidateCachedViewsOnReadChange(bm);

      const dropsOut =
        (readFilter === "unread" && bm.read) || (readFilter === "read" && !bm.read);
      if (dropsOut) {
        // The card no longer belongs in the filtered view: drop it out. That
        // row also leaves the server-side filtered set, so shift the offset
        // back by one to keep the next batch aligned.
        card.remove();
        const idx = currentViewBookmarks.indexOf(bm);
        if (idx !== -1) currentViewBookmarks.splice(idx, 1);
        pageOffset = Math.max(0, pageOffset - 1);
        if (listEl.querySelector(".bookmark-card")) {
          renderCountLine();
          updateTail(); // keep the "N shown" end-of-list marker in step
        } else if (pageHasMore) {
          // Emptied the visible view but more remain: pull the next batch in.
          renderCountLine();
          loadMore();
        } else {
          removeTail();
          renderCountLine();
          stateMessage(listEl, "empty", emptyFilterMessage());
        }
      } else {
        card.classList.toggle("is-unread", !bm.read);
        const oldPill = card.querySelector(".read-pill");
        if (oldPill) oldPill.replaceWith(renderPill(bm, card));
        renderCountLine();
      }
    } catch (err) {
      if (pillBtn) {
        pillBtn.classList.remove("is-loading");
        pillBtn.disabled = false;
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
    const parent = card.parentNode;
    const nextSibling = card.nextSibling;
    const wasUnread = !bm.read;
    const bmIndex = currentViewBookmarks.indexOf(bm);

    card.remove();
    if (bmIndex !== -1) currentViewBookmarks.splice(bmIndex, 1);
    categoryCounts.total = Math.max(0, categoryCounts.total - 1);
    if (wasUnread && categoryCounts.unread > 0) categoryCounts.unread -= 1;
    pageOffset = Math.max(0, pageOffset - 1);
    renderCountLine();
    if (!listEl.querySelector(".bookmark-card")) {
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
      const emptyMsg = parent.querySelector(":scope > .state-empty");
      if (emptyMsg) emptyMsg.remove();
      // nextSibling may no longer be attached (e.g. the tail/sentinel was
      // replaced by that empty-state message while the card sat in its
      // toast's undo window), so fall back to appending rather than throwing.
      if (nextSibling && nextSibling.parentNode === parent) {
        parent.insertBefore(card, nextSibling);
      } else {
        parent.appendChild(card);
      }
      if (bmIndex !== -1 && bmIndex <= currentViewBookmarks.length) {
        currentViewBookmarks.splice(bmIndex, 0, bm);
      } else {
        currentViewBookmarks.push(bm);
      }
      categoryCounts.total += 1;
      if (wasUnread) categoryCounts.unread += 1;
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
      } catch (err) {
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

  function initReadFilter() {
    if (!readFilterEl) return;
    readFilterEl.querySelectorAll(".seg-input").forEach((input) => {
      input.addEventListener("change", () => {
        if (!input.checked) return;
        if (selectedCategoryId != null) saveCurrentViewToCache();
        readFilter = input.value;
        // Changing the filter re-pages the category from the top, unless
        // this exact category+filter is already cached from a prior visit.
        if (selectedCategoryId != null) showCategoryView();
      });
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

  // ---- init --------------------------------------------------------------
  initSidebar();
  initSettingsPanel();
  initTextSize();
  initThemeToggle();
  initColorToggle();
  initSearch();
  initReadFilter();
  initSummary();
  loadTree();
  loadSyncStatus();
  loadSummaryStatus();
})();
