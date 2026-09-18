import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { marked } from "marked";
import createDOMPurify from "dompurify";

// Plain browser JS, required directly (not compiled by tsc).
const { renderSummaryMarkdown } = require("./render-markdown.js");

/**
 * DOMPurify needs a real DOM to sanitize against; `jsdom` gives the tests one
 * without requiring the browser vendor bundle. The renderer itself only ever
 * uses the globals loaded from `vendor/` in the browser - these are injected
 * explicitly here as its offline test seam.
 */
function deps() {
  const { window } = new JSDOM("");
  return { marked, DOMPurify: createDOMPurify(window) };
}

describe("renderSummaryMarkdown", () => {
  it("returns an empty string for empty input", () => {
    expect(renderSummaryMarkdown("", deps())).toBe("");
  });

  it("renders a lead sentence, bullets, and bold as the expected sanitized HTML", () => {
    const markdown = [
      "A short lead sentence about the post.",
      "",
      "- First **key point** here.",
      "- Second key point.",
    ].join("\n");
    const html = renderSummaryMarkdown(markdown, deps());
    expect(html).toContain("<p>A short lead sentence about the post.</p>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>First <strong>key point</strong> here.</li>");
    expect(html).toContain("<li>Second key point.</li>");
  });

  it("renders plain prose (a legacy pre-Markdown summary) as a single paragraph", () => {
    const html = renderSummaryMarkdown("Just a plain sentence, no markdown at all.", deps());
    expect(html.trim()).toBe("<p>Just a plain sentence, no markdown at all.</p>");
  });

  it("keeps a safe https link's href", () => {
    const html = renderSummaryMarkdown("See [the docs](https://example.com/docs).", deps());
    expect(html).toContain('<a href="https://example.com/docs">the docs</a>');
  });

  it("strips a script tag, an event-handler attribute, and a javascript: link from hostile output", () => {
    const hostile = [
      "Summary with an injected payload.",
      "",
      '<script>alert("xss")</script>',
      '<img src="x" onerror="alert(1)">',
      '<a href="javascript:alert(1)">click me</a>',
    ].join("\n");
    const html = renderSummaryMarkdown(hostile, deps());
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<img");
  });
});
