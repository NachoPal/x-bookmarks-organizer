import { describe, expect, it } from "vitest";

// Plain browser JS, required directly (not compiled by tsc).
const { activeToken, filterSuggestions, applySuggestion } = require("./search-suggest.js");

describe("activeToken", () => {
  it("detects from:/category:/list: while typing their value", () => {
    expect(activeToken("from:karp", 9)).toEqual({ kind: "from", quoted: false, prefix: "karp", start: 0, end: 9 });
    expect(activeToken("category:AI", 11)).toMatchObject({ kind: "category", prefix: "AI" });
    expect(activeToken("list:Rea", 8)).toMatchObject({ kind: "list", prefix: "Rea" });
  });

  it("works mid-string, after other keywords", () => {
    const value = "agent harness from:karp";
    expect(activeToken(value, value.length)).toMatchObject({ kind: "from", prefix: "karp", start: 14 });
  });

  it("stays active across a space while inside an open quote", () => {
    const value = 'category:"AI Age';
    expect(activeToken(value, value.length)).toEqual({
      kind: "category",
      quoted: true,
      prefix: "AI Age",
      start: 0,
      end: value.length,
    });
  });

  it("is null once the caret has moved past the token (a later word, or after a closing quote)", () => {
    expect(activeToken("from:karp next", 14)).toBeNull();
    expect(activeToken('category:"AI" next', 19)).toBeNull();
  });

  it("is null when the caret sits in plain text with no operator", () => {
    expect(activeToken("agent harness", 13)).toBeNull();
    expect(activeToken("", 0)).toBeNull();
  });

  it("is case-insensitive on the keyword", () => {
    expect(activeToken("FROM:karp", 9)).toMatchObject({ kind: "from" });
  });
});

describe("filterSuggestions", () => {
  const names = ["karpathy", "kagi", "agent_x", "Karen"];

  it("ranks a startsWith match above a mere contains match, each group in input order", () => {
    expect(filterSuggestions(names, "ka")).toEqual(["karpathy", "kagi", "Karen"]);
  });

  it("is case-insensitive", () => {
    expect(filterSuggestions(names, "KA")).toEqual(["karpathy", "kagi", "Karen"]);
  });

  it("returns the first `max` candidates as-is for an empty prefix", () => {
    expect(filterSuggestions(names, "", 2)).toEqual(["karpathy", "kagi"]);
  });

  it("caps the result at max", () => {
    expect(filterSuggestions(names, "a", 1)).toHaveLength(1);
  });

  it("is empty for no match", () => {
    expect(filterSuggestions(names, "zzz")).toEqual([]);
  });
});

describe("applySuggestion", () => {
  it("inserts a bare username with a leading @ for from:", () => {
    const token = activeToken("from:karp", 9);
    expect(applySuggestion("from:karp", token, "karpathy")).toEqual({ value: "from:@karpathy ", caret: 15 });
  });

  it("strips a leading @ from the candidate before re-adding it", () => {
    const token = activeToken("from:karp", 9);
    expect(applySuggestion("from:karp", token, "@karpathy").value).toBe("from:@karpathy ");
  });

  it("quotes a category/list name with a space", () => {
    const value = "category:AI";
    const token = activeToken(value, value.length);
    expect(applySuggestion(value, token, "AI > Agents").value).toBe('category:"AI > Agents" ');
  });

  it("leaves a single-word category/list name bare", () => {
    const value = "list:Rea";
    const token = activeToken(value, value.length);
    expect(applySuggestion(value, token, "Saved").value).toBe("list:Saved ");
  });

  it("preserves text after the token, with no double space", () => {
    const value = "from:karp agent harness";
    const token = activeToken(value, 9);
    const result = applySuggestion(value, token, "karpathy");
    expect(result.value).toBe("from:@karpathy agent harness");
    expect(result.caret).toBe("from:@karpathy ".length);
  });
});
