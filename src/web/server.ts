import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { Database, ReadFilter } from '../db/database';
import { buildCategoryTree } from '../categorize/tree';
import { extractArticleLink } from '../articles/extract-link';
import { HttpArticleFetcher, type ArticleFetcher } from '../articles/fetch-article';
import {
  hasSummarizableContent,
  htmlToPlainText,
  NOTHING_TO_SUMMARIZE_MESSAGE,
  type SummaryGenerator,
  type SummaryInput,
} from '../summarize/summarizer';
import type { ArticleLinkMetadata, ArticleRecord, StoredBookmark, SummaryRecord } from '../types';

/** Directory holding the built static viewer assets (relative to this file). */
const PUBLIC_DIR = path.join(__dirname, 'public');

/** Fallback batch size when no explicit page size is configured. */
const DEFAULT_PAGE_SIZE = 20;

/**
 * Shown when a summary is requested but no generator is wired. The real reason
 * normally comes from the provider's own health check
 * (`ServerOptions.summaryUnavailableReason`); this is the fallback when the
 * viewer was started without one.
 */
const SUMMARY_UNAVAILABLE_MESSAGE =
  'Summaries are disabled: no LLM provider is available. Install and log in to the `claude` CLI, ' +
  'or set XBOOKMARKS_LLM_PROVIDER to a provider you have configured.';

/** Cap on how much of an adapter's failure message is forwarded to the browser. */
const MAX_ERROR_CHARS = 300;

/** Options controlling viewer behavior; page size defaults to {@link DEFAULT_PAGE_SIZE}. */
export interface ServerOptions {
  pageSize?: number;
  /** Injectable so tests can fake the network fetch; defaults to the real HTTP fetcher. */
  articleFetcher?: ArticleFetcher;
  /**
   * Generates on-demand bookmark summaries. Undefined when the configured LLM
   * provider reported itself unavailable, in which case the summary endpoint
   * degrades gracefully (503) instead of crashing.
   */
  summaryGenerator?: SummaryGenerator;
  /**
   * Why summaries are off, when no generator is wired - the provider adapter's
   * own actionable message, surfaced as the button's tooltip and the modal's
   * text so the viewer never has to guess at a fix.
   */
  summaryUnavailableReason?: string;
}

/** The link-preview card data shipped alongside a bookmark that has a confirmed article link. */
interface ArticlePreview {
  title: string;
  description: string | null;
  image: string | null;
  siteName: string | null;
  domain: string;
}

/**
 * A bookmark as shipped to the viewer, with the primary article link (if any)
 * computed from its text, whether that link is a confirmed article
 * (`hasArticle`) and its preview card data (issue #26) - gating the "Read
 * article" affordance and the preview card - and the ids of the categories it
 * is directly filed under so the client can patch only the affected sidebar
 * counters (plus their ancestors) on a read-state toggle or delete, instead
 * of reloading the whole tree.
 */
type BookmarkForViewer = StoredBookmark & {
  articleUrl: string | null;
  hasArticle: boolean;
  preview: ArticlePreview | null;
  categoryIds: number[];
};

/** `example.com` from `https://www.example.com/foo`, or the raw hostname if parsing fails. */
function domainFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function toPreview(url: string, metadata: ArticleLinkMetadata | undefined): ArticlePreview | null {
  if (!metadata || metadata.status !== 'ok' || !metadata.title) return null;
  return {
    title: metadata.title,
    description: metadata.description,
    image: metadata.image,
    siteName: metadata.siteName,
    domain: domainFromUrl(url),
  };
}

/**
 * Build the viewer's bookmark shape for a page of bookmarks. Preview data
 * comes ONLY from the `article_link_metadata` cache (issue #25/#26) - never a
 * live fetch here - because that cache is already populated at ingest time
 * (`buildArticleContext`, run over every bookmark on `run`/`recategorize`),
 * so a bookmark's "Read article" affordance and preview card appear once
 * ingest has resolved its link, keeping the bookmark list endpoint a pure,
 * fast, offline-testable cache read with no network dependency of its own.
 */
function toViewerBookmarks(db: Database, bookmarks: StoredBookmark[], categoryIdsByBookmark: Map<number, number[]>): BookmarkForViewer[] {
  return bookmarks.map((bookmark) => {
    const articleUrl = extractArticleLink(bookmark.text);
    const metadata = articleUrl ? db.getArticleLinkMetadata(articleUrl) : undefined;
    const preview = articleUrl ? toPreview(articleUrl, metadata) : null;
    return {
      ...bookmark,
      articleUrl,
      hasArticle: preview !== null,
      preview,
      categoryIds: categoryIdsByBookmark.get(bookmark.id) ?? [],
    };
  });
}

function parseReadFilter(raw: unknown): ReadFilter {
  return raw === 'unread' || raw === 'read' ? raw : 'all';
}

