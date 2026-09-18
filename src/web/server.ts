import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { Database, ReadFilter } from '../db/database';
import { buildCategoryTree } from '../categorize/tree';
import { extractArticleLink } from '../articles/extract-link';
import { articleRecordFromResult, HttpArticleFetcher, type ArticleFetcher } from '../articles/fetch-article';
import {
  hasSummarizableContent,
  htmlToPlainText,
  NOTHING_TO_SUMMARIZE_MESSAGE,
  type SummaryGenerator,
  type SummaryInput,
} from '../summarize/summarizer';
import { xArticleUrl } from '../x/article';
import type { BookmarkXArticle } from '../db/database';
import { buildBookmarkContent, buildBookmarkContents } from '../content/bookmark-content';
import type { ArticleRecord, StoredBookmark, SummaryRecord } from '../types';

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

/**
 * A bookmark as shipped to the viewer. Carries the ids of the categories it
 * is directly filed under so the client can patch only the affected sidebar
 * counters (plus their ancestors) on a read-state toggle or delete, instead
 * of reloading the whole tree, plus `hasSummary` (a saved summary already
 * exists) so the action row can render "Summary" instead of "Summarize"
 * without an extra call per card.
 */
type BookmarkForViewer = Omit<StoredBookmark, 'xArticle' | 'quotedXArticle'> & {
  hasSummary: boolean;
  categoryIds: number[];
  xArticle: ViewerXArticle | null;
};

/**
 * The "X Article" card's data for a bookmark that hosts or quotes an X-native
 * Article. The body (`plainText`) stays server-side - it feeds Summarize, and
 * shipping it per card would bloat every page of the list.
 */
interface ViewerXArticle {
  title: string | null;
  previewText: string | null;
  coverUrl: string | null;
  coverWidth: number | null;
  coverHeight: number | null;
  /** Where the card links: the Article itself, else its host post. */
  url: string;
  /** True when the bookmark quotes the Article rather than hosting it. */
  quoted: boolean;
}

function toViewerXArticle(entry: BookmarkXArticle | undefined): ViewerXArticle | null {
  if (!entry) return null;
  const { article, postId, quoted } = entry;
  // A row with neither title nor preview would render an empty card.
  if (!article.title && !article.previewText) return null;
  return {
    title: article.title,
    previewText: article.previewText,
    coverUrl: article.coverUrl,
    coverWidth: article.coverWidth,
    coverHeight: article.coverHeight,
    url: article.restId ? xArticleUrl(article.restId) : `https://x.com/i/web/status/${postId}`,
    quoted,
  };
}

/** `example.com` from `https://www.example.com/foo`, or the raw hostname if parsing fails. */
function domainFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/**
 * Build the viewer's bookmark shape for a page of bookmarks. `xArticle`
 * (X-native Articles) is a pure read of the `x_articles` table that
 * ingest/`backfill-x-articles` populate. `hasSummary` is a cheap existence
 * check against the `summaries` table - never the summary text itself, which
 * would bloat every page of the list.
 */
