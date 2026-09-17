import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { extractArticle, HttpArticleFetcher } from './fetch-article';

const FIXTURE_PATH = path.join(__dirname, '../web/public/fixtures/sample-article.html');
const FIXTURE_HTML = fs.readFileSync(FIXTURE_PATH, 'utf-8');
const FIXTURE_URL = 'https://example.com/blog/reader-view';

const ARTICLE_HTML = `<!doctype html><html><head><title>Resolved Article</title></head><body><article>
  <h1>Resolved Article</h1>
  <p>${'This article only shows up once the shortener redirect has actually been followed. '.repeat(20)}</p>
</article></body></html>`;

/**
 * A tiny local HTTP server standing in for a real shortener (t.co) plus its
 * destination article host, so redirect-following and UA behavior can be
 * exercised against a real socket instead of a mocked `fetch` - offline, but
 * with none of the redirect mechanics faked away.
 */
function startFixtureServer(handler: http.RequestListener): Promise<{ url: (path: string) => string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: (p: string) => `http://127.0.0.1:${port}${p}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function jsonResponse(body: string, init: { status?: number; url?: string; contentType?: string } = {}) {
  const headers = new Headers();
  if (init.contentType !== undefined) headers.set('content-type', init.contentType);
  const res = new Response(body, { status: init.status ?? 200, headers });
  Object.defineProperty(res, 'url', { value: init.url ?? FIXTURE_URL });
  return res;
}

describe('extractArticle (pure, no network)', () => {
  it('extracts the title and body while stripping chrome, scripts, and handlers', () => {
    const result = extractArticle(FIXTURE_HTML, FIXTURE_URL);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('expected ok');

    expect(result.title).toContain("Reader View");
    expect(result.contentHtml).toContain('bookmarking tool');
    expect(result.contentHtml).toContain('Fetch server-side');

    // Chrome around the article (nav/aside/footer) must not survive extraction.
    expect(result.contentHtml).not.toContain('Advertisement');
    expect(result.contentHtml).not.toContain('Related post');
    expect(result.contentHtml).not.toContain('Subscribe');

    // Sanitization: no scripts, no inline event handlers, no style blocks.
    expect(result.contentHtml).not.toContain('<script');
    expect(result.contentHtml).not.toContain('onclick');
    expect(result.contentHtml).not.toContain('onload');
    expect(result.contentHtml).not.toContain('<style');
  });

  it('resolves relative links against the article URL', () => {
    const html = `<!doctype html><html><body><article>
      <h1>Relative Link Test</h1>
      <p>${'Padding content so the extractor treats this as a real article body. '.repeat(15)}</p>
      <p>See <a href="/related">this related piece</a> for more.</p>
      <p>${'More padding content so extraction thresholds are comfortably satisfied here. '.repeat(15)}</p>
    </article></body></html>`;
    const result = extractArticle(html, 'https://example.com/posts/one');
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.contentHtml).toContain('href="https://example.com/related"');
  });

  it('strips a javascript: href instead of passing it through', () => {
    const html = `<!doctype html><html><body><article>
      <h1>Malicious Link Test</h1>
      <p>${'Padding content so the extractor treats this as a real article body. '.repeat(15)}</p>
      <p><a href="javascript:alert(1)">click me</a></p>
      <p>${'More padding content so extraction thresholds are comfortably satisfied here. '.repeat(15)}</p>
    </article></body></html>`;
    const result = extractArticle(html, 'https://example.com/posts/two');
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.contentHtml).not.toContain('javascript:');
  });

  it('fails gracefully on a page with no substantial readable content', () => {
    const html = `<!doctype html><html><body><nav>Home</nav><p>Please log in to continue.</p></body></html>`;
    const result = extractArticle(html, 'https://example.com/login');
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected failed');
    expect(result.reason).toBeTruthy();
  });

  it('fails gracefully on unparsable garbage input rather than throwing', () => {
    expect(() => extractArticle('<<<not html at all', 'not a url')).not.toThrow();
    const result = extractArticle('<<<not html at all', 'not a url');
    expect(result.status).toBe('failed');
  });
});

describe('HttpArticleFetcher (network mocked, never hits the real internet)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches, extracts, and returns ok for a real article response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(FIXTURE_HTML, { contentType: 'text/html; charset=utf-8' }));
    vi.stubGlobal('fetch', fetchMock);

    const fetcher = new HttpArticleFetcher();
    const result = await fetcher.fetch(FIXTURE_URL);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.title).toContain('Reader View');
  });

  it('fails gracefully with a clear reason on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse('Not Found', { status: 404 })));
    const result = await new HttpArticleFetcher().fetch('https://example.com/missing');
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected failed');
    expect(result.reason).toMatch(/404/);
  });

  it('fails gracefully on a non-HTML response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse('{"not":"html"}', { contentType: 'application/json' })),
    );
    const result = await new HttpArticleFetcher().fetch('https://example.com/data.json');
    expect(result.status).toBe('failed');
  });

  it('fails gracefully when the request times out', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        (_url: string, init?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }),
      ),
    );
    const result = await new HttpArticleFetcher(20).fetch('https://example.com/slow');
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected failed');
    expect(result.reason).toMatch(/too long/i);
  });

  it('fails gracefully on a network error (DNS/connection failure)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    const result = await new HttpArticleFetcher().fetch('https://nonexistent.invalid/post');
    expect(result.status).toBe('failed');
  });

  it('treats a link that resolves back to X as "not an article" without fetching for a known non-article host', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await new HttpArticleFetcher().fetch('https://x.com/someone/status/123');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected failed');
    expect(result.reason).toMatch(/not an article|post on X/i);
  });

  it('treats a t.co link that redirects back to X as "not an article"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse('<html></html>', { url: 'https://twitter.com/someone/status/123' })),
    );
    const result = await new HttpArticleFetcher().fetch('https://t.co/abc123');
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected failed');
    expect(result.reason).toMatch(/not an article|post on X/i);
  });
});

describe('HttpArticleFetcher against a real local server (redirect + UA robustness, issue #28)', () => {
  it('resolves a shortened/redirecting link to its destination article instead of 404ing', async () => {
    // Mimics t.co: a bare 301 to the real article, on a real socket so the
    // redirect is actually followed by the HTTP client, not by test mocking.
    const fixture = await startFixtureServer((req, res) => {
      if (req.url === '/abc123') {
        res.writeHead(301, { Location: fixture.url('/real-article') });
        res.end();
        return;
      }
      if (req.url === '/real-article') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(ARTICLE_HTML);
        return;
      }
      res.writeHead(404);
      res.end('not found');
    });

    try {
      const result = await new HttpArticleFetcher().fetch(fixture.url('/abc123'));
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') throw new Error('expected ok');
      expect(result.title).toContain('Resolved Article');
    } finally {
      await fixture.close();
    }
  });

  it('resolves a link even when a bot-detecting site 404s a generic/self-identifying UA but serves a realistic browser UA', async () => {
    // Some sites 404 (rather than 403) requests from an obviously
    // bot-like User-Agent as a basic anti-scraping measure. A fetcher that
    // identifies itself as a bot spuriously 404s on links that actually
    // resolve fine for a real browser.
    const fixture = await startFixtureServer((req, res) => {
      const ua = req.headers['user-agent'] ?? '';
      const looksLikeBrowser = /Mozilla\/5\.0.*(Chrome|Safari|Firefox)/.test(ua) && !/XBookmarksOrganizer/i.test(ua);
      if (!looksLikeBrowser) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(ARTICLE_HTML);
    });

    try {
      const result = await new HttpArticleFetcher().fetch(fixture.url('/article'));
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') throw new Error('expected ok');
      expect(result.title).toContain('Resolved Article');
    } finally {
      await fixture.close();
    }
  });

  it('fails gracefully with a friendly message when the destination is genuinely gone, regardless of UA', async () => {
    const fixture = await startFixtureServer((req, res) => {
      if (req.url === '/dead-shortlink') {
        res.writeHead(301, { Location: fixture.url('/gone') });
        res.end();
        return;
      }
      res.writeHead(404);
      res.end('not found');
    });

    try {
      const result = await new HttpArticleFetcher().fetch(fixture.url('/dead-shortlink'));
      expect(result.status).toBe('failed');
      if (result.status !== 'failed') throw new Error('expected failed');
      expect(result.reason).toBeTruthy();
      expect(result.reason).not.toBe('');
    } finally {
      await fixture.close();
    }
  });
});
