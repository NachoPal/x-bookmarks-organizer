"use strict";

/**
 * Pure logic for the category editor (issue #101): the modal in which the
 * owner adds and removes categories by hand.
 *
 * DOM-free and shared between the browser (app.js, via <script>) and Vitest,
 * the same way tree-counts.js and category-picker.js are. Everything here is
 * a DECISION - is this name usable, does this delete need a confirmation,
 * what exactly does the dialog say it will destroy - kept out of app.js so it
 * can be tested without a DOM. Deleting a category permanently deletes posts,
 * so the sentences and the "when do we confirm" rule below are load-bearing,
 * not cosmetic.
 */
(function (root) {
  /**
   * Whether to skip the destructive confirmation for ordinary (non-root)
   * deletes, persisted in localStorage the same guarded way `theme.js` and
   * `post-scale.js` persist their state: private mode / blocked storage
   * throws on access, and the editor must still work there.
   */
  const SKIP_CONFIRM_KEY = "xbo:category-delete-skip-confirm";

  function readSkipConfirm(storage) {
    try {
      return storage.getItem(SKIP_CONFIRM_KEY) === "1";
    } catch (_) {
      return false; // storage blocked: fail SAFE, i.e. keep confirming
    }
  }

  function writeSkipConfirm(storage, skip) {
    try {
      if (skip) storage.setItem(SKIP_CONFIRM_KEY, "1");
      else storage.removeItem(SKIP_CONFIRM_KEY);
    } catch (_) {
      /* private mode / blocked storage: the preference simply does not stick */
    }
  }

  /**
   * The children of `parentId` in `roots` (the roots themselves when it is
   * null) - i.e. the siblings a new name has to be unique among.
   */
  function siblingsOf(roots, parentId) {
    if (parentId == null) return roots || [];
    const find = (nodes) => {
      for (const node of nodes || []) {
        if (node.id === parentId) return node.children || [];
        const hit = find(node.children);
        if (hit) return hit;
      }
      return null;
    };
    return find(roots) || [];
  }

  /**
   * Validate a typed category name against its siblings, returning either
   * `{ ok: true, name }` with the trimmed name or `{ ok: false, error }` with
   * one actionable sentence.
   *
   * The duplicate test is case-INSENSITIVE because that is how the database
   * merges sibling names (`findCategory` collates NOCASE): accepting "ai"
   * beside "AI" here would only produce a 409 from the server a moment later.
   */
  function validateName(raw, siblings) {
    const name = String(raw == null ? "" : raw).trim();
    if (!name) return { ok: false, error: "Give the category a name." };
    const lower = name.toLowerCase();
    const clash = (siblings || []).find((s) => String(s.name).toLowerCase() === lower);
    if (clash) {
      return { ok: false, error: `“${clash.name}” is already here. Pick a different name.` };
    }
    return { ok: true, name };
  }

  /**
   * Whether pressing the bin on `node` must open the destructive dialog.
   *
   * "Don't ask again" may silence an ordinary delete, but NEVER a root: a root
   * carries its whole subtree, so it is the one delete that can take a large
   * part of the library at once, and it always confirms. A node we know
   * nothing about also confirms - this fails closed, because the cost of an
   * unwanted confirmation is a click and the cost of a missing one is posts.
   */
  function needsConfirm(node, skipConfirm) {
    if (!node) return true;
    if (node.parentId == null) return true;
    return skipConfirm !== true;
  }

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  /**
   * What the confirmation states, in one sentence, from the server's preview
   * counts. Always computed from a fresh preview - the dialog never guesses -
   * and it names the POSTS that will actually be deleted, which under the
   * owner's rule is only the ones left filed nowhere else.
   */
  function confirmSentence(name, removes) {
    const counts = removes || { categories: 1, subcategories: 0, posts: 0 };
    const subs = counts.subcategories || 0;
    const posts = counts.posts || 0;
    const head = `Deleting “${name}” removes ${subs === 0 ? "it" : `it and ${plural(subs, "sub-category", "sub-categories")}`}`;
    if (posts === 0) return `${head}. No posts are deleted.`;
    return `${head}, and permanently deletes ${plural(posts, "post", "posts")}.`;
  }

  /**
   * The second line: WHICH posts go, and which do not. Only worth saying when
   * posts are actually at stake - on a delete that removes none it would be
   * noise about a thing that is not happening.
   */
  function confirmDetail(removes) {
    const posts = (removes || {}).posts || 0;
    if (posts === 0) {
      return "Every post in here is also filed under another category, so none are deleted.";
    }
    return "Only posts filed nowhere else are deleted; a post that is also in another category is kept. This cannot be undone.";
  }

  /** The destructive button's label, which restates the scope it commits to. */
  function confirmLabel(removes) {
    const posts = (removes || {}).posts || 0;
    if (posts === 0) return "Delete category";
    return `Delete and remove ${plural(posts, "post", "posts")}`;
  }

  /** The toast after a delete that went through, stating what actually went. */
  function deletedSummary(name, removed) {
    const counts = removed || { categories: 1, subcategories: 0, posts: 0 };
    const cats = counts.categories || 1;
    const posts = counts.posts || 0;
    const catPart = cats === 1 ? `Deleted “${name}”` : `Deleted “${name}” and ${plural(cats - 1, "sub-category", "sub-categories")}`;
    return posts === 0 ? `${catPart}.` : `${catPart}, and ${plural(posts, "post", "posts")}.`;
  }

  /**
   * Whether the open category survived a delete, given the ids that went. The
   * viewer falls back to its empty state when it did not - a selection
   * pointing at a category that no longer exists would page forever against a
   * 404.
   */
  function selectionSurvives(selectedId, removedCategoryIds) {
    if (selectedId == null) return true;
    return !(removedCategoryIds || []).includes(selectedId);
  }

  const api = {
    SKIP_CONFIRM_KEY,
    readSkipConfirm,
    writeSkipConfirm,
    siblingsOf,
    validateName,
    needsConfirm,
    confirmSentence,
    confirmDetail,
    confirmLabel,
    deletedSummary,
    selectionSurvives,
  };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.XBOCategoryEditor = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
