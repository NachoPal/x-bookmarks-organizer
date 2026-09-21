"use strict";

/**
 * What a press on a card's drag handle turns out to have been (issues #92,
 * #100). Pure and DOM-free, in the same style as scroll-top.js, because the
 * handle carries TWO gestures on one control and which one happened decides
 * whether anything is allowed to move.
 *
 * The distinction is load-bearing beyond the re-file itself: a drag needs the
 * category tree on screen as a drop target, so it opens the drawer, and a
 * PRESS must not - it opens the picker modal instead, which carries its own
 * tree. Opening the drawer at pointerdown, before the gesture had declared
 * itself, is what made a tap on a phone open the modal AND the sidebar behind
 * it (issue #100, item 4).
 */
(function (root) {
  /** Movement (px, either axis) that turns a press into a drag. */
  const SLOP_PX = 4;

  /**
   * Has the pointer travelled far enough from where it went down for this to
   * be a drag rather than a press? A missing or non-finite coordinate (a
   * synthetic event with no position) is never far enough - a gesture that
   * cannot be measured stays a press, which is the harmless outcome.
   */
  function passedSlop(origin, point, slop) {
    const limit = typeof slop === "number" && Number.isFinite(slop) ? slop : SLOP_PX;
    if (!origin || !point) return false;
    const dx = point.x - origin.x;
    const dy = point.y - origin.y;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false;
    return Math.abs(dx) > limit || Math.abs(dy) > limit;
  }

  /**
   * What to do when the pointer comes back up:
   *   "none"   - nothing happened (Escape/pointercancel, or a drag that
   *              ended off the tree)
   *   "picker" - the gesture never became a drag, so it was a press: open the
   *              picker modal, the handle's keyboard-equivalent destination
   *   "move"   - a real drag that ended on a category: re-file the post
   */
  function gestureOutcome(state) {
    const s = state || {};
    if (s.cancelled) return "none";
    if (!s.started) return "picker";
    return s.targetId == null ? "none" : "move";
  }

  const api = { SLOP_PX, passedSlop, gestureOutcome };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.XBOCardDrag = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
