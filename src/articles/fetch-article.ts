import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import sanitizeHtml from 'sanitize-html';

// linkedom's type declarations only expose `parseHTML(html)`, but its runtime
// implementation also accepts a `globals` second argument used to seed
// `defaultView` (see the comment at its call site below); this project also
// has no DOM lib, so `Document` isn't an ambient type Readability's own
// declaration can resolve against. Both are cast through `any` at the single
// call site rather than widening the project's lib config for one module.
type ParseHTMLWithGlobals = (html: string, globals?: { location?: URL }) => { document: unknown };
const parseHTMLWithGlobals = parseHTML as unknown as ParseHTMLWithGlobals;

/** Successful extraction: a clean title + sanitized body HTML ready to render. */
export interface ArticleExtractionOk {
  status: 'ok';
  title: string;
  contentHtml: string;
  excerpt: string | null;
  siteName: string | null;
  /**
   * OpenGraph-style preview fields (issue #26), scraped from the same parsed
   * document - a link preview card prefers these over `title`/`excerpt`/
   * `siteName` when present, since they're purpose-built for social/preview
   * cards and often cleaner. Optional so callers that don't care about the
   * preview (existing fixtures/tests) don't need to supply them; absent on a
   * page with no OpenGraph tags.
   */
  ogTitle?: string | null;
  ogDescription?: string | null;
  ogImage?: string | null;
  ogSiteName?: string | null;
}

/** A failure the reader view surfaces as a message + link to the original, never a crash. */
export interface ArticleExtractionFailed {
  status: 'failed';
  reason: string;
}

export type ArticleExtractionResult = ArticleExtractionOk | ArticleExtractionFailed;

/** Minimal surface the caller needs, kept as an interface so tests can inject a fake. */
export interface ArticleFetcher {
  fetch(url: string): Promise<ArticleExtractionResult>;
}

// A self-identifying bot UA (e.g. "XBookmarksOrganizer/1.0") gets 404'd or
// 403'd outright by some sites' basic anti-scraping checks, even though the
// page resolves fine for a real browser and this is a personal, single-user
// fetch of a link the owner bookmarked. A realistic desktop browser UA avoids
// that false-positive block (issue #28).
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 10_000;
const MIN_TEXT_LENGTH = 200;

// A URL whose (possibly redirected-to) host is one of these is a link back to
// a post, not an article - shown as "not an article" instead of a fetch
// failure. `t.co` is deliberately NOT here: every link in a post's text is
// t.co-shortened, including genuine article links, so it must always be
// followed - only the host it redirects TO is meaningful.
const NON_ARTICLE_HOSTS = new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com']);

const NOT_AN_ARTICLE_REASON = 'This link points to a post on X, not an article.';

/** Only the tags/attributes a reader view needs to render body copy safely. */
const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'p', 'br', 'hr', 'a', 'strong', 'em', 'b', 'i', 'u', 's', 'mark',
    'blockquote', 'code', 'pre',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li',
    'img', 'figure', 'figcaption',
    'table', 'thead', 'tbody', 'tr', 'td', 'th',
    'span', 'div',
  ],
  allowedAttributes: {
    a: ['href', 'title'],
    img: ['src', 'alt', 'title'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  // Untrusted content opens in a new tab so it never navigates the app away.
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer', target: '_blank' }),
  },
};

