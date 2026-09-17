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

  // ---- reader (article) modal --------------------------------------------
  const readerBackdropEl = document.getElementById("reader-backdrop");
  const readerModalEl = document.getElementById("reader-modal");
  const readerTitleEl = document.getElementById("reader-title");
  const readerMetaEl = document.getElementById("reader-meta");
  const readerBodyEl = document.getElementById("reader-body");
  const readerOriginalLinkEl = document.getElementById("reader-original-link");
  const readerCloseBtn = document.getElementById("reader-close");
  let readerReturnFocusEl = null;
  // Bumped on every open so a slow in-flight fetch from a previously opened
  // article can't render into a reader that has since moved on to another one.
  let readerRequestSeq = 0;

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

  // ---- sidebar (collapsible) --------------------------------------------

  const bodyEl = document.body;
  const contentEl = document.getElementById("bookmarks"); // the scrolling pane
  const sidebarEl = document.getElementById("sidebar");
  const toggleBtn = document.getElementById("sidebar-toggle");
  const closeBtn = document.getElementById("sidebar-close");
  const backdropEl = document.getElementById("sidebar-backdrop");
  const drawerQuery = window.matchMedia("(max-width: 820px)");
  const SIDEBAR_KEY = "xbo:sidebar-collapsed";

  function readStoredCollapsed() {
    try {
      return window.localStorage.getItem(SIDEBAR_KEY) === "1";
    } catch (_) {
      return false;
    }
  }
  function storeCollapsed(collapsed) {
    try {
      window.localStorage.setItem(SIDEBAR_KEY, collapsed ? "1" : "0");
    } catch (_) {
      /* private mode / blocked storage: ignore */
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
    // The backdrop only participates in drawer (narrow) mode.
    backdropEl.hidden = !(drawerQuery.matches && visible);

    // Desktop preference persists; drawer open/close is transient per session.
    if (!drawerQuery.matches) storeCollapsed(collapsed);

    // In drawer mode, move focus with the overlay for a keyboard-friendly flow.
    if (drawerQuery.matches && !options.silent) {
      if (visible) {
        const firstNode = treeEl.querySelector(".tree-node");
        if (firstNode) firstNode.focus();
      } else if (options.returnFocus !== false) {
        toggleBtn.focus();
      }
    }
  }

  function initSidebar() {
    // Narrow viewports start with the drawer closed; wide ones honor the
    // remembered preference (open by default).
    const start = drawerQuery.matches ? true : readStoredCollapsed();
    setCollapsed(start, { silent: true });

    toggleBtn.addEventListener("click", () => setCollapsed(!isCollapsed()));
    closeBtn.addEventListener("click", () => setCollapsed(true));
    backdropEl.addEventListener("click", () => setCollapsed(true));

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && drawerQuery.matches && !isCollapsed()) {
        setCollapsed(true);
      }
    });

    // When crossing the drawer/desktop boundary, re-apply the correct default
    // so the layout never gets stuck in an odd hybrid state.
    const onModeChange = () => setCollapsed(drawerQuery.matches ? true : readStoredCollapsed(), {
      silent: true,
    });
    if (drawerQuery.addEventListener) drawerQuery.addEventListener("change", onModeChange);
    else if (drawerQuery.addListener) drawerQuery.addListener(onModeChange);
  }

  // ---- category-color toggle ---------------------------------------------
  // Lets the owner compare a plain (indentation + guide lines only) tree
  // against the per-root-hue colored one and persists the choice, so a
  // reload keeps whichever they picked. Defaults to off (the plain tree).
  const colorToggleBtn = document.getElementById("category-color-toggle");

  function isColorEnabled() {
    return bodyEl.getAttribute("data-tree-colors") === "on";
  }

  function setColorEnabled(enabled, opts) {
    if (enabled) bodyEl.setAttribute("data-tree-colors", "on");
    else bodyEl.removeAttribute("data-tree-colors");
    // The visible label stays "Colors"; aria-checked alone communicates
    // on/off to assistive tech (the standard switch pattern), so the
    // accessible name keeps matching the visible text.
    if (colorToggleBtn) colorToggleBtn.setAttribute("aria-checked", String(enabled));
    if (!(opts && opts.silent) && window.XBOTreeColor) {
      window.XBOTreeColor.writeColorEnabled(window.localStorage, enabled);
    }
  }

  function initColorToggle() {
    if (!colorToggleBtn) return;
    const stored = window.XBOTreeColor ? window.XBOTreeColor.readColorEnabled(window.localStorage) : false;
    setColorEnabled(stored, { silent: true });
    colorToggleBtn.addEventListener("click", () => setColorEnabled(!isColorEnabled()));
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

  function applyTheme(theme) {
    // The icon shown is driven by CSS off this same attribute (see
    // styles.css), so setting it here is the single source of truth for
    // both the active theme and the toggle's icon/label.
    document.documentElement.setAttribute("data-theme", theme);
    if (!themeToggleBtn) return;
    const isDark = theme === "dark";
    themeToggleBtn.setAttribute("aria-pressed", String(isDark));
    themeToggleBtn.setAttribute("aria-label", isDark ? "Switch to light theme" : "Switch to dark theme");
  }

  function initThemeToggle() {
    if (!themeToggleBtn || !window.XBOTheme) return;
    applyTheme(window.XBOTheme.effectiveTheme(window.localStorage, systemPrefersDark()));

    themeToggleBtn.addEventListener("click", () => {
      const next = isDarkTheme() ? "light" : "dark";
      window.XBOTheme.writeTheme(window.localStorage, next);
      applyTheme(next);
    });

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
    selectedCategoryId = node.id;

    titleEl.textContent = node.path.join(" › ");

    // On narrow screens the sidebar is an overlay; picking a category should
    // reveal the content it covers.
    if (drawerQuery.matches && !isCollapsed()) setCollapsed(true, { returnFocus: false });

    await loadFirstPage();
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
   * Load the first batch of the selected category, resetting all paging state.
   * Called on category select AND on filter change (which pages from the top).
   */
  async function loadFirstPage() {
    const seq = ++requestSeq;
    teardownObserver();
    pageLoading = false;
    pageOffset = 0;
    pageHasMore = false;
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

    categoryCounts = data.counts || { total: 0, unread: 0 };
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
    for (const bm of data.bookmarks) listEl.appendChild(renderCard(bm));
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
    for (const bm of data.bookmarks) listEl.appendChild(renderCard(bm));
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
   * chip, Summarize, then the article Read button) and a right-aligned group
   * (Open on X, then delete last). No author line - the embed (or the
   * fallback's own byline) already carries who posted it.
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
    summarizeBtn.appendChild(sparkleIcon());
    summarizeBtn.appendChild(document.createTextNode("Summarize"));
    if (!summaryAvailable) {
      summarizeBtn.disabled = true;
      summarizeBtn.title = summaryUnavailableReason;
    } else {
      summarizeBtn.addEventListener("click", () => openSummary(bm, summarizeBtn));
    }
    left.appendChild(summarizeBtn);

    // Gated to posts whose link actually resolved to an article (issue #26) -
    // a bare/unresolved/non-article link gets no "Read article" control.
    if (bm.hasArticle) {
      const readBtn = el("button", "link-external read-link");
      readBtn.type = "button";
      readBtn.appendChild(bookIcon());
      readBtn.appendChild(document.createTextNode("Read article"));
      readBtn.addEventListener("click", () => openReader(bm, card, readBtn));
      left.appendChild(readBtn);
    }

    const right = el("div", "bookmark-actions-group bookmark-actions-right");

    const openLink = el("a", "link-external", "Open on X ↗");
    openLink.href = bm.url;
    openLink.target = "_blank";
    openLink.rel = "noopener noreferrer";
    openLink.addEventListener("click", () => setRead(bm, card, true));
    right.appendChild(openLink);

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

    // Compact link-preview card (issue #26), gated the same way as the "Read
    // article" button above: only a confirmed article gets a preview.
    const preview = renderArticlePreview(bm, card);
    if (preview) card.appendChild(preview);

    return card;
  }

  /**
   * A compact, X-style preview card for a bookmark whose link resolved to a
   * confirmed article: thumbnail (when available) + title/description/
   * domain. The whole card is one button that opens the in-app reader, same
   * as the "Read article" action. Returns null when the bookmark has no
   * confirmed article (nothing is rendered for it, per the gating rule).
   */
  function renderArticlePreview(bm, card) {
    if (!bm.hasArticle || !bm.preview) return null;
    const preview = bm.preview;

    const btn = el("button", "article-preview");
    btn.type = "button";
    btn.setAttribute("aria-label", `Read article: ${preview.title}`);

    if (preview.image) {
      const imageWrap = el("div", "article-preview-image-wrap");
      const img = document.createElement("img");
      img.className = "article-preview-image";
      img.src = preview.image;
      img.alt = "";
      img.loading = "lazy";
      // Graceful fallback: an image that 404s/blocks just drops the thumbnail
      // rather than leaving a broken-image icon in the card.
      img.addEventListener("error", () => imageWrap.remove());
      imageWrap.appendChild(img);
      btn.appendChild(imageWrap);
    }

    const body = el("div", "article-preview-body");
    body.appendChild(el("p", "article-preview-domain", preview.siteName || preview.domain));
    body.appendChild(el("p", "article-preview-title", preview.title));
    if (preview.description) {
      body.appendChild(el("p", "article-preview-desc", preview.description));
    }
    btn.appendChild(body);

    btn.addEventListener("click", () => openReader(bm, card, btn));
    return btn;
  }

  function bookIcon() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 20 20");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.classList.add("icon-book");
    svg.innerHTML =
      '<path d="M4 4.5c0-.6.4-1 1-1h4.5v13H5a1 1 0 0 1-1-1v-11ZM15.5 3.5c.6 0 1 .4 1 1v11a1 1 0 0 1-1 1h-4.5v-13h4.5Z" ' +
      'fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />';
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
   * The read/unread status chip, also the toggle button: a click flips it.
   * Both states render as a colored dot + short label, in distinct colors;
   * the read timestamp is still stored (see `bm.readAt`) but never shown on
   * the chip itself.
   */
  function renderPill(bm, card) {
    const pill = el("button", "read-pill");
    pill.type = "button";
    pill.appendChild(el("span", "dot"));
    if (bm.read) {
      pill.classList.add("is-read");
      pill.appendChild(document.createTextNode("Read"));
      pill.setAttribute("aria-label", "Mark as unread");
    } else {
      pill.classList.add("is-unread");
      pill.appendChild(document.createTextNode("Unread"));
      pill.setAttribute("aria-label", "Mark as read");
    }
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

      const dropsOut =
        (readFilter === "unread" && bm.read) || (readFilter === "read" && !bm.read);
      if (dropsOut) {
        // The card no longer belongs in the filtered view: drop it out. That
        // row also leaves the server-side filtered set, so shift the offset
        // back by one to keep the next batch aligned.
        card.remove();
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

    card.remove();
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

  // ---- reader (article) modal ---------------------------------------------
  // Fetches and shows the extracted article for a bookmark's primary link in
  // an in-app panel: a skeleton while loading, the sanitized article content
  // on success (server-sanitized - see src/articles/fetch-article.ts - so it
  // is safe to insert as HTML here), or a clear message + the original link
  // on any failure (paywalled, blocked, dead, or not actually an article).
  function isReaderOpen() {
    return !readerModalEl.hidden;
  }

  function openReader(bm, card, triggerEl) {
    const seq = ++readerRequestSeq;
    readerReturnFocusEl = triggerEl;

    readerTitleEl.textContent = "Loading article…";
    readerMetaEl.textContent = "";
    readerMetaEl.hidden = true;
    readerOriginalLinkEl.href = bm.articleUrl;
    renderReaderLoading();

    readerBackdropEl.hidden = false;
    readerModalEl.hidden = false;
    readerCloseBtn.focus();
    document.addEventListener("keydown", onReaderKeydown);

    // Opening the reader is at least as strong a "read" signal as opening the
    // embed or the external link, so it marks the bookmark read the same way.
    setRead(bm, card, true);

    getJSON(`/api/bookmarks/${bm.id}/article`)
      .then((data) => {
        if (seq !== readerRequestSeq) return; // superseded by a newer open
        renderReaderResult(data.article, bm.articleUrl);
      })
      .catch(() => {
        if (seq !== readerRequestSeq) return;
        renderReaderFallback(
          "Couldn't load this article. Please try again, or open the original link.",
          bm.articleUrl,
        );
      });
  }

  function closeReader() {
    if (!isReaderOpen()) return;
    readerModalEl.hidden = true;
    readerBackdropEl.hidden = true;
    readerRequestSeq += 1; // discard any in-flight fetch's result
    document.removeEventListener("keydown", onReaderKeydown);
    if (readerReturnFocusEl && readerReturnFocusEl.isConnected) readerReturnFocusEl.focus();
    readerReturnFocusEl = null;
  }

  function renderReaderLoading() {
    const loading = el("div", "reader-loading");
    loading.setAttribute("role", "status");
    const spinner = el("span", "reader-spinner");
    spinner.setAttribute("aria-hidden", "true");
    loading.append(spinner, el("span", null, "Loading article…"));
    readerBodyEl.replaceChildren(loading);
  }

  function renderReaderResult(article, articleUrl) {
    if (article && article.status === "ok") {
      readerTitleEl.textContent = article.title || "Untitled article";
      if (article.siteName) {
        readerMetaEl.textContent = article.siteName;
        readerMetaEl.hidden = false;
      }
      const content = el("div", "reader-content");
      content.innerHTML = article.contentHtml || "";
      readerBodyEl.replaceChildren(content);
    } else {
      readerTitleEl.textContent = "Couldn't load article";
      renderReaderFallback(
        (article && article.reason) || "This page couldn't be read.",
        articleUrl,
      );
    }
  }

  function renderReaderFallback(message, articleUrl) {
    const fallback = el("div", "reader-fallback");
    fallback.setAttribute("role", "status");
    fallback.appendChild(el("span", "reader-fallback-icon", "📄"));
    fallback.appendChild(el("p", "reader-fallback-msg", message));
    const link = el("a", "link-external", "View original ↗");
    link.href = articleUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    fallback.appendChild(link);
    readerBodyEl.replaceChildren(fallback);
  }

  /** Tab/Shift+Tab wraps within `modalEl` while it is open (a real modal). Shared by the reader and summary modals. */
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

  function onReaderKeydown(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      closeReader();
      return;
    }
    trapModalFocus(readerModalEl, e);
  }

  function initReader() {
    readerCloseBtn.addEventListener("click", closeReader);
    readerBackdropEl.addEventListener("click", closeReader);
  }

  // ---- summary modal -------------------------------------------------------
  // Fetches (or serves from cache) an on-demand LLM summary of a bookmark's
  // content - the post text, plus its extracted article when available (see
  // the reader view above) - in a large in-app modal: a spinner while
  // generating, the summary text once ready, a clear no-token message when
  // summaries are disabled, or a retryable error on failure. Mirrors the
  // reader modal's shape and states.
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
      })
      .catch((err) => {
        if (seq !== summaryRequestSeq) return;
        if (err && err.status === 503) {
          // No provider is available at all - stop offering the control.
          summaryAvailable = false;
          if (err.body && err.body.error) summaryUnavailableReason = err.body.error;
          renderSummaryUnavailable(err.body && err.body.error);
        } else {
          // The provider is there but the call failed (CLI not logged in,
          // quota, network). Keep the button enabled and show what to fix.
          renderSummaryError(bm, err && err.body && err.body.error);
        }
      });
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
    content.textContent = record.summary;
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
        readFilter = input.value;
        // Changing the filter re-pages the category from the top.
        if (selectedCategoryId != null) loadFirstPage();
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
  initThemeToggle();
  initColorToggle();
  initSearch();
  initReadFilter();
  initReader();
  initSummary();
  loadTree();
  loadSyncStatus();
  loadSummaryStatus();
})();
