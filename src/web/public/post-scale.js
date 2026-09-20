"use strict";

/**
 * Persisted post-size preference (issue #37). Shared between the browser
 * (app.js, loaded via <script>) and Vitest (required directly from
 * post-scale.test.ts), the same way theme.js is.
 *
 * The chosen step is applied as a `--post-scale` multiplier that drives
 * `zoom` on the bookmark card. It deliberately scales the POST, not the
 * app's chrome: the owner wants the tweet bigger or smaller, and the
 * browser's own zoom already handles "make the whole app bigger".
 */
(function (root) {
  const POST_SCALE_KEY = "xbo:post-scale";
  // Small by default (owner's call): the viewer opens with compact cards, so
  // more posts fit on screen, and the control still steps up from there.
  const DEFAULT_POST_SCALE = "small";

  /**
   * The offered steps, in ascending order. `scale` feeds `--post-scale`.
   * The range is bounded by two real constraints: at the small end every
   * control in the card's action row must stay a >=24px pointer target,
   * and at the large end the card (36rem) must still fit the content
   * column (44rem) once zoomed.
   */
  const POST_SCALES = [
    { id: "small", label: "Small", scale: 0.875 },
    { id: "medium", label: "Medium", scale: 1 },
    { id: "large", label: "Large", scale: 1.15 },
  ];

  function isKnownScale(id) {
    return POST_SCALES.some((step) => step.id === id);
  }

  /**
   * The stored step id, or the default when nothing is stored, the stored
   * value is not one we offer, or storage is unavailable/throws.
   */
  function readPostScale(storage) {
    try {
      const raw = storage.getItem(POST_SCALE_KEY);
      return isKnownScale(raw) ? raw : DEFAULT_POST_SCALE;
    } catch (_) {
      return DEFAULT_POST_SCALE;
    }
  }

  /** Persist the step; an unknown id and a throwing storage are both no-ops. */
  function writePostScale(storage, id) {
    if (!isKnownScale(id)) return;
    try {
      storage.setItem(POST_SCALE_KEY, id);
    } catch (_) {
      /* private mode / blocked storage: ignore */
    }
  }

  /** The `--post-scale` multiplier for a step id (unscaled if unknown). */
  function scaleFor(id) {
    const match = POST_SCALES.find((step) => step.id === id);
    return match ? match.scale : 1;
  }

  const api = {
    POST_SCALE_KEY,
    DEFAULT_POST_SCALE,
    POST_SCALES,
    isKnownScale,
    readPostScale,
    writePostScale,
    scaleFor,
  };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.XBOPostScale = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
