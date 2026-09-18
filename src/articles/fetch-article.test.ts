import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import { extractArticle, HttpArticleFetcher, X_ARTICLE_REASON } from './fetch-article';

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

/**
 * Modeled on real pages from the owner's library that Readability rejects
 * even though the served HTML carries the whole text: a JS app shell whose
 * visible node is a loading placeholder, with the prose rendered as flat
 * sections in a crawler copy (and the kind of `<header>`/`<footer>`/`<nav>`
 * chrome the fallback must drop).
 */
const APP_SHELL_PROSE_HTML = `<!doctype html><html><head>
  <title>Don't Build Multi-Agents | Example Labs</title>
  <meta property="og:title" content="Don't Build Multi-Agents" />
  <meta property="og:description" content="Principles for building reliable long-running agents." />
  <script>window.__NEXT_DATA__ = {"props":{}}</script>
</head><body>
  <div id="__next"><div class="loading">Setting up the room…</div></div>
  <header><nav><a href="/">Home</a><a href="/blog">Blog</a><a href="/careers">We are hiring engineers who love building agents</a></nav></header>
  <main aria-hidden="true" class="crawl">
    <section><h2>Principle 1: share context</h2>
      <p>Share full agent traces between every part of the system, not just individual messages, because subagents that only see their own task description will misread what the overall job actually needs.</p>
      <p>Actions carry implicit decisions, and conflicting decisions carry bad results: two subagents that each make a reasonable assumption on their own can still produce parts that do not fit together.</p>
    </section>
    <section><h2>Principle 2: a single thread</h2>
      <p>The simplest way to follow both principles is a single-threaded linear agent, where the context is continuous and every action is taken with the full history of what came before it in view.</p>
      <p>For very long tasks, add a model whose only job is to compress the history of actions and conversation into key details, events and decisions, so the thread can keep going without overflowing.</p>
      <p>Operators <script>alert(1)</script> should read &lt;b&gt;escaped&lt;/b&gt; markup as text: <span onclick="steal()">nothing</span> from the page itself survives as markup.</p>
    </section>
  </main>
  <footer><p>Copyright Example Labs. All rights reserved. Terms of service and privacy policy apply here.</p></footer>
</body></html>`;

describe('extractArticle prose fallback (Readability misses real prose, pure, no network)', () => {
  it('precondition: Readability alone rejects the app-shell fixture', () => {
    const parsed = new Readability(parseHTML(APP_SHELL_PROSE_HTML).document as any).parse();
    expect((parsed?.textContent ?? '').trim().length).toBeLessThan(200);
  });

  it('extracts the body from the served prose instead of failing', () => {
    const result = extractArticle(APP_SHELL_PROSE_HTML, 'https://example.com/blog/dont-build-multi-agents');
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('expected ok');

    expect(result.title).toBe("Don't Build Multi-Agents");
    expect(result.excerpt).toBe('Principles for building reliable long-running agents.');
    expect(result.contentHtml).toContain('<h2>Principle 1: share context</h2>');
    expect(result.contentHtml).toContain('Share full agent traces');
    expect(result.contentHtml).toContain('single-threaded linear agent');
    // The card still rides along, exactly as on the Readability path.
    expect(result.preview?.title).toBe("Don't Build Multi-Agents");
  });

  it('drops page chrome and keeps nothing from the page as markup', () => {
    const result = extractArticle(APP_SHELL_PROSE_HTML, 'https://example.com/blog/dont-build-multi-agents');
    if (result.status !== 'ok') throw new Error('expected ok');

    expect(result.contentHtml).not.toContain('hiring');
    expect(result.contentHtml).not.toContain('Copyright');
    expect(result.contentHtml).not.toContain('Setting up the room');
    expect(result.contentHtml).not.toContain('<script');
    expect(result.contentHtml).not.toContain('alert(1)');
    expect(result.contentHtml).not.toContain('onclick');
    expect(result.contentHtml).not.toContain('<span');
    expect(result.contentHtml).not.toContain('<b>');
    expect(result.contentHtml).toContain('&lt;b&gt;escaped&lt;/b&gt;');
  });

  it('still fails an app shell with no prose - labels, headings and a tagline are not an article', () => {
    const html = `<!doctype html><html><head>
      <meta property="og:title" content="Acme Studio" />
      <meta property="og:description" content="The fastest way to ship your next idea." />
    </head><body><div id="root">
      <h1>Ship faster with Acme Studio</h1>
      <p>The fastest way to ship your next idea, from prototype to production.</p>
      <ul><li>Fast</li><li>Secure</li><li>Collaborative</li></ul>
      <h2>Pricing</h2><p>Free</p><p>Pro</p><p>Team</p>
      <button>Get started for free today, no credit card required at all</button>
    </div>
    <footer><ul>
      <li>About Acme Studio and the team that builds it every single day</li>
      <li>Careers at Acme Studio - we are hiring across every department</li>
      <li>Security, compliance and the trust center for enterprise customers</li>
    </ul></footer></body></html>`;
    const result = extractArticle(html, 'https://acme.example/');
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected failed');
    expect(result.reason).toBe('This page does not look like a readable article.');
    expect(result.preview?.title).toBe('Acme Studio');
  });

  it('never rescues a page served from an X host, whatever its text', () => {
    const result = extractArticle(APP_SHELL_PROSE_HTML, 'https://x.com/someone/status/1');
    expect(result.status).toBe('failed');
  });
});

