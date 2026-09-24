"use strict";

/**
 * Pure helpers behind the viewer's point-of-spend notices (security review 2,
 * #19/#20): the "Paid" mark on Summarize, the summary modal's billed-retry
 * wording, and the confirmation a Sync with a per-token pass needs.
 *
 * The DOM-free half, in the same style as `ranking.js`: what the server's
 * billing descriptions MEAN and how they read lives here and is unit-tested
 * offline; `app.js` owns only the markup. The server shapes are
 * `/api/summary-status`'s `spend` and `/api/setup`'s `sync.paidPasses` (see
 * `src/web/paid-spend.ts`).
 *
 * The rule this module keeps: a per-token call is never presented as free.
 * Anything it cannot read as "not billed per token" is treated as unknown,
 * and only a spend the server described as `per-token` is ever called paid -
 * so a missing field can drop a label, but can never invent a price.
 *
 * Browser global (no modules in this viewer) + CommonJS export for the test.
 */
(function (root) {
  /** True only for a spend the server described as billed per token. */
  function isPaid(spend) {
    return !!spend && typeof spend === "object" && spend.billing === "per-token";
  }

  function formatUsd(n) {
    if (typeof n !== "number" || !isFinite(n) || n < 0) return null;
    if (Number.isInteger(n)) return "$" + n;
    return "$" + (n < 0.1 ? n.toFixed(3).replace(/0+$/, "") : n.toFixed(2).replace(/0$/, ""));
  }

  /** "$3 in / $15 out per 1M tokens", or "" when the catalog stated no price. */
  function priceText(price) {
    if (!price || typeof price !== "object") return "";
    var input = formatUsd(price.input);
    var output = formatUsd(price.output);
    if (!input || !output) return "";
    return input + " in / " + output + " out per 1M tokens";
  }

  /** "Claude Sonnet 5 (Anthropic API) via pi-ai", from a spend or a paid pass. */
  function modelText(spend) {
    if (!spend) return "";
    var model = spend.modelLabel || spend.model || "";
    var provider = spend.providerLabel || spend.providerId || "";
    // The provider's own label can be a whole phrase; its id is what the
    // console's billing line prints, so the notice matches that.
    var via = spend.providerId || provider;
    if (!model) return via;
    return via ? model + " via " + via : model;
  }

  /** The one sentence a paid summary's controls carry as their explanation. */
  function summaryCostSentence(spend) {
    if (!isPaid(spend)) return "";
    var price = priceText(spend.price);
    return (
      "Summaries are billed per token to your key: " +
      modelText(spend) +
      (price ? " (" + price + ")" : "") +
      "."
    );
  }

  /**
   * The accessible name of a Summarize button. A saved summary is always free
   * to reopen, so only the "generate one" state mentions the price.
   */
  function summarizeButtonLabel(spend, hasSummary) {
    if (hasSummary) return "Open the saved summary";
    if (!isPaid(spend)) return "Summarize";
    return "Summarize - paid. " + summaryCostSentence(spend);
  }

  /** Whether the Summarize button should wear the visible "Paid" mark. */
  function showsPaidMark(spend, hasSummary) {
    return !hasSummary && isPaid(spend);
  }

  /** The loading line while a summary is being generated. */
  function summaryLoadingText(spend) {
    return isPaid(spend) ? "Generating summary - billed per token…" : "Generating summary…";
  }

  /** The label of the summary modal's retry button. */
  function summaryRetryLabel(spend) {
    return isPaid(spend) ? "Try again - billed again" : "Try again";
  }

  /**
   * The note under a failed summary. A failure is never retried on its own
   * (the server holds it), so the owner is told that, and - when the call is
   * paid - that trying again is a second charge.
   */
  function summaryFailureNote(spend, failedAt) {
    var when = "";
    if (failedAt) {
      var ms = Date.parse(failedAt);
      if (!isNaN(ms)) {
        var mins = Math.max(0, Math.round((Date.now() - ms) / 60000));
        when = mins < 1 ? "This summary failed moments ago. " : "This summary failed " + mins + " min ago. ";
      }
    }
    var tail = isPaid(spend)
      ? "It is not retried automatically, because the failed call may already have been billed - trying again is billed again."
      : "It is not retried automatically.";
    return when + tail;
  }

  /** The paid passes of the next sync, as `/api/setup` reports them. Never null. */
  function paidPasses(setupState) {
    var sync = setupState && setupState.sync;
    var passes = sync && Array.isArray(sync.paidPasses) ? sync.paidPasses : [];
    return passes.filter(function (p) {
      return p && typeof p === "object";
    });
  }

  /** True when starting a sync must go through the paid confirmation first. */
  function syncNeedsConfirm(passes) {
    return Array.isArray(passes) && passes.length > 0;
  }

  /** The confirmation's lead sentence: the price comes before the scope. */
  function syncConfirmCost(passes) {
    var n = Array.isArray(passes) ? passes.length : 0;
    return n === 1
      ? "This sync includes a pass billed per token, to your own account."
      : "This sync includes " + n + " passes billed per token, to your own account.";
  }

  /** One pass as the confirmation lists it: what, on which model, at what price. */
  function syncPassLine(pass) {
    var price = priceText(pass && pass.price);
    return {
      label: (pass && pass.label) || "Pass",
      detail: modelText(pass) + (price ? " - " + price : ""),
    };
  }

  function syncConfirmLabel() {
    return "Start paid sync";
  }

  /**
   * What "Find bookmarks" says about the filing method it runs on (the filing
   * model, or Jev): the price when it is billed per token, otherwise which
   * model and that it is not.
   */
  function findCostSentence(spend) {
    if (!spend) return "";
    if (isPaid(spend)) {
      var price = priceText(spend.price);
      return "Billed per token to your own account: " + modelText(spend) + (price ? " (" + price + ")" : "") + ".";
    }
    var free = spend.billing === "local" ? "runs locally" : "runs on your subscription, no per-call charge";
    return "Uses your filing model, " + modelText(spend) + " - " + free + ".";
  }

  var api = {
    isPaid: isPaid,
    priceText: priceText,
    modelText: modelText,
    summaryCostSentence: summaryCostSentence,
    summarizeButtonLabel: summarizeButtonLabel,
    showsPaidMark: showsPaidMark,
    summaryLoadingText: summaryLoadingText,
    summaryRetryLabel: summaryRetryLabel,
    summaryFailureNote: summaryFailureNote,
    paidPasses: paidPasses,
    syncNeedsConfirm: syncNeedsConfirm,
    syncConfirmCost: syncConfirmCost,
    syncPassLine: syncPassLine,
    syncConfirmLabel: syncConfirmLabel,
    findCostSentence: findCostSentence,
  };

  root.XBOPaidSpend = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
