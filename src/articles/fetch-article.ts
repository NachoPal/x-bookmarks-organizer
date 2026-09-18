import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import sanitizeHtml from 'sanitize-html';
import { isXArticleUrl } from '../x/article';

// linkedom's type declarations only expose `parseHTML(html)`, but its runtime
// implementation also accepts a `globals` second argument used to seed
// `defaultView` (see the comment at its call site below); this project also
// has no DOM lib, so `Document` isn't an ambient type Readability's own
// declaration can resolve against. Both are cast through `any` at the single
// call site rather than widening the project's lib config for one module.
type ParseHTMLWithGlobals = (html: string, globals?: { location?: URL }) => { document: unknown };
const parseHTMLWithGlobals = parseHTML as unknown as ParseHTMLWithGlobals;

/**
 * Link-preview card data (OpenGraph / Twitter-card meta tags, with sane
 * fallbacks) - the card X itself renders for a link.
 *
 * This is deliberately INDEPENDENT of whether the page is a readable article:
 * most of a real library's links are tools, product pages, videos or docs that
 * carry a perfectly good preview card but no long-form body. Conflating the
 * two is what left every preview empty (see `ArticleExtractionResult`).
 */
export interface LinkPreviewData {
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
}

/** Successful extraction: a clean title + sanitized body HTML ready to render. */
export interface ArticleExtractionOk {
  status: 'ok';
  title: string;
  contentHtml: string;
  excerpt: string | null;
  siteName: string | null;
  /**
   * The preview card scraped from the same parsed document. A card prefers
   * these fields over `title`/`excerpt`/`siteName` when present, since they're
   * purpose-built for social/preview cards and usually cleaner. Optional so a
   * fake fetcher in a test can omit what it does not exercise.
   */
  preview?: LinkPreviewData | null;
  /**
   * The URL the fetch actually ended on, after HTTP redirects AND shortener
   * interstitials are resolved (see {@link HttpArticleFetcher}). Every link in
   * a post is `t.co`-shortened, so this - not the requested URL - is what a
   * card's domain and an "open the original" action must use.
   */
  resolvedUrl: string | null;
}

/**
 * Body extraction failed - but the page may still have yielded a preview
 * card, which is the common case on real data (a tool's landing page, a
 * video, a GitHub repo). The reader view surfaces `reason` as a message +
 * link to the original, never a crash; the card, when present, still renders.
 */
