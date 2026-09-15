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

  let selectedCategoryId = null;
  let selectedButton = null;

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
    stateMessage(treeEl, "loading", "Loading categories…");
    let data;
    try {
      data = await getJSON("/api/tree");
    } catch (err) {
      stateMessage(treeEl, "error", "Could not load categories. Is the server running?");
      return;
    }
    const roots = data.tree || [];
    if (roots.length === 0) {
      stateMessage(
        treeEl,
        "empty",
        "No categories yet. Run the ingest command to fetch and sort your bookmarks.",
      );
      return;
    }
    treeEl.replaceChildren(renderNodeList(roots, 0));
    // Re-apply the current selection highlight after a refresh.
    if (selectedCategoryId != null) {
      const btn = treeEl.querySelector(`[data-category-id="${selectedCategoryId}"]`);
      if (btn) {
        btn.setAttribute("aria-current", "true");
        selectedButton = btn;
      }
    }
  }

  function renderNodeList(nodes, depth) {
    const ul = el("ul");
    for (const node of nodes) ul.appendChild(renderNode(node, depth));
    return ul;
  }

  function renderNode(node, depth) {
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

    const label = el("span", "tree-label", node.name);
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
      const childList = renderNodeList(node.children, depth + 1);
      const expanded = depth < 1; // top levels open by default
      childList.hidden = !expanded;
      toggle.setAttribute("aria-expanded", String(expanded));
      toggle.setAttribute("aria-label", `Toggle ${node.name}`);
      toggle.addEventListener("click", () => {
        const now = toggle.getAttribute("aria-expanded") !== "true";
        toggle.setAttribute("aria-expanded", String(now));
        childList.hidden = !now;
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

    let data;
    try {
      data = await getJSON(`/api/categories/${node.id}/bookmarks`);
    } catch (err) {
      stateMessage(listEl, "error", "Could not load bookmarks for this category.");
      return;
    }
    renderBookmarks(data.bookmarks || []);
  }

  function renderBookmarks(bookmarks) {
    if (bookmarks.length === 0) {
      countEl.textContent = "";
      stateMessage(listEl, "empty", "No bookmarks are filed directly under this category.");
      return;
    }
    const unread = bookmarks.filter((b) => !b.read).length;
    countEl.textContent = `${bookmarks.length} bookmark${bookmarks.length === 1 ? "" : "s"} · ${unread} unread`;
    listEl.replaceChildren();
    for (const bm of bookmarks) listEl.appendChild(renderCard(bm));
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

    if (!window.twttr || !window.twttr.widgets || !window.twttr.widgets.createTweet) return;
    window.twttr.widgets
      .createTweet(bm.postId, slot, { theme: isDarkTheme() ? "dark" : "light", conversation: "none" })
      .then((embedded) => {
        if (embedded) fallback.remove(); // embed succeeded; drop the fallback
      })
      .catch(() => {
        /* keep fallback */
      });
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
      card.classList.remove("is-unread");
      const head = card.querySelector(".bookmark-head");
      const oldPill = head.querySelector(".read-pill");
      if (oldPill) oldPill.replaceWith(renderPill(bm));
      const btn = card.querySelector(".mark-read-btn");
      if (btn) btn.hidden = true;
      // Refresh sidebar counts so the unread badge stays accurate.
      loadTree();
      updateContentCount();
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

  function updateContentCount() {
    const cards = listEl.querySelectorAll(".bookmark-card");
    const unread = listEl.querySelectorAll(".bookmark-card.is-unread").length;
    if (cards.length > 0) {
      countEl.textContent = `${cards.length} bookmark${cards.length === 1 ? "" : "s"} · ${unread} unread`;
    }
  }

  // ---- init --------------------------------------------------------------
  loadTree();
})();
