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
   * has no ranking wiring at all, then the server's own gate (ranking not
   * opted into, or the key missing), then "there is nothing to score" - which
   * is a blocker precisely because a paid run that would do nothing should
   * never be startable.
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
   * The standing line under the control: how much of the library is scored,
   * and how much a run would cover. It describes the library, not the button,
   * so it is shown whether or not a run can start.
   */
  function coverageLine(ranking) {
    var r = state(ranking);
    if (r.total === 0) return "Nothing is ranked yet.";
    if (r.scored === 0) {
      return "None of your " + plural(r.total, "bookmark", "bookmarks") + " are ranked.";
    }
    if (r.scored >= r.total && !r.pending) {
      return "All " + plural(r.total, "bookmark", "bookmarks") + " are ranked.";
    }
    return r.scored + " of " + plural(r.total, "bookmark", "bookmarks") + " are ranked.";
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

  var api = {
    rankBlocker: rankBlocker,
    canRank: canRank,
    isRunning: isRunning,
    coverageLine: coverageLine,
    confirmCost: confirmCost,
    confirmLabel: confirmLabel,
    progressLine: progressLine,
  };

  root.XBORanking = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
