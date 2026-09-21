"use strict";

/**
 * The top bar's category path, as data (issue #89).
 *
 * The bar used to print the whole ancestor path as one dead string and let CSS
 * ellipsize it, so the "…" an owner saw was a rendering artefact they could not
 * click. This module turns the same path into the pieces a real breadcrumb
 * needs: an ordered trail of {id, name} the caller can render as links, and a
 * layout that collapses the middle of a deep path into ONE overflow item whose
 * hidden ancestors are handed back so a menu can list them.
 *
 * DOM-free and unit-tested, in the same style as `tree-counts.js` and
 * `ranking.js`: `app.js` owns the markup, the menu and the focus handling;
 * every rule about WHICH segments are shown lives here.
 */
(function (root) {
  /**
   * How many segments the bar prints inline before the middle collapses.
   * Three is the standard breadcrumb-overflow shape - first, "…", last - and
   * it is also the most the one-line bar fits at a realistic category depth.
   */
  var MAX_INLINE = 3;

  /**
   * The path from the root down to `categoryId` as [{id, name}], or [] when
   * the id is unknown (a stale selection, or a tree that has not loaded).
   *
   * Walks `parentId` upward the same way `XBOTreeCounts.ancestorChainIds`
   * does, then reverses: the tree index is the only shape both need, and
   * neither has to be told a node's depth.
   */
  function trail(index, categoryId) {
    var out = [];
    var node = index && index.get ? index.get(categoryId) : undefined;
    var guard = 0;
    while (node && guard < 64) {
      out.push({ id: node.id, name: node.name });
      node = node.parentId != null ? index.get(node.parentId) : undefined;
      guard += 1;
    }
    return out.reverse();
  }

  /**
   * The segments to render, in order. Every entry is either
   * `{ kind: "crumb", id, name, current }` - one clickable category - or
   * `{ kind: "overflow", items: [...crumbs] }`, the collapsed middle of a deep
   * path whose `items` a menu reveals. The LAST crumb is the open category and
   * is marked `current`; it is still a crumb, so the caller can render it with
   * the others and only the current marker differs.
   *
   * A path short enough to fit is never collapsed: the overflow exists to keep
   * the bar on one line, not as a fixed decoration.
   */
  function layout(path, maxInline) {
    var trailList = path || [];
    var limit = typeof maxInline === "number" && maxInline >= 2 ? maxInline : MAX_INLINE;
    var crumbs = trailList.map(function (entry, i) {
      return {
        kind: "crumb",
        id: entry.id,
        name: entry.name,
        current: i === trailList.length - 1,
      };
    });
    if (crumbs.length <= limit) return crumbs;
    // First, the collapsed middle, last: `limit` only bounds what is INLINE,
    // and the overflow item is what carries everything it hid.
    var hidden = crumbs.slice(1, crumbs.length - 1);
    return [crumbs[0], { kind: "overflow", items: hidden }, crumbs[crumbs.length - 1]];
  }

  /** The whole path as one string, for the bar's `title` tooltip. */
  function pathLabel(path) {
    return (path || [])
      .map(function (entry) {
        return entry.name;
      })
      .join(" › ");
  }

  /**
   * The next index to focus in the overflow menu for a keyboard event, or null
   * when the key is not a navigation key. Wraps, so Down on the last entry
   * lands on the first - what a `role="menu"` is expected to do.
   */
  function menuMove(key, current, count) {
    if (count <= 0) return null;
    if (key === "ArrowDown") return (current + 1) % count;
    if (key === "ArrowUp") return (current - 1 + count) % count;
    if (key === "Home") return 0;
    if (key === "End") return count - 1;
    return null;
  }

  var api = { MAX_INLINE: MAX_INLINE, trail: trail, layout: layout, pathLabel: pathLabel, menuMove: menuMove };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.XBOBreadcrumb = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
