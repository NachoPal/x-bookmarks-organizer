"use strict";

/**
 * Renders a bookmark summary (Markdown text from the LLM) to sanitized HTML
 * for the summary modal. The summary is model output derived from untrusted
 * bookmark/article content, so a prompt injection could try to smuggle
 * malicious Markdown/HTML through it - this renders Markdown (never raw model
 * HTML) via `marked`, then sanitizes the resulting HTML via `DOMPurify` with a
 * tight tag/attribute allowlist and an http(s)-only URI scheme, which strips
 * scripts, event-handler attributes, inline styles, and javascript:/data:
 * links regardless of what the model produced.
 */
(function (root) {
  const ALLOWED_TAGS = [
    "p",
    "strong",
    "em",
    "ul",
    "ol",
    "li",
    "code",
    "pre",
    "a",
    "br",
    "h3",
    "h4",
  ];
  const ALLOWED_ATTR = ["href"];
  // http(s) only - blocks javascript:/data:/vbscript: etc. regardless of casing or whitespace tricks.
  const ALLOWED_URI_REGEXP = /^https?:\/\//i;

  const SANITIZE_CONFIG = {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOWED_URI_REGEXP,
  };

  /**
   * @param {string} markdown
   * @param {{ marked?: any, DOMPurify?: any }} [deps] Injection seam for
   *   offline tests (browser callers rely on the global `marked`/`DOMPurify`
   *   loaded from vendor/).
   */
  function renderSummaryMarkdown(markdown, deps) {
    const marked = (deps && deps.marked) || root.marked;
    const DOMPurify = (deps && deps.DOMPurify) || root.DOMPurify;
    if (!markdown) return "";
    const html = marked.parse(markdown, { async: false, breaks: false, gfm: true });
    return DOMPurify.sanitize(html, SANITIZE_CONFIG);
  }

  const api = { renderSummaryMarkdown, SANITIZE_CONFIG };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.renderSummaryMarkdown = renderSummaryMarkdown;
  }
})(typeof window !== "undefined" ? window : globalThis);
