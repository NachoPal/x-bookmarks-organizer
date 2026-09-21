"use strict";

/**
 * Pure logic for the move-to-category picker (issue #92): the modal tree the
 * owner searches, browses and selects ONE category in, as the keyboard-
 * accessible equivalent of dragging a card onto the sidebar.
 *
 * DOM-free and shared between the browser (app.js, via <script>) and Vitest,
 * the same way tree-counts.js and root-order.js are. The picker's ARIA tree is
 * a real promise - arrow keys walk the VISIBLE items, Left/Right collapse and
 * expand - and `visibleItems` + `focusTarget` are what let app.js keep that
 * promise without re-deriving "what can be reached from here" in the DOM.
 */
(function (root) {
  /**
   * A pruned copy of the tree: a node survives if its own name matches the
   * (lowercased) query or any descendant's does, so a match always keeps the
   * ancestor path that places it. Mirrors the sidebar's own filter - the
   * picker shows the same tree, so it must narrow the same way.
   */
  function filterTree(nodes, query) {
    const out = [];
    for (const node of nodes || []) {
      const kids = node.children && node.children.length ? filterTree(node.children, query) : [];
      const selfMatch = node.name.toLowerCase().includes(query);
      if (selfMatch || kids.length > 0) out.push({ ...node, children: kids });
    }
    return out;
  }

  /**
   * The items a keyboard can currently reach, top to bottom: every node, plus
   * the children of the ones `isExpanded(node)` reports open. This is the
   * order ArrowUp/ArrowDown walk, which is why a collapsed node's subtree is
   * absent rather than merely hidden.
   */
  function visibleItems(nodes, isExpanded) {
    const out = [];
    const walk = (list, depth) => {
      for (const node of list || []) {
        const hasChildren = !!(node.children && node.children.length);
        const expanded = hasChildren && isExpanded(node) === true;
        out.push({ id: node.id, node, depth, hasChildren, expanded });
        if (expanded) walk(node.children, depth + 1);
      }
    };
    walk(nodes, 0);
    return out;
  }

  /**
   * Where focus lands for a navigation key, as { id } - or null when the key
   * moves nothing (already at an end) and the caller should leave focus be.
   * ArrowLeft/ArrowRight are NOT here: they collapse/expand first and only
   * move when there is nothing to collapse or expand, which needs the
   * expansion state the caller owns (see `lateralTarget`).
   */
  function focusTarget(items, currentId, key) {
    if (items.length === 0) return null;
    const at = items.findIndex((i) => i.id === currentId);
    if (key === "Home") return items[0].id === currentId ? null : { id: items[0].id };
    if (key === "End") {
      const last = items[items.length - 1].id;
      return last === currentId ? null : { id: last };
    }
    if (key === "ArrowDown") {
      if (at === -1) return { id: items[0].id };
      return at + 1 < items.length ? { id: items[at + 1].id } : null;
    }
    if (key === "ArrowUp") {
      if (at === -1) return { id: items[items.length - 1].id };
      return at > 0 ? { id: items[at - 1].id } : null;
    }
    return null;
  }

  /**
   * What ArrowRight / ArrowLeft do on the focused item, as one of:
   *   { action: "expand" | "collapse", id }  - open or close this node
   *   { action: "focus", id }                - step to a child or the parent
   *   null                                   - nothing to do
   *
   * This is the standard tree contract: Right opens a closed parent and then
   * steps into it; Left closes an open one and otherwise climbs out.
   */
  function lateralTarget(items, currentId, key, parentIdOf) {
    const at = items.findIndex((i) => i.id === currentId);
    if (at === -1) return null;
    const item = items[at];
    if (key === "ArrowRight") {
      if (item.hasChildren && !item.expanded) return { action: "expand", id: item.id };
      if (item.hasChildren && item.expanded) {
        const child = items[at + 1];
        return child && child.depth === item.depth + 1 ? { action: "focus", id: child.id } : null;
      }
      return null;
    }
    if (key === "ArrowLeft") {
      if (item.hasChildren && item.expanded) return { action: "collapse", id: item.id };
      const parentId = parentIdOf(item.node);
      if (parentId == null) return null;
      return items.some((i) => i.id === parentId) ? { action: "focus", id: parentId } : null;
    }
    return null;
  }

  /**
   * Whether confirming would change anything. A post already filed under
   * exactly the chosen category - and nothing else - has nowhere to move, so
   * the picker disables its confirm rather than spending a round trip to
   * write the state the post is already in.
   */
  function isNoOp(selectedId, currentCategoryIds) {
    if (selectedId == null) return true;
    const ids = currentCategoryIds || [];
    return ids.length === 1 && ids[0] === selectedId;
  }

  /** The human-readable trail for a node ("AI › Evals › Harnesses"). */
  function pathLabel(node) {
    if (!node) return "";
    return (node.path && node.path.length ? node.path : [node.name]).join(" › ");
  }

  /**
   * The ids that must be open for `node` to be reachable: its ancestors,
   * nearest first. Used to reveal the destination after a move and to open a
   * search result's path.
   */
  function ancestorIds(index, id) {
    const out = [];
    let node = index.get(id);
    node = node && node.parentId != null ? index.get(node.parentId) : undefined;
    while (node) {
      out.push(node.id);
      node = node.parentId != null ? index.get(node.parentId) : undefined;
    }
    return out;
  }

  const api = {
    filterTree,
    visibleItems,
    focusTarget,
    lateralTarget,
    isNoOp,
    pathLabel,
    ancestorIds,
  };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.XBOCategoryPicker = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