function toViewerBookmarks(db: Database, bookmarks: StoredBookmark[], categoryIdsByBookmark: Map<number, number[]>): BookmarkForViewer[] {
  const xArticles = db.getXArticlesForBookmarks(bookmarks);
  const summarizedIds = db.getSummarizedBookmarkIds(bookmarks.map((b) => b.id));
  return bookmarks.map((bookmark) => ({
    ...bookmark,
    hasSummary: summarizedIds.has(bookmark.id),
    categoryIds: categoryIdsByBookmark.get(bookmark.id) ?? [],
    xArticle: toViewerXArticle(xArticles.get(bookmark.postId)),
  }));
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
   * it first if needed. Used by the summarizer so a link is still fetched at
   * most once (the in-app reader that also used this was removed; the owner
   * now reaches external articles via the card inside the tweet embed). A
   * cached `failed` row is served as-is; `refetch-articles` is the explicit
   * way to retry those.
   */
  async function getOrFetchArticle(bookmarkId: number, articleUrl: string): Promise<ArticleRecord> {
    const cached = db.getArticleForBookmark(bookmarkId);
    if (cached && cached.url === articleUrl) return cached;

    const record = articleRecordFromResult(bookmarkId, articleUrl, await articleFetcher.fetch(articleUrl));
    db.saveArticle(record);
    return record;
  }

  /** Generate, cache and return a summary; 502 with the adapter's message on failure. */
  async function generateSummary(id: number, input: SummaryInput, reply: FastifyReply) {
    if (!summaryGenerator) return reply.code(503).send({ error: unavailableReason });
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

    // An X-native Article (hosted or quoted) brings its own body from the X
    // API, stored at ingest - no link fetch, and it is the substance to
    // summarize. Its t.co link only leads back to x.com, so skip that fetch.
    const xArticle = db.getXArticlesForBookmarks([bookmark]).get(bookmark.postId)?.article;
    if (xArticle) {
      const xInput: SummaryInput = {
        postText: bookmark.text,
        authorName: bookmark.authorName,
        authorUsername: bookmark.authorUsername,
        articleTitle: xArticle.title,
        articleDescription: xArticle.plainText ? null : xArticle.previewText,
        articleSiteName: 'X Article',
        articleText: xArticle.plainText,
      };
      if (hasSummarizableContent(xInput)) return generateSummary(id, xInput, reply);
    }

    const articleUrl = extractArticleLink(bookmark.text);
    const article = articleUrl ? await getOrFetchArticle(id, articleUrl) : undefined;
    const readableArticle = article && article.status === 'ok' ? article : null;

    // When the reader-view extraction produced no readable body, fall back to
    // the ingest-time link-metadata cache (issue #25/#26): an OpenGraph title
    // and description are often all a link-only post has to go on, and they
    // are already on disk, so this stays a pure cache read with no live
    // fetch. A `card`-only row counts here exactly like an `ok` one - the
    // card IS the content for a page with no readable body.
    const linkMetadata =
      articleUrl && !readableArticle ? db.getArticleLinkMetadata(articleUrl) : undefined;
    const cachedPreview = linkMetadata && linkMetadata.status !== 'failed' ? linkMetadata : null;

    const input: SummaryInput = {
      postText: bookmark.text,
      authorName: bookmark.authorName,
      authorUsername: bookmark.authorUsername,
      articleTitle: readableArticle?.title ?? cachedPreview?.title ?? null,
      articleDescription: cachedPreview?.description ?? null,
      articleSiteName:
        cachedPreview?.siteName ??
        (cachedPreview ? domainFromUrl(cachedPreview.resolvedUrl ?? cachedPreview.url) : null),
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

    return generateSummary(id, input, reply);
  });

  // The structured, labeled content of one bookmark - for a content-scoring/
  // ranking tool that needs each part (the post itself, a quoted post, a
  // linked article, an X Article) clearly self-identified rather than
  // flattened. A pure DB read: no network fetch happens here. See README for
  // the shape.
  app.get<{ Params: { id: string } }>('/api/bookmarks/:id/content', async (req, reply) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'invalid bookmark id' });
    const bookmark = db.getBookmarkById(id);
    if (!bookmark) return reply.code(404).send({ error: 'bookmark not found' });
    return { content: buildBookmarkContent(db, bookmark) };
  });

  // A page of every bookmark's structured content, newest-ingested first, for
  // a ranking tool to consume in bulk without a network dependency of its own.
  app.get<{ Querystring: { offset?: string; limit?: string } }>('/api/content', async (req) => {
    const offset = parseNonNegInt(req.query.offset, 0);
    const requested = parseNonNegInt(req.query.limit, pageSize);
    const limit = Math.min(requested > 0 ? requested : pageSize, pageSize);

    const total = db.getBookmarkCount();
    const bookmarks = db.getBookmarksPage(offset, limit);
    return {
      content: buildBookmarkContents(db, bookmarks),
      offset,
      limit,
      total,
      hasMore: offset + bookmarks.length < total,
    };
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
