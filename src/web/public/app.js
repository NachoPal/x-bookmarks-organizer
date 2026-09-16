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

  let selectedCategoryId = null;
  let selectedButton = null;
  // Manual expand/collapse state (category id -> expanded), preserved across
  // sidebar refreshes so mark-read never resets the user's browsing context.
  let expansionState = new Map();
  // Full category tree (roots) kept in memory so the search filter can
  // re-render from source without re-fetching.
  let treeRoots = [];
  // Bookmarks of the selected category, kept so the read-state filter can
  // re-render client-side without re-fetching.
  let currentBookmarks = [];
  let readFilter = "all"; // "all" | "unread" | "read"

  // ---- sidebar (collapsible) --------------------------------------------

  const bodyEl = document.body;
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
    if (!res.ok) throw new Error(`Request failed (${res.status})`);
    return res.json();
  }

  function formatDate(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  function isDarkTheme() {
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
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
    renderTree();
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
      // that transient state is not written back to expansionState.
      const expanded = searching ? true : saved !== undefined ? saved : depth < 1;
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
    countEl.textContent = "";
    stateMessage(listEl, "loading", "Loading bookmarks…");

    // On narrow screens the sidebar is an overlay; picking a category should
    // reveal the content it covers.
    if (drawerQuery.matches && !isCollapsed()) setCollapsed(true, { returnFocus: false });

    let data;
    try {
      data = await getJSON(`/api/categories/${node.id}/bookmarks`);
    } catch (err) {
      readFilterEl.hidden = true;
      stateMessage(listEl, "error", "Could not load bookmarks for this category.");
      return;
    }
    currentBookmarks = data.bookmarks || [];
    renderBookmarks();
  }

  /** Does a bookmark belong in the view under the active read-state filter? */
  function matchesFilter(bm) {
    if (readFilter === "unread") return !bm.read;
    if (readFilter === "read") return Boolean(bm.read);
    return true;
  }

  /** Render the selected category's bookmarks, filtered by read state. */
  function renderBookmarks() {
    const all = currentBookmarks;
    // The filter bar only makes sense once a category has bookmarks.
    readFilterEl.hidden = all.length === 0;
    if (all.length === 0) {
      countEl.textContent = "";
      stateMessage(listEl, "empty", "No bookmarks are filed under this category.");
      return;
    }
    const shown = all.filter(matchesFilter);
    updateCount(all, shown);
    if (shown.length === 0) {
      stateMessage(listEl, "empty", emptyFilterMessage());
      return;
    }
    listEl.replaceChildren();
    for (const bm of shown) listEl.appendChild(renderCard(bm));
  }

  /** Count line reflecting the active filter: total when All, filtered vs total otherwise. */
  function updateCount(all, shown) {
    const unread = all.filter((b) => !b.read).length;
    if (readFilter === "all") {
      countEl.textContent = `${all.length} bookmark${all.length === 1 ? "" : "s"} · ${unread} unread`;
    } else {
      const noun = readFilter === "unread" ? "unread" : "read";
      countEl.textContent = `${shown.length} ${noun} · ${all.length} total`;
    }
  }

  function emptyFilterMessage() {
    if (readFilter === "unread") return "No unread bookmarks in this category.";
    if (readFilter === "read") return "No read bookmarks in this category yet.";
    return "No bookmarks are filed under this category.";
  }

  function renderCard(bm) {
    const card = el("article", "bookmark-card");
    if (!bm.read) card.classList.add("is-unread");
    card.dataset.bookmarkId = String(bm.id);

    // Head: author + read pill
    const head = el("div", "bookmark-head");
    const author = el("span", "bookmark-author");
    author.append(document.createTextNode(bm.authorName || bm.authorUsername));
    author.appendChild(el("span", "bookmark-handle", ` @${bm.authorUsername}`));
    const pill = renderPill(bm);
    head.append(author, pill);

    // Embed slot with link fallback. Opening the fallback link also marks read.
    const slot = el("div", "embed-slot");
    renderEmbed(slot, bm, () => markRead(bm, card));

    // Foot: open link (also marks read) + mark-read button
    const foot = el("div", "bookmark-foot");
    const openLink = el("a", "link-external", "Open on X ↗");
    openLink.href = bm.url;
    openLink.target = "_blank";
    openLink.rel = "noopener noreferrer";
    openLink.addEventListener("click", () => markRead(bm, card));
    foot.appendChild(openLink);

    const readBtn = el("button", "btn btn-secondary mark-read-btn", "Mark as read");
    readBtn.type = "button";
    readBtn.addEventListener("click", () => markRead(bm, card, readBtn));
    if (bm.read) readBtn.hidden = true;
    foot.appendChild(readBtn);

    card.append(head, slot, foot);
    return card;
  }

  function renderPill(bm) {
    const pill = el("span", "read-pill");
    if (bm.read) {
      const date = formatDate(bm.readAt);
      pill.textContent = date ? `Read ${date}` : "Read";
    } else {
      pill.classList.add("is-unread");
      pill.appendChild(el("span", "dot"));
      pill.appendChild(document.createTextNode("Unread"));
    }
    return pill;
  }

  function renderEmbed(slot, bm, onOpen) {
    // Always render a text+link fallback first, then try to upgrade to the
    // official embed. Deleted/protected posts keep the fallback.
    const fallback = el("div", "embed-fallback");
    if (bm.text) fallback.appendChild(el("p", null, bm.text));
    const link = el("a", "link-external", "View this post on X ↗");
    link.href = bm.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    if (onOpen) link.addEventListener("click", onOpen);
    fallback.appendChild(link);
    slot.appendChild(fallback);

    // widgets.js loads async, so on the first card it may not be ready yet.
    // Wait for it (rather than committing to the fallback) so embeds appear.
    whenWidgetsReady().then((twttr) => {
      if (!twttr || !slot.isConnected) return; // gave up, or card replaced
      twttr.widgets
        .createTweet(bm.postId, slot, { theme: isDarkTheme() ? "dark" : "light", conversation: "none" })
        .then((embedded) => {
          if (embedded) fallback.remove(); // embed succeeded; drop the fallback
        })
        .catch(() => {
          /* keep fallback */
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

  async function markRead(bm, card, button) {
    if (bm.read) return;
    if (button) {
      button.classList.add("is-loading");
      button.disabled = true;
    }
    try {
      const data = await getJSON2(`/api/bookmarks/${bm.id}/read`);
      const updated = data.bookmark;
      bm.read = true;
      bm.readAt = updated.readAt;
      // Refresh sidebar counts so the unread badge stays accurate (preserves
      // the active search query).
      loadTree();
      if (readFilter === "unread") {
        // The card no longer belongs in the filtered view: drop it out.
        card.remove();
        if (listEl.querySelector(".bookmark-card")) {
          updateCount(currentBookmarks, currentBookmarks.filter(matchesFilter));
        } else {
          renderBookmarks(); // now-empty filtered view + its empty state/count
        }
      } else {
        card.classList.remove("is-unread");
        const head = card.querySelector(".bookmark-head");
        const oldPill = head.querySelector(".read-pill");
        if (oldPill) oldPill.replaceWith(renderPill(bm));
        const btn = card.querySelector(".mark-read-btn");
        if (btn) btn.hidden = true;
        updateCount(currentBookmarks, currentBookmarks.filter(matchesFilter));
      }
    } catch (err) {
      if (button) {
        button.classList.remove("is-loading");
        button.disabled = false;
      }
    }
  }

  // POST helper (kept separate so GET caching semantics stay obvious above).
  async function getJSON2(url) {
    const res = await fetch(url, { method: "POST" });
    if (!res.ok) throw new Error(`Request failed (${res.status})`);
    return res.json();
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
        if (selectedCategoryId != null) renderBookmarks();
      });
    });
  }

  // ---- init --------------------------------------------------------------
  initSidebar();
  initSearch();
  initReadFilter();
  loadTree();
})();
