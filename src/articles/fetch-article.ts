import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import sanitizeHtml from 'sanitize-html';
import { isXArticleUrl } from '../x/article';
import { createHostPolicy, type HostPolicy } from './host-policy';
import type { ArticleRecord } from '../types';

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

/**
 * The `articles` cache row for a bookmark's extraction result. Shared by the
 * summary endpoint's fetch-or-cache path and `refetch-articles`, so both
 * store exactly the same shape.
 */
export function articleRecordFromResult(
  bookmarkId: number,
  url: string,
  result: ArticleExtractionResult,
  fetchedAt: string = new Date().toISOString(),
): ArticleRecord {
  return result.status === 'ok'
    ? {
        bookmarkId,
        url,
        status: 'ok',
        title: result.title,
        contentHtml: result.contentHtml,
        excerpt: result.excerpt,
        siteName: result.siteName,
        reason: null,
        fetchedAt,
      }
    : {
        bookmarkId,
        url,
        status: 'failed',
        title: null,
        contentHtml: null,
        excerpt: null,
        siteName: null,
        reason: result.reason,
        fetchedAt,
      };
}

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
  let parsed: ReturnType<Readability['parse']>;
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
    parsed = null;
  }

  if (!parsed || !parsed.content || (parsed.textContent ?? '').trim().length < MIN_TEXT_LENGTH) {
    // Readability's scoring misses some pages whose prose IS in the served
    // HTML (React/Next.js shells, sections outside any <article>) - it picks a
    // "Loading..." div or nothing. Rescue those with a plain paragraph
    // extraction; a page with no real prose still ends up `failed`.
    const fallback = extractProseFallback(html, url, finalUrl, preview);
    if (fallback) return fallback;
    return {
      status: 'failed',
      reason: NOT_READABLE_REASON,
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

const NOT_READABLE_REASON = 'This page does not look like a readable article.';

/** Page chrome and non-content elements dropped before the prose fallback reads a page. */
const NON_CONTENT_SELECTOR = [
  'script', 'style', 'noscript', 'template', 'svg', 'iframe', 'form', 'button',
  'nav', 'header', 'footer', 'aside',
].join(', ');

/** Blocks the prose fallback reads, in document order. */
const BLOCK_SELECTOR = 'h1, h2, h3, h4, h5, h6, p, li, blockquote, pre';

/**
 * A paragraph/list item/quote shorter than this is a UI label ("Sign up",
 * "Read more", a nav link), not prose, and neither counts nor is kept.
 */
const MIN_PROSE_BLOCK_CHARS = 40;
/**
 * How much real prose the fallback needs before it calls a page an article.
 * Deliberately well above Readability's own MIN_TEXT_LENGTH: the fallback has
 * no content scoring of its own, so it only rescues pages that clearly carry
 * multiple paragraphs of body copy - a landing page's tagline, a repo's short
 * description or a video page's blurb stays `card`/`failed`.
 */
const MIN_FALLBACK_PROSE_CHARS = 500;
const MIN_FALLBACK_PROSE_BLOCKS = 3;
/** Cap on the text the fallback keeps, so an enormous page never bloats the cache. */
const MAX_FALLBACK_BODY_CHARS = 100_000;

interface FallbackElement extends MinimalElement {
  tagName: string;
  parentElement: FallbackElement | null;
  querySelectorAll(selector: string): Iterable<FallbackElement>;
  remove(): void;
}
interface FallbackDocument extends MinimalDocument {
  body: FallbackElement | null;
  querySelectorAll(selector: string): Iterable<FallbackElement>;
  querySelector(selector: string): FallbackElement | null;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

interface ProseBlock {
  tag: 'h2' | 'p' | 'li' | 'blockquote' | 'pre';
  text: string;
}

/** The kept blocks under `root`, outermost only (a <p> inside a kept <li> is not repeated). */
function collectProseBlocks(root: FallbackElement): ProseBlock[] {
  const blocks: ProseBlock[] = [];
  const kept = new Set<FallbackElement>();
  for (const el of root.querySelectorAll(BLOCK_SELECTOR)) {
    let ancestor = el.parentElement;
    let nested = false;
    while (ancestor && ancestor !== root) {
      if (kept.has(ancestor)) {
        nested = true;
        break;
      }
      ancestor = ancestor.parentElement;
    }
    if (nested) continue;

    const tag = el.tagName.toLowerCase();
    const raw = el.textContent ?? '';
    const text = tag === 'pre' ? raw.trim() : raw.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (/^h[1-6]$/.test(tag)) {
      // A heading is kept for structure but never counts as prose; an
      // implausibly long one is some widget abusing the tag.
      if (text.length <= MAX_OG_TEXT_LENGTH) blocks.push({ tag: 'h2', text });
    } else if (tag === 'pre' || text.length >= MIN_PROSE_BLOCK_CHARS) {
      blocks.push({ tag: tag as ProseBlock['tag'], text });
    } else {
      continue;
    }
    kept.add(el);
  }
  return blocks;
}

function isProse(block: ProseBlock): boolean {
  return block.tag === 'p' || block.tag === 'li' || block.tag === 'blockquote';
}

/**
 * Fallback body extraction for a page Readability rejected: the page's own
 * paragraphs, headings, list items and quotes (chrome removed), rebuilt as
 * plain escaped text and sanitized - no markup from the page survives.
 *
 * Scoped to the page's `<article>`/`<main>` when that alone holds enough
 * prose, else the whole body. Returns null unless the page clearly carries
 * real prose (see MIN_FALLBACK_PROSE_CHARS), which is what keeps a bare app
 * shell, a video page or a landing page from turning into a fake "article".
 */
function extractProseFallback(
  html: string,
  url: string,
  finalUrl: string,
  preview: LinkPreviewData | null,
): ArticleExtractionOk | null {
  const host = safeHostname(finalUrl);
  if (host && NON_ARTICLE_HOSTS.has(host)) return null;

  let document: FallbackDocument;
  try {
    // A fresh parse: Readability has already mutated the first document.
    document = parseHTMLWithGlobals(html, { location: new URL(url) }).document as FallbackDocument;
  } catch {
    return null;
  }
  for (const el of Array.from(document.querySelectorAll(NON_CONTENT_SELECTOR))) el.remove();

  const roots = [
    document.querySelector('article'),
    document.querySelector('main'),
    document.querySelector('[role="main"]'),
    document.body,
  ].filter((el): el is FallbackElement => el !== null);

  for (const root of roots) {
    const blocks = collectProseBlocks(root);
    const prose = blocks.filter(isProse);
    const proseChars = prose.reduce((sum, b) => sum + b.text.length, 0);
    if (prose.length < MIN_FALLBACK_PROSE_BLOCKS || proseChars < MIN_FALLBACK_PROSE_CHARS) continue;

    const parts: string[] = [];
    let total = 0;
    for (const block of blocks) {
      if (total >= MAX_FALLBACK_BODY_CHARS) break;
      const text = block.text.slice(0, MAX_FALLBACK_BODY_CHARS - total);
      total += text.length;
      const inner = escapeHtml(text);
      parts.push(
        block.tag === 'li' ? `<ul><li>${inner}</li></ul>` : `<${block.tag}>${inner}</${block.tag}>`,
      );
    }

    const pageTitle = cleanOgText(document.querySelector('title')?.textContent);
    return {
      status: 'ok',
      title: preview?.title || pageTitle || 'Untitled article',
      contentHtml: sanitizeHtml(parts.join('\n'), SANITIZE_OPTIONS),
      excerpt: preview?.description ?? cleanOgText(prose[0]!.text),
      siteName: preview?.siteName ?? null,
      preview,
      resolvedUrl: finalUrl,
    };
  }
  return null;
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
 * How many HTTP redirects to walk. Counted separately from the interstitial
 * budget below: a chain can legitimately use both (t.co 301 -> a bounce page).
 */
const MAX_HTTP_REDIRECTS = 10;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * The absolute URL a 30x response points at, or null when the response is not
 * a followable redirect. Needed because the fetcher follows redirects itself
 * (`redirect: 'manual'`) so the host policy sees every hop.
 */
function redirectTarget(res: Response, currentUrl: string): string | null {
  if (!REDIRECT_STATUSES.has(res.status)) return null;
  const location = res.headers.get('location');
  if (!location) return null;
  try {
    const resolved = new URL(location, currentUrl);
    return resolved.href === currentUrl ? null : resolved.href;
  } catch {
    return null;
  }
}

export interface HttpArticleFetcherOptions {
  /**
   * The outbound host policy. Defaults to {@link createHostPolicy}, which
   * refuses private/loopback destinations unless the owner opted out. Tests
   * inject one so no DNS query leaves the machine.
   */
  hostPolicy?: HostPolicy;
}

/**
 * Real fetcher: downloads the page (bounded timeout, realistic UA, HTTP *and*
 * interstitial redirects followed, every hop checked against the outbound host
 * policy) and extracts both its preview card and its readable body.
 *
 * Every failure path (timeout, network error, non-HTML, non-2xx, resolves back
 * to X, unparsable) returns a typed `failed` result rather than throwing, so
 * callers never need a try/catch to stay safe.
 */
export class HttpArticleFetcher implements ArticleFetcher {
  private readonly hostPolicy: HostPolicy;

  constructor(
    private readonly timeoutMs: number = FETCH_TIMEOUT_MS,
    options: HttpArticleFetcherOptions = {},
  ) {
    this.hostPolicy = options.hostPolicy ?? createHostPolicy();
  }

  async fetch(url: string): Promise<ArticleExtractionResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let currentUrl = url;
      let interstitialHops = 0;
      let redirectHops = 0;
      for (;;) {
        const requestedHost = safeHostname(currentUrl);
        if (requestedHost && NON_ARTICLE_HOSTS.has(requestedHost)) return nonArticleResult(currentUrl);

        // Applied to EVERY hop, which is the whole point of walking redirects
        // by hand below: a public page may not bounce the fetcher at an
        // address the owner's browser would never have been asked to reach.
        const refusal = await this.hostPolicy.check(currentUrl);
        if (refusal) {
          return { status: 'failed', reason: refusal, preview: null, resolvedUrl: currentUrl };
        }

        const res = await fetch(currentUrl, {
          signal: controller.signal,
          // `follow` would hide the intermediate hops from the policy above.
          redirect: 'manual',
          headers: {
            'User-Agent': USER_AGENT,
            Accept: 'text/html,application/xhtml+xml',
            'Accept-Language': 'en-US,en;q=0.9',
          },
        });
        const landedUrl = res.url || currentUrl;

        const redirectTo = redirectTarget(res, currentUrl);
        if (redirectTo) {
          // Nothing reads a redirect's body; release the socket rather than
          // leaving one dangling per hop for the whole of a sync.
          await res.body?.cancel().catch(() => {});
          if (++redirectHops > MAX_HTTP_REDIRECTS) {
            return {
              status: 'failed',
              reason: 'This link redirects too many times to follow.',
              preview: null,
              resolvedUrl: currentUrl,
            };
          }
          currentUrl = redirectTo;
          continue;
        }

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
        const bounce =
          interstitialHops < MAX_INTERSTITIAL_HOPS ? extractInterstitialRedirect(html, landedUrl) : null;
        if (bounce) {
          interstitialHops++;
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
