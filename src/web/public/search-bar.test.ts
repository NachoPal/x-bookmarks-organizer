import { describe, expect, it } from "vitest";

// Plain browser JS, required directly (not compiled by tsc).
const { DEBOUNCE_MS, headerText, emptyMessage, ANY_MODE_NOTE, HELP_OPERATORS } = require("./search-bar.js");

describe("headerText", () => {
  it("pluralizes and names the query", () => {
    expect(headerText(1, "rust")).toBe("1 result for rust");
    expect(headerText(3, "rust")).toBe("3 results for rust");
  });

  it("omits the query when it is empty (operators with no keywords)", () => {
    expect(headerText(5, "")).toBe("5 results");
    expect(headerText(5, "   ")).toBe("5 results");
  });

  it("clamps a negative or fractional total", () => {
    expect(headerText(-3, "x")).toBe("0 results for x");
    expect(headerText(2.9, "x")).toBe("2 results for x");
  });

  it("never double-quotes a query that already carries its own quotes (a phrase, or a quoted operator value)", () => {
    expect(headerText(1, '"sourdough bread"')).toBe('1 result for "sourdough bread"');
    expect(headerText(1, 'category:"AI > Agents"')).toBe('1 result for category:"AI > Agents"');
  });
});

describe("emptyMessage", () => {
  it("names the query, or not", () => {
    expect(emptyMessage("rust")).toBe("No results for rust.");
    expect(emptyMessage("")).toBe("No results.");
  });
});

describe("constants", () => {
  it("has a sane debounce and a help entry per operator", () => {
    expect(DEBOUNCE_MS).toBeGreaterThan(0);
    expect(typeof ANY_MODE_NOTE).toBe("string");
    expect(HELP_OPERATORS.length).toBeGreaterThan(0);
    for (const row of HELP_OPERATORS) {
      expect(row.op).toBeTruthy();
      expect(row.example).toBeTruthy();
      expect(row.detail).toBeTruthy();
    }
  });
});
