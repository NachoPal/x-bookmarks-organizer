import { describe, expect, it } from "vitest";

// Plain browser JS, required directly (not compiled by tsc).
const { rethemeAction } = require("./embed-theme.js");

const slot = (over: Record<string, unknown> = {}) => ({
  stamp: "light",
  hidden: false,
  hasFallback: false,
  ...over,
});

describe("rethemeAction", () => {
  it("rebuilds a visible embed built under the other theme", () => {
    expect(rethemeAction(slot(), "dark")).toBe("rebuild");
  });

  it("does nothing for an embed already on the current theme", () => {
    expect(rethemeAction(slot({ stamp: "dark" }), "dark")).toBe("skip");
  });

  it("treats a never-mounted slot as stale", () => {
    expect(rethemeAction(slot({ stamp: undefined }), "dark")).toBe("rebuild");
    expect(rethemeAction(undefined, "dark")).toBe("rebuild");
  });

  it("leaves a HIDDEN pooled card stale, so a toggle re-fetches nothing off-screen", () => {
    // The stamp stays wrong on purpose: `paintViewCards` re-runs this the
    // moment a view reveals the card, which is what keeps it from ever being
    // SHOWN under the wrong theme without re-creating the whole pool now.
    expect(rethemeAction(slot({ hidden: true }), "dark")).toBe("skip");
  });

  it("only re-stamps a fallback: there is no embed to rebuild, and it already follows the tokens", () => {
    expect(rethemeAction(slot({ hasFallback: true }), "dark")).toBe("restamp");
  });

  it("prefers hidden over fallback - an off-screen card costs nothing either way", () => {
    expect(rethemeAction(slot({ hidden: true, hasFallback: true }), "dark")).toBe("skip");
  });
});
