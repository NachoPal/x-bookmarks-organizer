import { describe, expect, it } from "vitest";

// Plain browser JS, required directly (not compiled by tsc).
const { rethemeAction, variantKey, parseVariantKey, MAX_POOLED_EMBEDS } = require("./embed-theme.js");

type Variant = { theme: string; fallback?: boolean; visible?: boolean };
const slot = (variants: Variant[], hidden = false) => ({ hidden, variants });
const light = (over: Partial<Variant> = {}): Variant => ({ theme: "light", visible: true, ...over });
const dark = (over: Partial<Variant> = {}): Variant => ({ theme: "dark", visible: false, ...over });

describe("rethemeAction", () => {
  it("builds the first variant for a theme this post has never been shown in", () => {
    expect(rethemeAction(slot([light()]), "dark")).toEqual({ action: "build" });
  });

  it("REVEALS an already-built variant instead of rebuilding it - toggling back never reloads", () => {
    expect(rethemeAction(slot([light(), dark()]), "dark")).toEqual({ action: "reveal", index: 1 });
    // ...and back again, with the dark one now the visible sibling.
    const shown = slot([light({ visible: false }), dark({ visible: true })]);
    expect(rethemeAction(shown, "light")).toEqual({ action: "reveal", index: 0 });
  });

  it("does nothing for a card already showing this theme's variant", () => {
    expect(rethemeAction(slot([light()]), "light")).toEqual({ action: "skip" });
  });

  it("treats a slot with no variant yet as needing one", () => {
    expect(rethemeAction(slot([]), "dark")).toEqual({ action: "build" });
    expect(rethemeAction(undefined, "dark")).toEqual({ action: "build" });
  });

  it("leaves a HIDDEN pooled card alone, so a toggle loads nothing off-screen", () => {
    // `paintViewCards` re-runs this the moment a view reveals the card, which
    // is what keeps it from ever being SHOWN under the wrong theme without
    // building a widget now for a post nobody is looking at.
    expect(rethemeAction(slot([light()], true), "dark")).toEqual({ action: "skip" });
    expect(rethemeAction(slot([light(), dark()], true), "dark")).toEqual({ action: "skip" });
  });

  it("reuses a fallback for any theme: re-running a createTweet that already failed is pure cost", () => {
    expect(rethemeAction(slot([light({ fallback: true })]), "dark")).toEqual({ action: "skip" });
    const hidden = slot([dark({ fallback: true, visible: false }), light({ visible: true })]);
    // Reached only when nothing else serves the theme, so `light` (exact) wins
    // here and the fallback is not revealed.
    expect(rethemeAction(hidden, "light")).toEqual({ action: "skip" });
  });

  it("still prefers a real embed over a fallback when an exact variant exists", () => {
    // Light rendered, dark fell back: light must keep showing the real embed.
    const onDark = slot([light({ visible: false }), dark({ fallback: true, visible: true })]);
    expect(rethemeAction(onDark, "light")).toEqual({ action: "reveal", index: 0 });
  });
});

describe("variant keys", () => {
  it("round-trips a post id and theme", () => {
    expect(variantKey(42, "dark")).toBe("42:dark");
    expect(parseVariantKey(variantKey(42, "dark"))).toEqual({ id: "42", theme: "dark" });
  });

  it("bounds the mounted embeds above the pooled-post cap, leaving room for spares", () => {
    const { MAX_POOLED_POSTS } = require("./filter-cache.js");
    // Every pooled card's VISIBLE variant is protected from eviction, so the
    // cap has to clear the post cap or nothing could ever be released; the
    // headroom above it is what bounds the spare (other-theme) copies.
    expect(MAX_POOLED_EMBEDS).toBeGreaterThan(MAX_POOLED_POSTS);
    expect(MAX_POOLED_EMBEDS).toBeLessThan(MAX_POOLED_POSTS * 2);
  });
});