function safeHostname(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Longest a preview title/description is allowed to render as, untrusted page content. */
const MAX_OG_TEXT_LENGTH = 300;

/** Collapse whitespace, trim, and cap length; null for empty/missing input. */
function cleanOgText(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (!collapsed) return null;
  return collapsed.length > MAX_OG_TEXT_LENGTH
    ? `${collapsed.slice(0, MAX_OG_TEXT_LENGTH - 1)}…`
    : collapsed;
}

/** Resolve a possibly-relative image URL against the page URL, http(s) only. */
function resolveOgImage(raw: string | null | undefined, baseUrl: string): string | null {
  if (!raw || !raw.trim()) return null;
  try {
    const resolved = new URL(raw.trim(), baseUrl);
    return resolved.protocol === 'http:' || resolved.protocol === 'https:' ? resolved.href : null;
  } catch {
    return null;
  }
}

interface MinimalElement {
  getAttribute(name: string): string | null;
}
interface MinimalDocument {
  querySelector(selector: string): MinimalElement | null;
}

/** First non-empty `content` attribute across the given meta selectors, tried in order. */
function metaContent(document: MinimalDocument, selectors: string[]): string | null {
  for (const selector of selectors) {
    const content = document.querySelector(selector)?.getAttribute('content');
    if (content && content.trim()) return content;
  }
  return null;
}

interface OpenGraphData {
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
}

/**
 * Scrape OpenGraph-style preview metadata (title/description/image/site name)
 * from an already-parsed document, for the link-preview card (issue #26).
 * Falls back to the plain `<meta name="description">` when a page has no
 * `og:description`; there is no non-OG fallback for image/site name since
 * those have no standard non-OG equivalent.
 */
function extractOpenGraph(document: MinimalDocument, baseUrl: string): OpenGraphData {
  return {
    title: cleanOgText(metaContent(document, ['meta[property="og:title"]', 'meta[name="og:title"]'])),
    description: cleanOgText(
      metaContent(document, [
        'meta[property="og:description"]',
        'meta[name="og:description"]',
        'meta[name="description"]',
      ]),
    ),
    image: resolveOgImage(metaContent(document, ['meta[property="og:image"]', 'meta[name="og:image"]']), baseUrl),
    siteName: cleanOgText(metaContent(document, ['meta[property="og:site_name"]', 'meta[name="og:site_name"]'])),
  };
}

/**
 * Pure extraction step: given already-fetched HTML, run readability + sanitize.
 * Kept separate from the network fetch so it can be tested offline against
 * fixture HTML with no real request involved.
 */
export function extractArticle(html: string, url: string): ArticleExtractionResult {
  let parsed;
  let document: unknown;
  try {
    // linkedom resolves relative <a>/<img> URLs (and Readability's own
    // baseURI lookups) off `defaultView.location.href`, not a plain `url`
    // option - see linkedom's Node#baseURI getter.
    const parsedDoc = parseHTMLWithGlobals(html, { location: new URL(url) });
    document = parsedDoc.document;
    parsed = new Readability(document as any).parse();
  } catch {
    return { status: 'failed', reason: 'Could not parse this page as an article.' };
  }

  if (!parsed || !parsed.content || (parsed.textContent ?? '').trim().length < MIN_TEXT_LENGTH) {
    return { status: 'failed', reason: 'This page does not look like a readable article.' };
  }

  const og = extractOpenGraph(document as MinimalDocument, url);

  return {
    status: 'ok',
    title: parsed.title?.trim() || 'Untitled article',
    contentHtml: sanitizeHtml(parsed.content, SANITIZE_OPTIONS),
    excerpt: parsed.excerpt?.trim() || null,
    siteName: parsed.siteName?.trim() || null,
    ogTitle: og.title,
    ogDescription: og.description,
    ogImage: og.image,
    ogSiteName: og.siteName,
  };
}

/**
 * Real fetcher: downloads the page (bounded timeout, sane UA) and extracts it.
 * Every failure path (timeout, network error, non-HTML, non-2xx, resolves back
 * to X, unparsable) returns a typed `failed` result rather than throwing, so
 * callers never need a try/catch to stay safe.
 */
export class HttpArticleFetcher implements ArticleFetcher {
  constructor(private readonly timeoutMs: number = FETCH_TIMEOUT_MS) {}

  async fetch(url: string): Promise<ArticleExtractionResult> {
    const requestedHost = safeHostname(url);
    if (requestedHost && NON_ARTICLE_HOSTS.has(requestedHost)) {
      return { status: 'failed', reason: NOT_AN_ARTICLE_REASON };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });

      if (!res.ok) {
        return { status: 'failed', reason: `The page returned an error (HTTP ${res.status}).` };
      }

      const finalHost = safeHostname(res.url) ?? requestedHost;
      if (finalHost && NON_ARTICLE_HOSTS.has(finalHost)) {
        return { status: 'failed', reason: NOT_AN_ARTICLE_REASON };
      }

      const contentType = res.headers.get('content-type') ?? '';
      if (contentType && !contentType.includes('html')) {
        return { status: 'failed', reason: 'This link does not point to a readable web page.' };
      }

      const html = await res.text();
      return extractArticle(html, res.url || url);
    } catch (err) {
      const timedOut = err instanceof Error && err.name === 'AbortError';
      return {
        status: 'failed',
        reason: timedOut
          ? 'The page took too long to respond.'
          : 'Could not fetch this page. It may be blocked, offline, or require a login.',
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
