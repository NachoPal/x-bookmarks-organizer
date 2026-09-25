"use strict";

/**
 * Pure tree arithmetic for moving a category by hand - reorder among its
 * siblings at any depth, or re-parent it (subtree included) under another
 * category or to the top level - from a drag in the sidebar or the category
 * editor, from the keyboard on a drag handle, or from the "Move to…" picker.
 *
 * DOM-free and shared between the browser (app.js, via <script>) and Vitest,
 * the same way tree-counts.js is. A target is always `{ parentId, index }`:
 * the new parent (null: the top level) and the index among that parent's
 * children NOT counting the moved node - exactly the body of
 * `PUT /api/categories/:id/position`. The server (`src/categorize/move.ts`)
 * stays authoritative; `problemFor` mirrors its refusals WORD FOR WORD, so the
 * drag can say "can't drop here" before any round trip and the two never
 * disagree about why.
 */
(function (root) {
  /**
   * Where `id` sits: its node, its parent (null for a root), its sibling list
   * (the node included), its index there, and its depth (a root is 1). Null
   * for an id that is not in the tree.
   */
  function locate(roots, id) {
    let found = null;
    const walk = (list, parent, depth) => {
      for (let i = 0; i < (list || []).length && !found; i += 1) {
        const node = list[i];
        if (node.id === id) {
          found = { node, parent, siblings: list, index: i, depth };
          return;
        }
        walk(node.children, node, depth + 1);
      }
    };
    walk(roots, null, 1);
    return found;
  }

  /** How many levels a subtree spans: a leaf is 1. */
  function height(node) {
    let deepest = 0;
    for (const child of (node && node.children) || []) deepest = Math.max(deepest, height(child));
    return deepest + 1;
  }

  /** Whether `candidateId` is `node` itself or anywhere inside it. */
  function contains(node, candidateId) {
    if (!node) return false;
    if (node.id === candidateId) return true;
    return (node.children || []).some((child) => contains(child, candidateId));
  }

  /** The children of `parentId` (null: the roots), `excludeId` left out. */
  function childrenOf(roots, parentId, excludeId) {
    const list = parentId == null ? roots : ((locate(roots, parentId) || {}).node || {}).children;
    return (list || []).filter((n) => n.id !== excludeId);
  }

  /**
   * Why moving `id` under `parentId` would be refused, as `{ problem,
   * message }` - or null when it is allowed. The same three rules, in the same
   * order and words, as the server: a cycle, a move that makes the tree
   * deeper than `maxDepth` (and deeper than it already is), a name clash with
   * a sibling under the new parent.
   */
  function problemFor(roots, id, parentId, maxDepth) {
    const here = locate(roots, id);
    if (!here) return { problem: "not-found", message: "That category is no longer here. Reload and try again." };
    const parent = parentId == null ? null : locate(roots, parentId);
    if (parentId != null && !parent) {
      return { problem: "bad-parent", message: "That category is no longer here. Reload and try again." };
    }
    const name = here.node.name;
    if (parent && contains(here.node, parentId)) {
      return {
        problem: "cycle",
        message: `“${name}” can’t go inside itself or one of its own sub-categories.`,
      };
    }
    const levels = height(here.node);
    const newDeepest = (parent ? parent.depth : 0) + levels;
    const oldDeepest = here.depth - 1 + levels;
    if (Number.isFinite(maxDepth) && newDeepest > maxDepth && newDeepest > oldDeepest) {
      return {
        problem: "depth",
        message: `That would make the tree ${newDeepest} levels deep; categories go at most ${maxDepth} levels deep.`,
      };
    }
    const lower = String(name).toLowerCase();
    const clash = childrenOf(roots, parentId, id).find((n) => String(n.name).toLowerCase() === lower);
    if (clash) {
      return {
        problem: "clash",
        message: parent
          ? `“${parent.node.name}” already has a category called “${clash.name}”.`
          : `There is already a top-level category called “${clash.name}”.`,
      };
    }
    return null;
  }

  /** Whether the target would leave `id` exactly where it is. */
  function isNoOp(roots, id, target) {
    const here = locate(roots, id);
    if (!here || !target) return true;
    const currentParent = here.parent ? here.parent.id : null;
    const wantedParent = target.parentId == null ? null : target.parentId;
    if (currentParent !== wantedParent) return false;
    const max = here.siblings.length - 1;
    return Math.min(Math.max(0, target.index), max) === here.index;
  }

  /**
   * Which part of a row the pointer is over: the top quarter drops BEFORE it,
   * the bottom quarter AFTER it, the middle INSIDE it.
   */
  function dropZone(top, rowHeight, pointerY) {
    if (!(rowHeight > 0)) return "inside";
    const at = (pointerY - top) / rowHeight;
    if (at < 0.25) return "before";
    if (at > 0.75) return "after";
    return "inside";
  }

  /**
   * The target a drop on row `overId` in `zone` means for dragged `id`, or
   * null when there is none (the row is the dragged one, or gone). AFTER an
   * expanded node whose children show right beneath it reads as "first child",
   * since that is where the line is drawn.
   */
  function dropTarget(roots, id, overId, zone, overExpanded) {
    if (overId === id) return null;
    const over = locate(roots, overId);
    if (!over) return null;
    if (zone === "inside") return { parentId: overId, index: childrenOf(roots, overId, id).length };
    const parentId = over.parent ? over.parent.id : null;
    if (zone === "after" && overExpanded && childrenOf(roots, overId, id).length > 0) {
      return { parentId: overId, index: 0 };
    }
    const siblings = childrenOf(roots, parentId, id);
    const at = siblings.findIndex((n) => n.id === overId);
    return { parentId, index: zone === "before" ? at : at + 1 };
  }

  /**
   * What an arrow key on a focused drag handle does, as a target - or null
   * when that direction goes nowhere (already first/last, a root has no
   * parent to leave, nothing above to go into):
   *   ArrowUp / ArrowDown   one step among the siblings
   *   ArrowLeft             out of the parent, to just after it
   *   ArrowRight            into the sibling above, as its last child
   * Together these reach every place in the tree, one key at a time.
   */
  function keyboardTarget(roots, id, key) {
    const here = locate(roots, id);
    if (!here) return null;
    const parentId = here.parent ? here.parent.id : null;
    if (key === "ArrowUp") return here.index > 0 ? { parentId, index: here.index - 1 } : null;
    if (key === "ArrowDown") {
      return here.index < here.siblings.length - 1 ? { parentId, index: here.index + 1 } : null;
    }
    if (key === "ArrowLeft") {
      if (!here.parent) return null;
      const up = locate(roots, here.parent.id);
      return { parentId: up.parent ? up.parent.id : null, index: up.index + 1 };
    }
    if (key === "ArrowRight") {
      if (here.index === 0) return null;
      const prev = here.siblings[here.index - 1];
      return { parentId: prev.id, index: childrenOf(roots, prev.id, id).length };
    }
    return null;
  }

  /** Why an arrow key went nowhere, in words the announcer can say. */
  function keyboardEdge(roots, id, key) {
    const here = locate(roots, id);
    const name = here ? `“${here.node.name}”` : "It";
    if (key === "ArrowUp") return `${name} is already first.`;
    if (key === "ArrowDown") return `${name} is already last.`;
    if (key === "ArrowLeft") return `${name} is already a top-level category.`;
    return `${name} has no category above it to go into.`;
  }

  /** Where a node is, in words: "3 of 5 in “AI”" or "2 of 4 at the top level". */
  function placeLabel(roots, id) {
    const here = locate(roots, id);
    if (!here) return "";
    const where = here.parent ? `in “${here.parent.name}”` : "at the top level";
    return `${here.index + 1} of ${here.siblings.length} ${where}`;
  }

  /**
   * The same move backwards: where `id` is NOW, as a target - taken BEFORE a
   * move, it is what Undo sends to put the category back.
   */
  function currentPlace(roots, id) {
    const here = locate(roots, id);
    if (!here) return null;
    return { parentId: here.parent ? here.parent.id : null, index: here.index };
  }

  /** Ids of every node on the path to `id`, root first, `id` excluded. */
  function ancestorIds(roots, id) {
    const out = [];
    let here = locate(roots, id);
    while (here && here.parent) {
      out.unshift(here.parent.id);
      here = locate(roots, here.parent.id);
    }
    return out;
  }

  const api = {
    locate,
    height,
    contains,
    childrenOf,
    problemFor,
    isNoOp,
    dropZone,
    dropTarget,
    keyboardTarget,
    keyboardEdge,
    placeLabel,
    currentPlace,
    ancestorIds,
  };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.XBOTreeMove = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
