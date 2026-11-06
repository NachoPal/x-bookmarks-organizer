"use strict";

/**
 * The DOM-free half of the top bar's Recategorize: the two options' words,
 * what each pass will cost, the proposal editor's edits on the in-memory
 * draft tree, the diff summary and the progress line. `app.js` owns only the
 * markup, in the same split as `category-editor.js`.
 *
 * The draft tree is the server's (`GET /api/recategorize` `draft.tree`, see
 * `src/categorize/proposal.ts`): nodes `{ id, name, sourceId, edited, locked,
 * change, children }`. Every edit here returns a NEW tree and never mutates
 * the one it was given, so a failed save can put the previous one back. The
 * server stays authoritative - it re-validates every save and, for "only add",
 * re-bases the draft on the live tree - so these rules exist to say what is
 * wrong before the round trip, in the server's own words.
 *
 * Browser global (no modules in this viewer) + CommonJS export for the test.
 */
(function (root) {
  var OPTIONS = {
    redesign: {
      title: "Propose a new tree",
      action: "Propose a new tree",
      summary:
        "Designs a complete new category tree over all your saved posts. You review and edit it - your own categories included - before anything changes.",
    },
    extend: {
      title: "Keep the tree, only add",
      action: "Propose additions",
      summary:
        "Keeps every current category exactly as it is and proposes only new ones - top-level, or inside the ones you have. You review them first.",
    },
  };

  function optionCopy(mode) {
    return OPTIONS[mode] || OPTIONS.redesign;
  }

  function plural(n, one, many) {
    return n + " " + (n === 1 ? one : many);
  }

  function priceText(spend) {
    var paid = root.XBOPaidSpend;
    return paid && spend ? paid.priceText(spend.price) : "";
  }

  function modelText(spend) {
    var paid = root.XBOPaidSpend;
    return paid && spend ? paid.modelText(spend) : "";
  }

  function isPaid(spend) {
    return !!spend && spend.billing === "per-token";
  }

  /** How a pass's calls are billed, in words; never "free" for an unknown billing. */
  function billingWords(spend) {
    if (!spend) return "billing unknown";
    if (isPaid(spend)) {
      var price = priceText(spend);
      return "billed per token to your account" + (price ? " (" + price + ")" : "");
    }
    if (spend.billing === "local") return "runs locally, no per-call charge";
    return "runs on your subscription, no per-call charge";
  }

  /** Phase 1's line: the one call that designs the proposal. */
  function proposalCostLine(cost) {
    var pass = cost && cost.taxonomy;
    if (!pass) return "";
    if (!pass.available) return pass.reason || "The taxonomy model cannot run right now.";
    return "Phase 1 (designing the proposal): " + modelText(pass.spend) + " - " + billingWords(pass.spend) + ".";
  }

  /** Phase 2's line: one filing of EVERY post, which is what makes it the big one. */
  function refileCostLine(cost, posts) {
    var pass = cost && cost.filing;
    if (!pass) return "";
    if (!pass.available) return pass.reason || "The filing method cannot run right now.";
    var count = plural(posts, "post", "posts");
    var how = isPaid(pass.spend)
      ? "billed per token for each post" + (priceText(pass.spend) ? " (" + priceText(pass.spend) + ")" : "")
      : billingWords(pass.spend);
    return "Phase 2 (re-filing all " + count + " once you accept): " + modelText(pass.spend) + " - " + how + ".";
  }

  /** A pass line for the accept confirmation's list: the model and how each post is billed. */
  function refileDetail(cost, posts) {
    var pass = cost && cost.filing;
    if (!pass || !pass.spend) return "";
    var how = isPaid(pass.spend)
      ? "billed per token for each of the " + plural(posts, "post", "posts") + (priceText(pass.spend) ? " (" + priceText(pass.spend) + ")" : "")
      : billingWords(pass.spend);
    return modelText(pass.spend) + " - " + how + ".";
  }

  /** Whether accepting would bill per token (phase 2 on a paid model, or Jev). */
  function acceptIsPaid(cost) {
    return !!cost && !!cost.filing && isPaid(cost.filing.spend);
  }

  /** The accept confirmation: the cost before the scope, then what changes. */
  function acceptConfirm(cost, posts, mode, refileOnly) {
    var paid = acceptIsPaid(cost);
    var filing = cost && cost.filing;
    var lead = paid
      ? "Re-filing " + plural(posts, "post", "posts") + " is billed per token to your own account, for each post."
      : "Re-filing " + plural(posts, "post", "posts") + " " + billingWords(filing && filing.spend) + ".";
    var scope = refileOnly
      ? "This finishes re-filing the posts the last run did not reach, into the tree you accepted."
      : mode === "extend"
        ? "The additions are added to your tree - nothing you have is renamed, moved or removed - and then every post is re-filed from scratch."
        : "Your category tree is replaced by the one you reviewed, and then every post is re-filed from scratch.";
    var note = "Posts you moved between categories by hand go wherever the filing pass puts them now. Read state, favorites, scores and summaries are kept.";
    var label = refileOnly
      ? paid ? "Re-file, paid" : "Re-file the rest"
      : paid ? "Accept and re-file, paid" : "Accept and re-file";
    return { lead: lead, scope: scope, note: note, label: label, paid: paid, detail: filing ? modelText(filing.spend) : "" };
  }

  /** The editor's compact diff, as labelled counts - each one also in words, never a bare number. */
  function diffItems(diff, mode) {
    if (!diff) return [];
    var items = [{ key: "added", count: diff.added || 0, label: (diff.added === 1 ? "category" : "categories") + " added" }];
    if (mode !== "extend") {
      items.push({ key: "removed", count: diff.removed || 0, label: "removed" });
      items.push({ key: "renamed", count: diff.renamed || 0, label: "renamed" });
      items.push({ key: "moved", count: diff.moved || 0, label: "moved" });
    }
    return items;
  }

  /** A sentence for the diff, for the announcer and for an empty proposal. */
  function diffSentence(diff, mode) {
    if (!diff) return "";
    if (mode === "extend") {
      return diff.added > 0
        ? plural(diff.added, "category", "categories") + " to add."
        : "Nothing to add: your tree already covers your posts.";
    }
    var parts = diffItems(diff, mode).map(function (i) {
      return i.count + " " + i.label;
    });
    return parts.join(", ") + ".";
  }

  /** One line for the shared progress strip. */
  function progressLine(status) {
    if (!status) return "";
    var step = status.step;
    var messages = status.messages || [];
    var last = messages.length ? messages[messages.length - 1] : "";
    if (status.state === "running") {
      if (step === "proposal") return last ? "Preparing a proposal… " + last : "Preparing a proposal…";
      return last ? "Recategorizing… " + last : "Recategorizing…";
    }
    if (status.state === "error") return status.error || "Recategorizing failed.";
    if (status.state === "done") {
      var s = status.summary || {};
      if (s.kind === "proposal") return "Your proposal is ready to review.";
      if (s.kind === "apply") {
        return "Recategorized: " + plural(s.total || 0, "post", "posts") + " filed into " + (s.mode === "extend" ? "your tree." : "the new tree.");
      }
      return "Done.";
    }
    return "";
  }

  // ---- edits on the draft tree --------------------------------------------

  function clone(nodes) {
    return (nodes || []).map(function (n) {
      var copy = {};
      for (var k in n) if (Object.prototype.hasOwnProperty.call(n, k)) copy[k] = n[k];
      copy.change = n.change ? Object.assign({}, n.change) : {};
      copy.children = clone(n.children);
      return copy;
    });
  }

  function locate(nodes, id) {
    var found = null;
    var walk = function (list, parent, depth) {
      for (var i = 0; i < list.length && !found; i++) {
        if (list[i].id === id) {
          found = { node: list[i], parent: parent, siblings: list, index: i, depth: depth };
          return;
        }
        walk(list[i].children || [], list[i], depth + 1);
      }
    };
    walk(nodes || [], null, 1);
    return found;
  }

  /** Every node with its path, by id - what the picker and the drag look nodes up in. */
  function indexTree(nodes) {
    var map = new Map();
    var walk = function (list, path, parentId) {
      for (var i = 0; i < list.length; i++) {
        var n = list[i];
        n.path = path.concat([n.name]);
        n.parentId = parentId;
        map.set(n.id, n);
        walk(n.children || [], n.path, n.id);
      }
    };
    walk(nodes || [], [], null);
    return map;
  }

  function nextId(nodes) {
    var max = 0;
    var walk = function (list) {
      for (var i = 0; i < list.length; i++) {
        if (list[i].id > max) max = list[i].id;
        walk(list[i].children || []);
      }
    };
    walk(nodes || []);
    return max + 1;
  }

  /** Whether the owner may rename, move or remove this node (extend locks what exists). */
  function isEditable(node, mode) {
    return !!node && !(mode === "extend" && node.locked);
  }

  /** The server's sibling rule, word for word: a name, unique (case-insensitively) among its siblings. */
  function nameProblem(nodes, parentId, raw, excludeId) {
    var name = String(raw == null ? "" : raw).replace(/\s+/g, " ").trim();
    if (!name) return { ok: false, error: "A category needs a name." };
    if (name.length > 120) return { ok: false, error: "Keep a category name under 120 characters." };
    var siblings = parentId == null ? nodes : ((locate(nodes, parentId) || {}).node || {}).children || [];
    var lower = name.toLowerCase();
    for (var i = 0; i < siblings.length; i++) {
      if (siblings[i].id !== excludeId && String(siblings[i].name).toLowerCase() === lower) {
        return { ok: false, error: "There is already a “" + siblings[i].name + "” here." };
      }
    }
    return { ok: true, name: name };
  }

  function rename(nodes, id, name) {
    var tree = clone(nodes);
    var here = locate(tree, id);
    if (!here) return tree;
    here.node.name = name;
    here.node.edited = true;
    return tree;
  }

  /** Add a new (owner-made) category under `parentId` (null: top level). Returns `{ tree, id }`. */
  function add(nodes, parentId, name) {
    var tree = clone(nodes);
    var id = nextId(tree);
    var node = { id: id, name: name, edited: true, sourceId: null, locked: false, change: { added: true }, children: [] };
    if (parentId == null) tree.push(node);
    else {
      var here = locate(tree, parentId);
      if (!here) return { tree: tree, id: null };
      here.node.children.push(node);
    }
    return { tree: tree, id: id };
  }

  /** Remove a node with its whole subtree. */
  function remove(nodes, id) {
    var tree = clone(nodes);
    var here = locate(tree, id);
    if (here) here.siblings.splice(here.index, 1);
    return tree;
  }

  /** Move a node (subtree included) to `{ parentId, index }` - the index NOT counting the moved node. */
  function move(nodes, id, target) {
    var tree = clone(nodes);
    var here = locate(tree, id);
    if (!here) return tree;
    here.siblings.splice(here.index, 1);
    var list = target.parentId == null ? tree : ((locate(tree, target.parentId) || {}).node || {}).children;
    if (!list) return clone(nodes);
    var at = Math.max(0, Math.min(target.index, list.length));
    list.splice(at, 0, here.node);
    return tree;
  }

  /** How many categories a node's removal takes with it. */
  function subtreeSize(node) {
    var n = 1;
    for (var i = 0; i < ((node && node.children) || []).length; i++) n += subtreeSize(node.children[i]);
    return n;
  }

  /** The tree as `PUT /api/recategorize/draft` takes it: only what the server reads. */
  function toPayload(nodes) {
    return (nodes || []).map(function (n) {
      var out = { id: n.id, name: n.name, children: toPayload(n.children) };
      if (n.sourceId != null) out.sourceId = n.sourceId;
      if (n.description) out.description = n.description;
      if (n.edited) out.edited = true;
      return out;
    });
  }

  /** The badges a row carries: what about it differs from the current tree. */
  function changeBadges(node, mode) {
    var c = (node && node.change) || {};
    var out = [];
    if (c.added) out.push({ key: "new", label: "New", title: "Not in your current tree" });
    if (mode !== "extend") {
      if (c.renamedFrom) out.push({ key: "renamed", label: "Renamed", title: "Was “" + c.renamedFrom + "”" });
      if (c.movedFrom) out.push({ key: "moved", label: "Moved", title: "Was in " + c.movedFrom.join(" › ") });
    }
    return out;
  }

  var api = {
    optionCopy: optionCopy,
    proposalCostLine: proposalCostLine,
    refileCostLine: refileCostLine,
    refileDetail: refileDetail,
    acceptIsPaid: acceptIsPaid,
    acceptConfirm: acceptConfirm,
    diffItems: diffItems,
    diffSentence: diffSentence,
    progressLine: progressLine,
    clone: clone,
    locate: locate,
    indexTree: indexTree,
    nextId: nextId,
    isEditable: isEditable,
    nameProblem: nameProblem,
    rename: rename,
    add: add,
    remove: remove,
    move: move,
    subtreeSize: subtreeSize,
    toPayload: toPayload,
    changeBadges: changeBadges,
  };

  root.XBORecategorize = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