describe('extractArticle preview card fields (issues #26/#45, pure, no network)', () => {
  it('extracts og:title/og:description/og:image/og:site_name and resolves a relative image URL', () => {
    const result = extractArticle(FIXTURE_HTML, FIXTURE_URL);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('expected ok');

    expect(result.preview?.title).toBe("Reader View, and Why Bookmarking Isn't the Same as Reading");
    expect(result.preview?.description).toContain('save for later');
    expect(result.preview?.siteName).toBe('Sample Times');
    // The fixture's og:image is a root-relative path - resolved against the
    // fetched page's own URL, exactly like a relative <a>/<img> in the body.
    expect(result.preview?.image).toBe('https://example.com/fixtures/sample-article-cover.svg');
  });

  it('falls back to the <title> and null card fields (never a crash) on a page with no OpenGraph tags', () => {
    const html = `<!doctype html><html><head><title>No OG Tags Here</title></head><body><article>
      <h1>No OG Tags Here</h1>
      <p>${'Padding content so the extractor treats this as a real article body. '.repeat(15)}</p>
    </article></body></html>`;
    const result = extractArticle(html, 'https://example.com/posts/no-og');
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.preview?.title).toBe('No OG Tags Here');
    expect(result.preview?.description).toBeNull();
    expect(result.preview?.image).toBeNull();
    expect(result.preview?.siteName).toBeNull();
  });

  it('reports no card at all for a page with neither OG tags nor a <title>', () => {
    const html = `<!doctype html><html><body><article>
      <h1>Titleless</h1>
      <p>${'Padding content so the extractor treats this as a real article body. '.repeat(15)}</p>
    </article></body></html>`;
    const result = extractArticle(html, 'https://example.com/posts/titleless');
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.preview).toBeNull();
  });

  it('falls back to the twitter:* card tags when a page ships those instead of og:*', () => {
    const html = `<!doctype html><html><head>
      <title>Ignored fallback title</title>
      <meta name="twitter:title" content="A Twitter-Card Tool" />
      <meta name="twitter:description" content="What this tool does, in one line." />
      <meta name="twitter:image" content="/card.png" />
    </head><body><p>Short landing page copy.</p></body></html>`;
    const result = extractArticle(html, 'https://tool.example.com/');
    expect(result.preview?.title).toBe('A Twitter-Card Tool');
    expect(result.preview?.description).toBe('What this tool does, in one line.');
    expect(result.preview?.image).toBe('https://tool.example.com/card.png');
  });

  it('returns the card for a page with OG tags but NO readable body (the common real-world case)', () => {
    // A tool/product landing page: a perfectly good preview card, no article.
    const html = `<!doctype html><html><head>
      <meta property="og:title" content="Executor - connect your agent to everything" />
      <meta property="og:description" content="One place every agent plugs into every tool you already use." />
      <meta property="og:image" content="https://executor.example/card.png" />
      <meta property="og:site_name" content="Executor" />
    </head><body><main><p>Get started</p></main></body></html>`;
    const result = extractArticle(html, 'https://executor.example/');

    // No body to read...
    expect(result.status).toBe('failed');
    // ...but the card survives, which is what the preview renders from.
    expect(result.preview).toEqual({
      title: 'Executor - connect your agent to everything',
      description: 'One place every agent plugs into every tool you already use.',
      image: 'https://executor.example/card.png',
      siteName: 'Executor',
    });
  });

  it('ignores an og:image with a non-http(s) scheme rather than passing it through', () => {
    const html = `<!doctype html><html><head>
      <title>Malicious OG Image Test</title>
      <meta property="og:image" content="javascript:alert(1)" />
    </head><body><article>
      <h1>Malicious OG Image Test</h1>
      <p>${'Padding content so the extractor treats this as a real article body. '.repeat(15)}</p>
    </article></body></html>`;
    const result = extractArticle(html, 'https://example.com/posts/bad-image');
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.preview?.image).toBeNull();
  });

  it('collapses whitespace and caps an overlong og:description', () => {
    const longDescription = 'word '.repeat(200).trim();
    const html = `<!doctype html><html><head>
      <title>Long Description Test</title>
      <meta property="og:description" content="${longDescription}" />
    </head><body><article>
      <h1>Long Description Test</h1>
      <p>${'Padding content so the extractor treats this as a real article body. '.repeat(15)}</p>
    </article></body></html>`;
    const result = extractArticle(html, 'https://example.com/posts/long-description');
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.preview!.description!.length).toBeLessThanOrEqual(300);
    expect(result.preview!.description!.endsWith('…')).toBe(true);
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

  it('short-circuits an x.com/i/article link with the X Article reason, without fetching it', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await new HttpArticleFetcher().fetch('https://x.com/i/article/2094692428037177344');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'failed', reason: X_ARTICLE_REASON });
  });

  it('reports the X Article reason when a t.co link lands on an x.com/i/article page', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse('<html></html>', { url: 'https://x.com/i/article/2094692428037177344' })),
    );
    const result = await new HttpArticleFetcher().fetch('https://t.co/abc123');
    expect(result).toMatchObject({
      status: 'failed',
      reason: X_ARTICLE_REASON,
      resolvedUrl: 'https://x.com/i/article/2094692428037177344',
    });
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

  it('follows a t.co-style HTML interstitial (HTTP 200 + meta refresh/location.replace), not just a 301', async () => {
    // This is the real-world failure this test pins down: t.co answers a
    // realistic *browser* User-Agent (issue #28) with HTTP 200 and a tiny
    // bounce page instead of a 301, which `redirect: 'follow'` cannot see. A
    // fetcher that stops there gets no body and no card for EVERY link in the
    // library, since every link in a post is t.co-shortened.
    const fixture = await startFixtureServer((req, res) => {
      if (req.url === '/shortlink') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(
          '<head><noscript><META http-equiv="refresh" content="0;URL=' +
            fixture.url('/real-article') +
            '"></noscript><title>' +
            fixture.url('/real-article') +
            '</title></head><script>window.opener = null; location.replace("' +
            fixture.url('/real-article').replace(/\//g, '\\/') +
            '")</script>',
        );
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
      const result = await new HttpArticleFetcher().fetch(fixture.url('/shortlink'));
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') throw new Error('expected ok');
      expect(result.title).toContain('Resolved Article');
      // The card/domain must reflect the DESTINATION, not the shortener.
      expect(result.resolvedUrl).toBe(fixture.url('/real-article'));
    } finally {
      await fixture.close();
    }
  });

  it('caches a card (not a failure) for a shortened link to a page with OG tags but no readable body', async () => {
    const fixture = await startFixtureServer((req, res) => {
      if (req.url === '/shortlink') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(
          `<head><noscript><META http-equiv="refresh" content="0;URL=${fixture.url('/tool')}"></noscript></head>`,
        );
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        '<!doctype html><html><head>' +
          '<meta property="og:title" content="A Tool, Not An Article" />' +
          '<meta property="og:description" content="Short pitch." />' +
          '</head><body><p>Sign up</p></body></html>',
      );
    });

    try {
      const result = await new HttpArticleFetcher().fetch(fixture.url('/shortlink'));
      expect(result.status).toBe('failed');
      expect(result.preview?.title).toBe('A Tool, Not An Article');
      expect(result.resolvedUrl).toBe(fixture.url('/tool'));
    } finally {
      await fixture.close();
    }
  });

  it('stops after a bounded number of interstitial hops instead of looping forever', async () => {
    let hops = 0;
    const fixture = await startFixtureServer((_req, res) => {
      hops++;
      res.writeHead(200, { 'content-type': 'text/html' });
      // Always bounces somewhere new, so only the hop cap can end this.
      res.end(`<head><meta http-equiv="refresh" content="0;URL=${fixture.url(`/hop-${hops}`)}"></head>`);
    });

    try {
      const result = await new HttpArticleFetcher().fetch(fixture.url('/hop-0'));
      expect(result.status).toBe('failed');
      expect(hops).toBeLessThanOrEqual(5);
    } finally {
      await fixture.close();
    }
  });

  it('does not mistake a real article that happens to contain a redirect snippet for an interstitial', async () => {
    const fixture = await startFixtureServer((req, res) => {
      if (req.url === '/article-with-script') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(
          ARTICLE_HTML.replace(
            '</body>',
            '<script>if (false) location.replace("https://evil.example/elsewhere")</script></body>',
          ),
        );
        return;
      }
      res.writeHead(404);
      res.end('not found');
    });

    try {
      const result = await new HttpArticleFetcher().fetch(fixture.url('/article-with-script'));
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