/** Parse a non-negative integer query param, falling back to {@link fallback}. */
function parseNonNegInt(raw: unknown, fallback: number): number {
  const parsed = typeof raw === 'string' ? Number.parseInt(raw, 10) : NaN;
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Build the local web viewer server. All state comes from the injected
 * {@link Database}; the server itself is stateless and safe to restart.
 */
export function buildServer(db: Database, opts: ServerOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  const pageSize = opts.pageSize && opts.pageSize > 0 ? opts.pageSize : DEFAULT_PAGE_SIZE;
  const articleFetcher = opts.articleFetcher ?? new HttpArticleFetcher();
  const summaryGenerator = opts.summaryGenerator;
  const unavailableReason = opts.summaryUnavailableReason ?? SUMMARY_UNAVAILABLE_MESSAGE;

  /**
   * The cached extraction for a bookmark's article link, fetching and caching
   * it first if needed. Shared by the reader endpoint and the summarizer so a
   * link is still fetched at most once either way.
   */
  async function getOrFetchArticle(bookmarkId: number, articleUrl: string): Promise<ArticleRecord> {
    const cached = db.getArticleForBookmark(bookmarkId);
    if (cached && cached.url === articleUrl) return cached;

    const result = await articleFetcher.fetch(articleUrl);
    const fetchedAt = new Date().toISOString();
    const record: ArticleRecord =
      result.status === 'ok'
        ? {
            bookmarkId,
            url: articleUrl,
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
            url: articleUrl,
            status: 'failed',
            title: null,
            contentHtml: null,
            excerpt: null,
            siteName: null,
            reason: result.reason,
            fetchedAt,
          };
    db.saveArticle(record);
    return record;
  }

  app.register(fastifyStatic, { root: PUBLIC_DIR });

  // The category tree with rolled-up total/unread counts per node.
  app.get('/api/tree', async () => ({ tree: buildCategoryTree(db) }));

  // When bookmarks were last successfully synced with X, or null if never.
  app.get('/api/sync-status', async () => ({ lastSyncedAt: db.getLastSyncedAt() ?? null }));

  // One page of a category's bookmarks, filtered by read state. Paging the
  // filtered set server-side keeps a large category from shipping all at once.
  app.get<{ Params: { id: string }; Querystring: { filter?: string; offset?: string; limit?: string } }>(
    '/api/categories/:id/bookmarks',
    async (req, reply) => {
      const id = Number.parseInt(req.params.id, 10);
      if (!Number.isInteger(id)) return reply.code(400).send({ error: 'invalid category id' });

      const filter = parseReadFilter(req.query.filter);
      const offset = parseNonNegInt(req.query.offset, 0);
      // Clamp the client-supplied limit to the configured page size so no
      // request can pull the whole category down in one shot.
      const requested = parseNonNegInt(req.query.limit, pageSize);
      const limit = Math.min(requested > 0 ? requested : pageSize, pageSize);

      const counts = db.getCategoryBookmarkCounts(id);
      const filteredTotal =
        filter === 'unread'
          ? counts.unread
          : filter === 'read'
            ? counts.total - counts.unread
            : counts.total;
      const bookmarks = db.getBookmarksForCategory(id, { filter, offset, limit });
      const categoryIdsByBookmark = db.getCategoryIdsForBookmarks(bookmarks.map((b) => b.id));

      return {
        bookmarks: toViewerBookmarks(db, bookmarks, categoryIdsByBookmark),
        counts,
        offset,
        limit,
        total: filteredTotal,
        hasMore: offset + bookmarks.length < filteredTotal,
      };
    },
  );

  // Set a bookmark's read state. Body { read: false } clears it (un-read),
  // read (or no body) marks it read; the timestamp is recorded only the first
  // time a bookmark is marked read. This is the toggle the status chip drives.
  app.post<{ Params: { id: string }; Body?: { read?: boolean } }>(
    '/api/bookmarks/:id/read',
    async (req, reply) => {
      const id = Number.parseInt(req.params.id, 10);
      if (!Number.isInteger(id)) return reply.code(400).send({ error: 'invalid bookmark id' });
      const read = req.body?.read !== false;
      const updated = read ? db.markRead(id) : db.markUnread(id);
      if (!updated) return reply.code(404).send({ error: 'bookmark not found' });
      return { bookmark: updated };
    },
  );

  // Permanently delete a bookmark from the local store. Read-only against X:
  // this never touches the X API, it only removes the local copy. The post id
  // is tombstoned so a later sync/recategorize can never re-add it.
  app.delete<{ Params: { id: string } }>('/api/bookmarks/:id', async (req, reply) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'invalid bookmark id' });
    const deleted = db.deleteBookmark(id);
    if (!deleted) return reply.code(404).send({ error: 'bookmark not found' });
    return reply.code(204).send();
  });

  // The reader view's article for a bookmark's primary link: served from the
  // cache once fetched. 404 covers both an unknown bookmark and a bookmark
  // whose post has no article link (there is nothing to read either way); a
  // successful fetch and a graceful extraction failure both come back as 200,
  // since the request itself succeeded - `article.status` tells them apart.
  app.get<{ Params: { id: string } }>('/api/bookmarks/:id/article', async (req, reply) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'invalid bookmark id' });

    const bookmark = db.getBookmarkById(id);
    if (!bookmark) return reply.code(404).send({ error: 'bookmark not found' });

    const articleUrl = extractArticleLink(bookmark.text);
    if (!articleUrl) return reply.code(404).send({ error: 'no article link' });

    const record = await getOrFetchArticle(id, articleUrl);
    return { article: record };
  });

  // Whether the owner can generate NEW summaries right now - i.e. whether the
  // configured LLM provider reported itself available at startup. The client
  // checks this once to disable/tooltip the Summarize button proactively (with
  // `reason` as the tooltip); the summary endpoint below also degrades
  // gracefully on its own if called anyway. A provider that is available but
  // whose call then fails keeps the button enabled and reports the failure in
  // the modal, so a retry is possible.
  app.get('/api/summary-status', async () =>
    summaryGenerator ? { available: true } : { available: false, reason: unavailableReason },
  );

  // The on-demand LLM summary for a bookmark: served from cache once
  // generated. Article-aware when the bookmark's link is an article - the
  // article is fetched/cached the same way the reader view does, so a
  // bookmark whose article was never opened still gets an article-aware
  // summary. 503 (not 500) signals the graceful no-token degradation the
  // owner sees as a clear message rather than a crash or a hang; 422 signals
  // the bookmark simply holds nothing summarizable (see below).
  app.get<{ Params: { id: string } }>('/api/bookmarks/:id/summary', async (req, reply) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'invalid bookmark id' });

    const bookmark = db.getBookmarkById(id);
    if (!bookmark) return reply.code(404).send({ error: 'bookmark not found' });

    const cached = db.getSummaryForBookmark(id);
    if (cached) return { summary: cached };

    if (!summaryGenerator) {
      return reply.code(503).send({ error: unavailableReason });
    }

    const articleUrl = extractArticleLink(bookmark.text);
    const article = articleUrl ? await getOrFetchArticle(id, articleUrl) : undefined;
    const readableArticle = article && article.status === 'ok' ? article : null;

    // When the reader-view extraction produced no readable body, fall back to
    // the ingest-time link-metadata cache (issue #25/#26): an OpenGraph title
    // and description are often all a link-only post has to go on, and they
    // are already on disk, so this stays a pure cache read with no live fetch.
    const linkMetadata =
      articleUrl && !readableArticle ? db.getArticleLinkMetadata(articleUrl) : undefined;
    const cachedPreview = linkMetadata?.status === 'ok' ? linkMetadata : null;

    const input: SummaryInput = {
      postText: bookmark.text,
      authorName: bookmark.authorName,
      authorUsername: bookmark.authorUsername,
      articleTitle: readableArticle?.title ?? cachedPreview?.title ?? null,
      articleDescription: cachedPreview?.description ?? null,
      articleText: readableArticle ? htmlToPlainText(readableArticle.contentHtml ?? '') : null,
    };

    // A post that is only a link, whose link could not be read, holds nothing a
    // model could summarize - and the CLI adapter is hardened with `--tools ""`
    // precisely so it cannot go fetch the URL itself. Asking anyway only ever
    // returned the model's "paste the text and I'll summarize it" refusal,
    // which then got cached as if it were a summary. Say so plainly instead,
    // before spending a call. 422 (not 502) marks this as an explanatory state
    // rather than a failure the owner could retry their way out of.
    if (!hasSummarizableContent(input)) {
      return reply.code(422).send({ error: NOTHING_TO_SUMMARIZE_MESSAGE });
    }

    let summaryText: string;
    try {
      summaryText = await summaryGenerator.summarize(input);
    } catch (err) {
      // Forward the adapter's message: it is written to be user-facing and is
      // redacted at the adapter boundary, so it tells the owner what to fix
      // instead of a generic failure they cannot act on.
      const detail = err instanceof Error ? err.message.slice(0, MAX_ERROR_CHARS) : '';
      return reply
        .code(502)
        .send({ error: detail || 'Could not generate a summary. Please try again.' });
    }

    const record: SummaryRecord = {
      bookmarkId: id,
      summary: summaryText,
      generatedAt: new Date().toISOString(),
    };
    db.saveSummary(record);
    return { summary: record };
  });

  return app;
}

/** Start the viewer and return the running instance. */
export async function startServer(
  db: Database,
  port: number,
  host = '127.0.0.1',
  opts: ServerOptions = {},
): Promise<FastifyInstance> {
  const app = buildServer(db, opts);
  await app.listen({ port, host });
  return app;
}
