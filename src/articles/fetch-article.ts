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

const USER_AGENT =
  'Mozilla/5.0 (compatible; XBookmarksOrganizer/1.0; +personal reader view, single-user tool)';
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

/**
 * Pure extraction step: given already-fetched HTML, run readability + sanitize.
 * Kept separate from the network fetch so it can be tested offline against
 * fixture HTML with no real request involved.
 */
export function extractArticle(html: string, url: string): ArticleExtractionResult {
  let parsed;
  try {
    // linkedom resolves relative <a>/<img> URLs (and Readability's own
    // baseURI lookups) off `defaultView.location.href`, not a plain `url`
    // option - see linkedom's Node#baseURI getter.
    const { document } = parseHTMLWithGlobals(html, { location: new URL(url) });
    parsed = new Readability(document as any).parse();
  } catch {
    return { status: 'failed', reason: 'Could not parse this page as an article.' };
  }

  if (!parsed || !parsed.content || (parsed.textContent ?? '').trim().length < MIN_TEXT_LENGTH) {
    return { status: 'failed', reason: 'This page does not look like a readable article.' };
  }

  return {
    status: 'ok',
    title: parsed.title?.trim() || 'Untitled article',
    contentHtml: sanitizeHtml(parsed.content, SANITIZE_OPTIONS),
    excerpt: parsed.excerpt?.trim() || null,
    siteName: parsed.siteName?.trim() || null,
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
