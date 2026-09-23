import { describe, expect, it } from "vitest";

// Plain browser JS, required directly (not compiled by tsc).
const {
  slugifyKey,
  blankDraft,
  blankDimension,
  draftFromPreset,
  copyName,
  moveItem,
  weightShares,
  validate,
  toPayload,
  canEdit,
  canDelete,
  presetLabel,
  coverageLine,
  switchWarning,
  activePreset,
  pickerEntries,
} = require("./rubric-editor.js");

/**
 * The pure half of the rubric editor (issue #102). Nothing here touches a DOM
 * or a network, and - the point of the feature's safety story - nothing here
 * can spend anything: these are the rules for AUTHORING rules.
 */

const dimension = (over: Record<string, unknown> = {}) => ({
  label: "Signal",
  instructions: "How much signal is in this post?",
  levels: ["None.", "Some.", "A lot."],
  weight: 2,
  ...over,
});

const draft = (over: Record<string, unknown> = {}) => ({
  name: "Signal only",
  dimensions: [dimension()],
  ...over,
});

describe("drafts", () => {
  it("starts a new set with one dimension and the fewest levels that say anything", () => {
    const fresh = blankDraft();
    expect(fresh.name).toBe("");
    expect(fresh.dimensions).toHaveLength(1);
    expect(blankDimension().levels).toHaveLength(2);
  });

  it("clones the built-in set rather than editing it, under a name of its own", () => {
    const builtIn = {
      id: "default",
      name: "Learning value (built-in)",
      builtIn: true,
      dimensions: [dimension({ label: undefined, id: "learning_value" })],
    };
    const copy = draftFromPreset(builtIn, [builtIn]);
    // No id: saving it CREATES a set, leaving the built-in one exactly as it
    // shipped - which is what keeps it available as the fallback.
    expect(copy.id).toBeUndefined();
    expect(copy.name).toBe("Copy of Learning value (built-in)");
    expect(copy.dimensions[0].instructions).toBe(dimension().instructions);
    // The clone is a deep copy: editing it must not reach back into the source.
    copy.dimensions[0].levels[0] = "changed";
    expect(builtIn.dimensions[0].levels[0]).toBe("None.");
  });

  it("edits a custom set in place, keeping its id", () => {
    const preset = { id: "signal", name: "Signal", builtIn: false, dimensions: [dimension()] };
    expect(draftFromPreset(preset, [preset]).id).toBe("signal");
  });

  it("steps a copy's name past one that is taken", () => {
    const presets = [{ name: "Copy of Signal" }, { name: "Copy of Signal 2" }];
    expect(copyName("Signal", presets)).toBe("Copy of Signal 3");
  });
});

describe("moveItem", () => {
  it("reorders without mutating, and does nothing at either end", () => {
    const list = ["a", "b", "c"];
    expect(moveItem(list, 0, 1)).toEqual(["b", "a", "c"]);
    expect(moveItem(list, 2, -1)).toEqual(["a", "c", "b"]);
    expect(list).toEqual(["a", "b", "c"]);
    expect(moveItem(list, 0, -1)).toEqual(list);
    expect(moveItem(list, 2, 1)).toEqual(list);
  });
});

describe("weightShares", () => {
  it("turns weights into the share of the score they actually carry", () => {
    // Only ratios matter, so "3" means nothing until it is put beside the rest.
    expect(weightShares([{ weight: 3 }, { weight: 1 }])).toEqual([75, 25]);
    expect(weightShares([{ weight: 2 }, { weight: 2 }])).toEqual([50, 50]);
  });

  it("reports 0 rather than NaN for a weight that is not yet a number", () => {
    expect(weightShares([{ weight: 1 }, { weight: "" }])).toEqual([100, 0]);
    expect(weightShares([])).toEqual([]);
    expect(weightShares([{ weight: 0 }])).toEqual([0]);
  });
});

describe("validate", () => {
  it("accepts a well-formed draft", () => {
    expect(validate(draft(), [])).toEqual([]);
  });

  it("rejects an unnamed draft and a name another set already holds", () => {
    expect(validate(draft({ name: "  " }), []).join(" ")).toMatch(/give these/i);
    expect(validate(draft(), [{ name: "signal only" }]).join(" ")).toMatch(/already called/i);
  });

  it("rejects no dimensions, an empty question, too few levels and a bad weight", () => {
    expect(validate(draft({ dimensions: [] }), []).join(" ")).toMatch(/at least one dimension/i);
    expect(validate(draft({ dimensions: [dimension({ instructions: " " })] }), []).join(" ")).toMatch(
      /needs a question/i,
    );
    expect(validate(draft({ dimensions: [dimension({ levels: ["only"] })] }), []).join(" ")).toMatch(
      /at least 2 levels/i,
    );
    // A blank level does not count towards the minimum.
    expect(validate(draft({ dimensions: [dimension({ levels: ["a", "  "] })] }), []).join(" ")).toMatch(
      /at least 2 levels/i,
    );
    expect(validate(draft({ dimensions: [dimension({ weight: 0 })] }), []).join(" ")).toMatch(
      /greater than zero/i,
    );
  });

  it("rejects two dimensions that would share a key", () => {
    const errors = validate(
      draft({ dimensions: [dimension(), dimension({ instructions: "Another?" })] }),
      [],
    );
    expect(errors.join(" ")).toMatch(/same key/i);
  });

  it("honours the limits the server reports", () => {
    const state = { limits: { maxDimensions: 1, minLevels: 2, maxLevels: 3 } };
    expect(validate(draft({ dimensions: [dimension(), dimension({ label: "Other" })] }), [], state).join(" ")).toMatch(
      /limit is 1/,
    );
    expect(
      validate(draft({ dimensions: [dimension({ levels: ["a", "b", "c", "d"] })] }), [], state).join(" "),
    ).toMatch(/limit is 3/);
  });

  it("reports every problem at once", () => {
    expect(validate({ name: "", dimensions: [{ levels: [], weight: 0 }] }, []).length).toBeGreaterThanOrEqual(4);
  });
});

