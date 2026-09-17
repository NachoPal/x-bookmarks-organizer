import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { Database, ReadFilter } from '../db/database';
import { buildCategoryTree } from '../categorize/tree';
import { extractArticleLink } from '../articles/extract-link';
import { HttpArticleFetcher, type ArticleFetcher } from '../articles/fetch-article';
import type { ArticleRecord, StoredBookmark } from '../types';

/** Directory holding the built static viewer assets (relative to this file). */
const PUBLIC_DIR = path.join(__dirname, 'public');

/** Fallback batch size when no explicit page size is configured. */
const DEFAULT_PAGE_SIZE = 20;

/** Options controlling viewer behavior; page size defaults to {@link DEFAULT_PAGE_SIZE}. */
export interface ServerOptions {
  pageSize?: number;
  /** Injectable so tests can fake the network fetch; defaults to the real HTTP fetcher. */
  articleFetcher?: ArticleFetcher;
}

/**
 * A bookmark as shipped to the viewer, with the primary article link (if any)
 * computed from its text so a card can show the "Read" affordance without a
 * separate round trip.
 */
type BookmarkWithArticleLink = StoredBookmark & { articleUrl: string | null };

function withArticleLink(bookmark: StoredBookmark): BookmarkWithArticleLink {
  return { ...bookmark, articleUrl: extractArticleLink(bookmark.text) };
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

      return {
        bookmarks: bookmarks.map(withArticleLink),
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

    const cached = db.getArticleForBookmark(id);
    if (cached && cached.url === articleUrl) return { article: cached };

    const result = await articleFetcher.fetch(articleUrl);
    const fetchedAt = new Date().toISOString();
    const record: ArticleRecord =
      result.status === 'ok'
        ? {
            bookmarkId: id,
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
            bookmarkId: id,
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
    return { article: record };
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
