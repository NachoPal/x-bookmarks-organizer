"use strict";

/**
 * Pure helpers behind "Refresh from X" in the Sync panel and the text read
 * from images.
 *
 * The DOM-free half, in the same style as `ranking.js`: what the refresh's
 * state MEANS - whether it can be offered, what each scope costs, what the
 * confirmation must say before X bills a read, how a run's progress reads
 * (including the background OCR that follows it) - lives here and is
 * unit-tested offline. `app.js` owns only the markup.
 *
 * A refresh is a PAID X read, so `canRefresh` fails CLOSED (no state, no
 * button) and every confirmation names the price before the scope.
 *
 * Browser global (no modules in this viewer) + CommonJS export for the test.
 */
(function (root) {
  function plural(n, one, many) {
    return n + " " + (n === 1 ? one : many);
  }

  /** Cents, rounded the way an estimate must be: the upper bound never rounds down. */
  function usd(n, up) {
    var cents = up ? Math.ceil(n * 100 - 1e-9) : Math.round(n * 100);
    return "$" + (cents / 100).toFixed(2);
  }

  /** "about $0.01", "$0.30-$0.80", or "under $0.01" - from a `{ low, high }` estimate. */
  function costText(cost) {
    if (!cost) return "";
    if (cost.high < 0.005) return "under $0.01";
    var low = usd(cost.low, false);
    var high = usd(cost.high, true);
    return low === high ? "about " + low : low + "-" + high;
  }

  function estimateFor(refresh, scope) {
    return (refresh && refresh.estimates && refresh.estimates[scope]) || null;
  }

  function isRunning(refresh) {
    return !!(refresh && refresh.status && refresh.status.state === "running");
  }

  /**
   * Why a refresh cannot be started right now, or null when it can. Fails
   * closed: a viewer that reported nothing offers nothing.
   */
  function blocker(refresh) {
    if (!refresh) return "Refreshing from X is unavailable in this viewer.";
    if (!refresh.available) return refresh.reason || "Refreshing from X is unavailable in this viewer.";
    var all = estimateFor(refresh, "all");
    if (!all || all.posts === 0) return "There are no bookmarks to refresh yet. Sync first.";
    return null;
  }

  function canRefresh(refresh) {
    return blocker(refresh) === null && !isRunning(refresh);
  }

  function buttonLabel(scope) {
    return scope === "newest" ? "Test: refresh the 10 newest bookmarks" : "Refresh all bookmarks";
  }

  /** The small line under a scope's button: what it reads and what it costs. */
  function scopeLine(refresh, scope) {
    var est = estimateFor(refresh, scope);
    if (!est) return "";
    return "Reads " + plural(est.maxPostsRead, "post", "posts") + " from X · " + costText(est.cost);
  }

  function confirmTitle(scope, est) {
    if (scope === "newest") return "Refresh the " + (est ? plural(est.posts, "newest bookmark", "newest bookmarks") : "newest bookmarks") + "?";
    return "Refresh " + (est ? "all " + plural(est.posts, "bookmark", "bookmarks") : "all bookmarks") + " from X?";
  }

  /** The price first, then what is billed for. */
  function confirmCost(est) {
    var price = est ? "Estimated " + costText(est.cost) + ", billed by X. " : "Billed by X. ";
    return (
      price +
      "Reading your own bookmarks costs $0.001 per post; a post they quote may count as a $0.005 read."
    );
  }

  function confirmLabel(scope, est) {
    var n = est ? est.posts : 0;
    return n > 0 ? "Refresh " + plural(n, "bookmark", "bookmarks") : buttonLabel(scope);
  }

  /**
   * How far the library's images have been read, for the panel's status line.
   * `images` is `/api/setup`'s `refresh.images`.
   */
  function imagesLine(images) {
    if (!images) return "";
    var worker = images.worker;
    if (worker && worker.recognizer === null && images.unavailable > 0) {
      return "The text in images can't be read on this computer: no text recognizer was found.";
    }
    if (images.total === 0) return "No images found yet. A refresh picks up the images of the bookmarks you have.";
    if (worker && worker.state === "running" && worker.total > 0) {
      return "Reading the text in images: " + worker.settled + " of " + worker.total + "…";
    }
    if (images.photos === 0) return plural(images.total, "video or GIF", "videos or GIFs") + " found; only photos are read.";
    var line = "Text read from " + images.done + " of " + plural(images.photos, "image", "images");
    if (images.withText > 0) line += " (" + images.withText + " with text)";
    line += ".";
    if (images.pending > 0) line += " " + images.pending + " waiting.";
    if (images.failed > 0) line += " " + plural(images.failed, "image", "images") + " could not be read.";
    return line;
  }

  /**
   * The status the shared progress strip shows for a refresh. The job itself
   * ends once the posts are stored, but its outcome is not complete until the
   * images' text is read - so while the OCR that started after it is still
   * running, the strip stays "running" and says so.
   */
  function stripStatus(status, images) {
    if (!status) return null;
    var worker = images && images.worker;
    var reading =
      status.state === "done" &&
      !!worker &&
      worker.state === "running" &&
      (worker.startedAt || "") >= (status.startedAt || "");
    if (!reading) return status;
    return Object.assign({}, status, { state: "running", readingImages: true, worker: worker });
  }

  function progressLine(status, images) {
    if (!status) return "";
    var s = status.summary;
    if (status.readingImages) {
      var w = status.worker || {};
      return (
        "Refreshed " + plural(s ? s.refreshed : 0, "bookmark", "bookmarks") +
        " · reading the text in images" + (w.total > 0 ? ": " + w.settled + " of " + w.total : "") + "…"
      );
    }
    if (status.state === "running") {
      var messages = status.messages || [];
      return messages.length > 0 ? messages[messages.length - 1] : "Starting the refresh…";
    }
    if (status.state === "error") return status.error || "The refresh failed.";
    if (status.state === "done") {
      if (!s) return "Refresh finished.";
      var line = "Refreshed " + plural(s.refreshed, "bookmark", "bookmarks") + " · " + plural(s.imagesFound, "image", "images") + " found";
      var last = images && images.worker && images.worker.last;
      if (s.imagesFound > 0 && last && (images.worker.finishedAt || "") >= (status.finishedAt || "")) {
        line += " · text read from " + plural(images.done, "image", "images");
      }
      return line + ".";
    }
    return "";
  }

  /** Whether the panel should keep polling: a refresh or the image reading that follows it is live. */
  function needsPolling(refresh) {
    if (!refresh) return false;
    if (isRunning(refresh)) return true;
    var worker = refresh.images && refresh.images.worker;
    return !!(worker && worker.state === "running");
  }

  /** "Text in image" for the summary modal: the images that carry any words, labelled by where they are. */
  function imageTextEntries(images) {
    var counts = { post: 0, "quoted-post": 0 };
    var out = [];
    (images || []).forEach(function (img) {
      counts[img.source] = (counts[img.source] || 0) + 1;
      var alt = img.altText && img.altText.trim();
      var text = img.text && img.text.trim();
      if (!alt && !text) return;
      var kind = img.type === "photo" ? "Image" : img.type === "video" ? "Video" : "GIF";
      out.push({
        label: kind + " " + counts[img.source] + (img.source === "post" ? " in the post" : " in the quoted post"),
        altText: alt || null,
        text: text || null,
      });
    });
    return out;
  }

  function imageTextSummary(entries) {
    return entries.length === 1 ? "Text in image" : "Text in images (" + entries.length + ")";
  }

  var api = {
    costText: costText,
    blocker: blocker,
    canRefresh: canRefresh,
    isRunning: isRunning,
    buttonLabel: buttonLabel,
    scopeLine: scopeLine,
    confirmTitle: confirmTitle,
    confirmCost: confirmCost,
    confirmLabel: confirmLabel,
    imagesLine: imagesLine,
    stripStatus: stripStatus,
    progressLine: progressLine,
    needsPolling: needsPolling,
    imageTextEntries: imageTextEntries,
    imageTextSummary: imageTextSummary,
  };

  root.XBORefresh = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