describe("toPayload", () => {
  it("derives the key from the label, trims, and drops empty levels", () => {
    const payload = toPayload(
      draft({ dimensions: [dimension({ label: " Signal density! ", levels: ["  a ", "", " b"] })] }),
    );
    expect(payload.dimensions[0].id).toBe("signal_density");
    expect(payload.dimensions[0].levels).toEqual(["a", "b"]);
    expect(payload.dimensions[0].weight).toBe(2);
  });

  it("keeps an explicit key over the label, so renaming a dimension keeps its breakdown", () => {
    const payload = toPayload(draft({ dimensions: [dimension({ id: "signal", label: "Renamed" })] }));
    expect(payload.dimensions[0].id).toBe("signal");
  });

  it("slugifies the same way the server does", () => {
    expect(slugifyKey("Signal density!")).toBe("signal_density");
    expect(slugifyKey("__")).toBe("");
  });
});

describe("what the list says about each set", () => {
  const builtIn = { id: "default", name: "Learning value (built-in)", builtIn: true, scored: 0 };
  const custom = { id: "signal", name: "Signal", builtIn: false, scored: 12 };

  it("never offers to edit or delete the built-in set - it is the fallback", () => {
    expect(canEdit(builtIn)).toBe(false);
    expect(canDelete(builtIn)).toBe(false);
    expect(canEdit(custom)).toBe(true);
    expect(canDelete(custom)).toBe(true);
    // Fails closed: an unknown row is not editable either.
    expect(canEdit(undefined)).toBe(false);
  });

  it("labels the built-in set as built-in, without saying it twice", () => {
    expect(presetLabel(builtIn)).toBe("Learning value (built-in)");
    expect(presetLabel({ id: "default", name: "Default", builtIn: true })).toBe("Default (built-in)");
    expect(presetLabel(custom)).toBe("Signal");
  });

  it("states coverage PER SET, because that is what a switch changes", () => {
    expect(coverageLine(custom, 55)).toBe("12 of 55 bookmarks ranked under these rules.");
    expect(coverageLine(builtIn, 55)).toBe("Nothing ranked under these rules yet.");
    expect(coverageLine({ scored: 55 }, 55)).toBe("All 55 bookmarks ranked under these rules.");
    expect(coverageLine(custom, 0)).toBe("No bookmarks to rank yet.");
  });

  it("says what switching would leave unranked, and says the switch itself is free", () => {
    const warning = switchWarning(custom, 55);
    expect(warning).toMatch(/43 bookmarks would read as unranked/);
    expect(warning).toMatch(/costs nothing/);
    // Nothing to warn about when the set already covers the library.
    expect(switchWarning({ scored: 55 }, 55)).toBeNull();
    expect(switchWarning(custom, 0)).toBeNull();
  });

  it("finds the active set out of a /api/rubric payload", () => {
    const state = { activeId: "signal", presets: [builtIn, custom] };
    expect(activePreset(state)!.id).toBe("signal");
    expect(activePreset({ activeId: "gone", presets: [] })).toBeUndefined();
    expect(activePreset(undefined)).toBeUndefined();
  });
});

describe("pickerEntries (the ranking panel's active-rules picker)", () => {
  const builtIn = { id: "default", name: "Learning value (built-in)", builtIn: true, scored: 0, dimensions: [dimension()] };
  const custom = {
    id: "signal",
    name: "Signal",
    builtIn: false,
    scored: 12,
    dimensions: [dimension(), dimension({ label: "Depth" })],
  };
  const state = { activeId: "signal", presets: [builtIn, custom], total: 55 };

  it("lists every saved set, badging the active one", () => {
    const entries = pickerEntries(state, "");
    expect(entries.map((e) => e.value)).toEqual(["default", "signal"]);
    expect(entries.find((e) => e.value === "signal")!.badge).toBe("Active");
    expect(entries.find((e) => e.value === "default")!.badge).toBe("");
  });

  it("filters by name, the same way the model picker's own entries do", () => {
    expect(pickerEntries(state, "signal").map((e) => e.value)).toEqual(["signal"]);
    expect(pickerEntries(state, "nothing matches this")).toEqual([]);
  });

  it("carries the question count and coverage as the entry's meta", () => {
    const entry = pickerEntries(state, "").find((e) => e.value === "signal")!;
    expect(entry.meta).toBe("2 questions · 12 of 55 bookmarks ranked under these rules.");
  });

  it("hints at what switching to a set would leave unranked, falling back to its coverage", () => {
    const entries = pickerEntries(state, "");
    expect(entries.find((e) => e.value === "signal")!.hint).toMatch(/43 bookmarks would read as unranked/);
    // Nothing left to warn about: the hint falls back to a plain statement.
    const fullyRanked = { activeId: "signal", presets: [builtIn, { ...custom, scored: 55 }], total: 55 };
    expect(pickerEntries(fullyRanked, "").find((e) => e.value === "signal")!.hint).toBe(
      "All 55 bookmarks ranked under these rules.",
    );
  });

  it("degrades to an empty list rather than throwing on an empty payload", () => {
    expect(pickerEntries(undefined, "")).toEqual([]);
    expect(pickerEntries({}, "")).toEqual([]);
  });
});