export interface ArticleExtractionFailed {
  status: 'failed';
  reason: string;
  preview?: LinkPreviewData | null;
  resolvedUrl?: string | null;
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

/**
 * An X-native Article (`x.com/i/article/<id>`) is not fetchable as a web page
 * (x.com serves a login-walled app shell); its title, preview and body come
 * from the X API's `article` field instead - see `src/x/article.ts`.
 */
export const X_ARTICLE_REASON =
  'This link is an X Article; its content comes from the X API, not from fetching the page.';

/** The typed failure for a link that has resolved to an x.com host. */
function nonArticleResult(url: string): ArticleExtractionFailed {
  return {
    status: 'failed',
    reason: isXArticleUrl(url) ? X_ARTICLE_REASON : NOT_AN_ARTICLE_REASON,
    preview: null,
    resolvedUrl: url,
  };
}

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
  textContent: string | null;
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

/**
 * Scrape link-preview metadata from an already-parsed document.
 *
 * OpenGraph first, then the `twitter:*` card equivalents (plenty of sites ship
 * only those), then the plain `<meta name="description">` / `<title>` - the
 * same cascade a social card renderer walks. Returns null only when the page
 * yielded no usable title at all, which is the honest "there is no card here"
 * signal callers gate on.
 */
export function extractLinkPreview(document: MinimalDocument, baseUrl: string): LinkPreviewData | null {
  const title =
    cleanOgText(
      metaContent(document, [
        'meta[property="og:title"]',
        'meta[name="og:title"]',
        'meta[name="twitter:title"]',
        'meta[property="twitter:title"]',
      ]),
    ) ?? cleanOgText(document.querySelector('title')?.textContent);
  const description = cleanOgText(
    metaContent(document, [
      'meta[property="og:description"]',
      'meta[name="og:description"]',
      'meta[name="twitter:description"]',
      'meta[property="twitter:description"]',
      'meta[name="description"]',
    ]),
  );
  const image = resolveOgImage(
    metaContent(document, [
      'meta[property="og:image"]',
      'meta[name="og:image"]',
      'meta[property="og:image:url"]',
      'meta[name="twitter:image"]',
      'meta[property="twitter:image"]',
      'meta[name="twitter:image:src"]',
    ]),
    baseUrl,
  );
  const siteName = cleanOgText(
    metaContent(document, [
      'meta[property="og:site_name"]',
      'meta[name="og:site_name"]',
      'meta[name="twitter:site"]',
    ]),
  );

  // A card with no title is not a card - a domain-only box is worse than the
  // plain link it would replace.
  if (!title) return null;
  return { title, description, image, siteName };
}

/**
 * Pure extraction step: given already-fetched HTML, scrape the preview card
 * and run readability + sanitize over the body.
 *
 * The two are independent on purpose: a page with no readable body still
 * returns `failed` (there is nothing for the reader view to show) but carries
 * its `preview`, so the caller can cache a usable card for it. Kept separate
 * from the network fetch so it can be tested offline against fixture HTML
 * with no real request involved.
 */
export function extractArticle(html: string, url: string, resolvedUrl?: string): ArticleExtractionResult {
  const finalUrl = resolvedUrl ?? url;
  let parsed;
  let document: unknown;
  try {
    // linkedom resolves relative <a>/<img> URLs (and Readability's own
    // baseURI lookups) off `defaultView.location.href`, not a plain `url`
    // option - see linkedom's Node#baseURI getter.
    const parsedDoc = parseHTMLWithGlobals(html, { location: new URL(url) });
    document = parsedDoc.document;
  } catch {
    return {
      status: 'failed',
      reason: 'Could not parse this page as an article.',
      preview: null,
      resolvedUrl: finalUrl,
    };
  }

  // Scrape the card BEFORE readability, which mutates the document it parses.
  const preview = extractLinkPreview(document as MinimalDocument, finalUrl);

  try {
    parsed = new Readability(document as any).parse();
  } catch {
    return {
      status: 'failed',
      reason: 'Could not parse this page as an article.',
      preview,
      resolvedUrl: finalUrl,
    };
  }

  if (!parsed || !parsed.content || (parsed.textContent ?? '').trim().length < MIN_TEXT_LENGTH) {
    return {
      status: 'failed',
      reason: 'This page does not look like a readable article.',
      preview,
      resolvedUrl: finalUrl,
    };
  }

  return {
    status: 'ok',
    title: parsed.title?.trim() || 'Untitled article',
    contentHtml: sanitizeHtml(parsed.content, SANITIZE_OPTIONS),
    excerpt: parsed.excerpt?.trim() || null,
    siteName: parsed.siteName?.trim() || null,
    preview,
    resolvedUrl: finalUrl,
  };
}

/**
 * How many client-side (HTML) redirect hops to follow. Real chains are one
 * hop (t.co -> destination); a small cap keeps a redirect loop bounded.
 */
const MAX_INTERSTITIAL_HOPS = 3;

/**
 * Cheap upper bound on the markup a redirect interstitial can have. A
 * shortener's bounce page is a couple hundred bytes; this only keeps the
 * patterns below off a large document.
 */
const MAX_INTERSTITIAL_BYTES = 16_384;

/** Rough length of what a page would actually show a reader, markup removed. */
function visibleTextLength(html: string): number {
  return html
    .replace(/<(script|style|head|noscript)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim().length;
}

const META_REFRESH_CONTENT = [
  /<meta[^>]+http-equiv\s*=\s*["']?refresh["']?[^>]*?content\s*=\s*["']([^"']+)["']/i,
  /<meta[^>]+content\s*=\s*["']([^"']+)["'][^>]*?http-equiv\s*=\s*["']?refresh["']?/i,
];
const JS_REDIRECT =
  /(?:location\s*\.\s*replace\s*\(|location\s*\.\s*href\s*=|(?:window|document)\s*\.\s*location\s*=)\s*["']([^"']+)["']/i;

/**
 * The URL a shortener interstitial bounces to, or null if this page isn't one.
 *
 * This matters more than it looks: `t.co` answers a realistic *browser* User-
 * Agent (which issue #28 made us send) with HTTP 200 and a tiny
 * `<meta refresh>` + `location.replace(...)` page instead of the bare 301 it
 * gives a bot UA. `fetch`'s `redirect: 'follow'` cannot see that, so every
 * link in the owner's library stopped at t.co's bounce page - which has no
 * body and no card, hence "does not look like a readable article" for all of
 * them. Following it here is what makes real destinations reachable at all.
 */
export function extractInterstitialRedirect(html: string, baseUrl: string): string | null {
  if (html.length > MAX_INTERSTITIAL_BYTES) return null;
  // A bounce page shows the reader nothing. Requiring that is what keeps a
  // real page that merely *contains* a `location.replace(...)` somewhere in a
  // script from being hijacked into a redirect: below this threshold there is
  // no readable content to lose anyway (see MIN_TEXT_LENGTH).
  if (visibleTextLength(html) >= MIN_TEXT_LENGTH) return null;

  let target: string | null = null;
  for (const pattern of META_REFRESH_CONTENT) {
    const content = html.match(pattern)?.[1];
    if (!content) continue;
    // content is `<delay>; url=<target>`; only an immediate refresh is a
    // redirect, a long delay is a page the reader is meant to see first.
    const refresh = content.match(/^\s*(\d+)\s*;\s*url\s*=\s*['"]?\s*([^'"\s>]+)/i);
    if (refresh && Number(refresh[1]) <= 5) {
      target = refresh[2]!;
      break;
    }
  }
  if (!target) target = html.match(JS_REDIRECT)?.[1] ?? null;
  if (!target) return null;

  // Inline scripts escape the slashes in a URL (`https:\/\/example.com`).
  const unescaped = target.replace(/\\\//g, '/').trim();
  try {
    const resolved = new URL(unescaped, baseUrl);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;
    return resolved.href === baseUrl ? null : resolved.href;
  } catch {
    return null;
  }
}

/**
 * Real fetcher: downloads the page (bounded timeout, realistic UA, HTTP *and*
 * interstitial redirects followed) and extracts both its preview card and its
 * readable body.
 *
 * Every failure path (timeout, network error, non-HTML, non-2xx, resolves back
 * to X, unparsable) returns a typed `failed` result rather than throwing, so
 * callers never need a try/catch to stay safe.
 */
export class HttpArticleFetcher implements ArticleFetcher {
  constructor(private readonly timeoutMs: number = FETCH_TIMEOUT_MS) {}

  async fetch(url: string): Promise<ArticleExtractionResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let currentUrl = url;
      for (let hop = 0; ; hop++) {
        const requestedHost = safeHostname(currentUrl);
        if (requestedHost && NON_ARTICLE_HOSTS.has(requestedHost)) return nonArticleResult(currentUrl);

        const res = await fetch(currentUrl, {
          signal: controller.signal,
          redirect: 'follow',
          headers: {
            'User-Agent': USER_AGENT,
            Accept: 'text/html,application/xhtml+xml',
            'Accept-Language': 'en-US,en;q=0.9',
          },
        });
        const landedUrl = res.url || currentUrl;

        if (!res.ok) {
          return {
            status: 'failed',
            reason: `The page returned an error (HTTP ${res.status}).`,
            preview: null,
            resolvedUrl: landedUrl,
          };
        }

        const finalHost = safeHostname(landedUrl) ?? requestedHost;
        if (finalHost && NON_ARTICLE_HOSTS.has(finalHost)) return nonArticleResult(landedUrl);

        const contentType = res.headers.get('content-type') ?? '';
        if (contentType && !contentType.includes('html')) {
          return {
            status: 'failed',
            reason: 'This link does not point to a readable web page.',
            preview: null,
            resolvedUrl: landedUrl,
          };
        }

        const html = await res.text();
        const bounce = hop < MAX_INTERSTITIAL_HOPS ? extractInterstitialRedirect(html, landedUrl) : null;
        if (bounce) {
          currentUrl = bounce;
          continue;
        }
        return extractArticle(html, landedUrl, landedUrl);
      }
    } catch (err) {
      const timedOut = err instanceof Error && err.name === 'AbortError';
      return {
        status: 'failed',
        reason: timedOut
          ? 'The page took too long to respond.'
          : 'Could not fetch this page. It may be blocked, offline, or require a login.',
        preview: null,
        resolvedUrl: null,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
