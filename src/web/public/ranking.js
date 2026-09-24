"use strict";

/**
 * Pure helpers behind the in-app "Rank now" control (issue #80).
 *
 * The DOM-free half, in the same style as `categorization.js` and
 * `tree-counts.js`: every rule about what the ranking state MEANS - whether a
 * run can be offered, what the confirmation must say before money is spent,
 * how a run's progress reads - lives here and is unit-tested offline. `app.js`
 * owns only the markup.
 *
 * The one rule worth stating out loud: ranking is PAID per token, so nothing
 * in here ever produces a "just press it" affordance. `canRank` is false
 * unless the server says a run is possible AND there is something to score,
 * and `confirmCost` always names the price before the count.
 *
 * Browser global (no modules in this viewer) + CommonJS export for the test.
 */
(function (root) {
  /** The shape `/api/setup` and `/api/rank` report, with everything missing. */
  var EMPTY = { scored: 0, total: 0, available: false, pending: 0, blocker: null, status: null };

  function state(ranking) {
    return ranking && typeof ranking === "object" ? ranking : EMPTY;
  }

  function plural(n, one, many) {
    return n + " " + (n === 1 ? one : many);
  }

  /**
   * Why a ranking run cannot start, or null when one can. In order: the viewer
   * has no ranking wiring at all, then the server's own gate (in practice the
   * missing TYPESAFE_API_KEY - ranking itself is on by default), then "there is
   * nothing to score" - which is a blocker precisely because a paid run that
   * would do nothing should never be startable.
   */
  function rankBlocker(ranking) {
    var r = state(ranking);
    if (!r.available) {
      return r.reason || "Ranking is not available in this viewer.";
    }
    if (r.blocker) return r.blocker;
    if (r.total === 0) {
      return "There are no bookmarks to rank yet. Sync your library first.";
    }
    if (!r.pending) {
      return "Every bookmark already has a score. There is nothing a new run would pay to score.";
    }
    return null;
  }

  function isRunning(ranking) {
    var status = state(ranking).status;
    return !!status && status.state === "running";
  }

  /** True only when a run is possible right now - never a default. */
  function canRank(ranking) {
    return !isRunning(ranking) && rankBlocker(ranking) === null;
  }

  /**
   * How many stored bookmarks carry no score at all.
   *
   * Derived from the setup counts and nothing else, which is what keeps the
   * notification honest: a sync that stores new bookmarks raises it the moment
   * `/api/setup` is re-read, and a finished run drops it to zero. It is
   * deliberately NOT `pending` - that is the ranker's own selection, which
   * also picks up bookmarks scored under an older rubric, and re-scoring an
   * already-judged post is not what "unranked" means to the owner.
   */
  function unrankedCount(ranking) {
    var r = state(ranking);
    return Math.max(0, (r.total || 0) - (r.scored || 0));
  }

  /**
   * Whether the ranking icon should carry its "something is unranked" dot
   * (issue #98) - in practice, right after a sync added bookmarks.
   *
   * Gated on the viewer actually HAVING the ranking wiring: a dot is an
   * invitation to act, and a viewer that cannot rank at all has nothing to
   * invite. A missing KEY is a different matter - there the dot is correct and
   * the popover explains what to fix.
   */
  function hasUnranked(ranking) {
    return state(ranking).available === true && unrankedCount(ranking) > 0;
  }

  /**
   * The standing line under the control: how much of the library still needs
   * ranking. It describes the library, not the button, so it is shown whether
   * or not a run can start - and it is phrased around what is LEFT (issue
   * #98), because that is the number the icon's dot stands for.
   */
  function coverageLine(ranking) {
    var r = state(ranking);
    if (r.total === 0) return "Nothing is ranked yet.";
    var left = unrankedCount(r);
    if (left === 0) return "All " + plural(r.total, "bookmark", "bookmarks") + " are ranked.";
    return left + " of " + plural(r.total, "bookmark", "bookmarks") + " unranked.";
  }

  /**
   * The sentence the confirmation dialog leads with. The PRICE comes first and
   * the scope second: the owner is authorizing a bill, and the number of
   * bookmarks is only how big it is.
   */
  function confirmCost(ranking) {
    var r = state(ranking);
    return (
      "This is a paid run: every bookmark is scored through the TypeSafe/Jev API, " +
      "billed per input token. " +
      plural(r.pending, "bookmark", "bookmarks") +
      " would be scored now."
    );
  }

  /** The confirm button's label, which restates the scope one last time. */
  function confirmLabel(ranking) {
    return "Rank " + plural(state(ranking).pending, "bookmark", "bookmarks");
  }

  /**
   * The blocker split in two: its leading paragraph - the one clear cause, e.g.
   * "TypeSafe API key missing…" - and everything after it, which is the
   * credential chain's list of PLACES a secret can come from.
   *
   * They are separated because they answer different questions. The cause is
   * what the panel must state outright next to the disabled button; the rest is
   * a procedure, and a procedure shown before it is asked for buries the cause
   * it explains. `app.js` renders the first as text and the second behind a
   * disclosure.
   */
  function blockerHeadline(message) {
    return String(message || "").split(/\n\s*\n/)[0].trim();
  }

  function blockerDetail(message) {
    var parts = String(message || "").split(/\n\s*\n/);
    return parts.slice(1).join("\n\n").trim();
  }

  /** The one line the progress strip shows for a ranking status, per state. */
  function progressLine(status) {
    if (!status) return "";
    if (status.state === "running") {
      var messages = status.messages || [];
      return messages.length > 0 ? messages[messages.length - 1] : "Starting the ranking run…";
    }
    if (status.state === "error") return status.error || "The ranking run failed.";
    if (status.state === "done") {
      var s = status.summary;
      if (!s) return "Ranking finished.";
      if (!s.candidates) return "Nothing to rank - every bookmark already has a score.";
      var parts = ["Ranked " + plural(s.scored, "bookmark", "bookmarks")];
      if (s.skipped) parts.push(s.skipped + " had nothing to judge");
      if (s.failed) parts.push(plural(s.failed, "failure", "failures"));
      return parts.join(", ") + "; " + plural(s.inputTokens || 0, "input token", "input tokens") + " billed.";
    }
    return "";
  }

  /**
   * Why ranking ONE post cannot start, or null when it can (issue #98).
   *
   * The same gates as a full run minus the "there is nothing to score" one:
   * that question is answered by the card itself - an empty badge is only ever
   * rendered for a bookmark with no score - so re-asking it against the
   * library-wide selection would disable the affordance on a library whose
   * only unranked post is the one being pressed.
   */
  function singleRankBlocker(ranking) {
    var r = state(ranking);
    if (!r.available) return r.reason || "Ranking is not available in this viewer.";
    return r.blocker || null;
  }

  /** The one-post confirmation: the price first, the (single) scope second. */
  function confirmCostOne() {
    return (
      "This is a paid run: this one bookmark is scored through the TypeSafe/Jev API, " +
      "billed per input token. 1 bookmark would be scored now."
    );
  }

  function confirmLabelOne() {
    return "Rank this bookmark";
  }

  /**
   * Which job owns the ONE shared progress strip (issue #98): a sync, a
   * ranking run, or a "find bookmarks" run - all one-at-a-time server jobs
   * whose progress is their own log. A RUNNING job wins; otherwise the most
   * recently started one, a tie going to the later job in the argument list.
   * Returns "sync", "rank", "find", or null when none has anything to show.
   */
  function progressSource(syncStatus, rankStatus, findStatus) {
    var live = function (s) { return s && s.state && s.state !== "idle" ? s : null; };
    var candidates = [
      { id: "sync", status: live(syncStatus) },
      { id: "rank", status: live(rankStatus) },
      { id: "find", status: live(findStatus) },
    ].filter(function (c) { return c.status; });
    if (candidates.length === 0) return null;
    var running = candidates.filter(function (c) { return c.status.state === "running"; });
    var pool = running.length > 0 ? running : candidates;
    var best = pool[0];
    for (var i = 1; i < pool.length; i++) {
      if ((pool[i].status.startedAt || "") >= (best.status.startedAt || "")) best = pool[i];
    }
    return best.id;
  }

  var api = {
    rankBlocker: rankBlocker,
    singleRankBlocker: singleRankBlocker,
    unrankedCount: unrankedCount,
    hasUnranked: hasUnranked,
    confirmCostOne: confirmCostOne,
    confirmLabelOne: confirmLabelOne,
    progressSource: progressSource,
    canRank: canRank,
    isRunning: isRunning,
    coverageLine: coverageLine,
    confirmCost: confirmCost,
    confirmLabel: confirmLabel,
    blockerHeadline: blockerHeadline,
    blockerDetail: blockerDetail,
    progressLine: progressLine,
  };

  root.XBORanking = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
