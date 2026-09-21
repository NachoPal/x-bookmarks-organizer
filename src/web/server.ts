import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { BookmarkFilter, BookmarkSortOrder, Database } from '../db/database';
import { buildCategoryTree, writeRootOrder } from '../categorize/tree';
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
import { buildSettingsCatalog, type SettingsCatalog } from '../settings/catalog';
import {
  effectiveSettings,
  readSettings,
  validateSettings,
  writeSettings,
  type AppSettings,
} from '../settings/settings';
import { TYPESAFE_API_KEY } from '../config';
import type { CredentialStore } from '../creds/resolve';
import { SyncRunner, type SyncJob } from './sync';
import { RankRunner } from './rank';
import type { RankWiring } from './rank-job';
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
  /**
   * The work one in-app sync performs (issue #71). Undefined leaves the Sync
   * button disabled with {@link SYNC_UNAVAILABLE_MESSAGE} - which is what a
   * test-built server, and any viewer started without the ingest wiring, gets.
   */
  syncJob?: SyncJob;
  /**
   * The credential chain, so the setup flow can say WHICH credential is
   * missing before a sync fails on it. Only a key's PRESENCE and `source` are
   * ever read out of it - never a value (`AGENTS.md`).
   */
  credentials?: CredentialStore;
  /**
   * The in-app ranking pass (issue #80): the run itself, plus the free
   * questions the UI asks before offering it. Undefined leaves the "Rank now"
   * control disabled with {@link RANK_UNAVAILABLE_MESSAGE} - which is what a
   * test-built server, and any viewer started without the ranking wiring, gets.
   *
   * The paid gates live inside the wiring, not here: the job refuses itself
   * unless ranking is opted into and a key resolves, and the route below
   * additionally demands an explicit `{ confirm: true }`.
   */
  ranking?: RankWiring;
  /**
   * Runs the one-time X OAuth consent (the same `login()` the CLI calls).
   * Undefined hides the in-app "Connect X" button and tells the owner to run
   * the CLI login instead.
   */
  xLogin?: () => Promise<void>;
}

/** Shown when the Sync button is pressed on a viewer with no ingest wiring. */
export const SYNC_UNAVAILABLE_MESSAGE =
  'Syncing is not available in this viewer. Start it with `node dist/index.js serve`.';

/** Shown when "Rank now" is pressed on a viewer with no ranking wiring. */
export const RANK_UNAVAILABLE_MESSAGE =
  'Ranking is not available in this viewer. Start it with `node dist/index.js serve`.';

/** Shown when a ranking run is started without the explicit paid confirmation. */
export const RANK_CONFIRM_MESSAGE =
  'Ranking is PAID per token. Send { "confirm": true } to authorize a run.';

/** Shown when "Connect X" is pressed on a viewer with no login wiring. */
export const X_LOGIN_UNAVAILABLE_MESSAGE =
  'Connecting to X is not available in this viewer. Run `node dist/index.js login` once instead.';

/** How a one-time X authorization is progressing, polled by the setup flow. */
interface XLoginStatus {
  state: 'idle' | 'running' | 'done' | 'error';
  error: string | null;
}

/** Whether a credential resolved, and from where. Never its value. */
interface CredentialStatus {
  present: boolean;
  source?: string;
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
  score: ViewerScore | null;
};

/**
 * A bookmark's ranking verdict as shipped to the viewer (issue #62), or null
 * when it has never been ranked - which is NOT the same as a score of zero, so
 * the client must render and sort it as "unranked" rather than "worst".
 *
 * `dimensions` rides along because it is small (a handful of numbers) and is
 * what makes a score explainable in the card's tooltip instead of an
 * unaccountable number.
 */
interface ViewerScore {
  /** Weighted overall score, 0..1. */
  value: number;
  /** The model's own confidence, 0..1. */
  confidence: number;
  /** Per-rubric-dimension scores, 0..1. */
  dimensions: Record<string, number>;
}

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
  // A pure read of the `bookmark_scores` table the opt-in `rank` command
  // populates. With ranking never run this is simply empty, and every bookmark
  // ships `score: null` - the viewer's default ordering does not depend on it.
  const scores = db.getBookmarkScores(bookmarks.map((b) => b.id));
  return bookmarks.map((bookmark) => {
    const scored = scores.get(bookmark.id);
    return {
      ...bookmark,
      hasSummary: summarizedIds.has(bookmark.id),
      categoryIds: categoryIdsByBookmark.get(bookmark.id) ?? [],
      xArticle: toViewerXArticle(xArticles.get(bookmark.postId)),
      score: scored
        ? { value: scored.score, confidence: scored.confidence, dimensions: scored.dimensions }
        : null,
    };
  });
}

function parseBookmarkFilter(raw: unknown): BookmarkFilter {
  return raw === 'unread' || raw === 'read' || raw === 'favorite' ? raw : 'all';
}

/**
 * The list's ordering. Anything unrecognized falls back to `recent`, which is
 * the ordering the viewer has always used, so an old client or a typo'd query
 * never silently reorders the library.
 */
function parseBookmarkSort(raw: unknown): BookmarkSortOrder {
  return raw === 'score' ? 'score' : 'recent';
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

  // ---- in-app sync + setup (issue #71) ----------------------------------
  // One runner per server, so "is a sync running" is a fact about the process
  // rather than about whichever browser tab asked. A viewer with no `syncJob`
  // still answers every route below - it just reports sync as unavailable.
  const syncRunner = opts.syncJob ? new SyncRunner(opts.syncJob) : undefined;
  // Same single-slot rule, and for a sharper reason: two ranking runs would pay
  // twice for the same bookmarks.
  const ranking = opts.ranking;
  const rankRunner = ranking ? new RankRunner(ranking.job) : undefined;
  const catalog: SettingsCatalog = buildSettingsCatalog();
  const xLoginStatus: XLoginStatus = { state: 'idle', error: null };

  /** A credential's presence and source - never its value (`AGENTS.md`). */
  function credentialStatus(key: string): CredentialStatus {
    if (!opts.credentials) return { present: false };
    const resolved = opts.credentials.get(key);
    return resolved.value
      ? { present: true, source: resolved.source }
      : { present: false };
  }

  /**
   * The ranking feature's whole state, as both `/api/setup` and `/api/rank`
   * report it. Every field is a cheap local read - the counts are SQL, the
   * blocker is a credential-presence check - so polling it costs nothing and,
   * critically, never touches the paid API.
   */
  function rankingState() {
    return {
      scored: db.countScoredBookmarks(),
      total: db.getBookmarkCount(),
      available: !!rankRunner,
      reason: rankRunner ? undefined : RANK_UNAVAILABLE_MESSAGE,
      blocker: ranking ? ranking.blocker() : null,
      pending: ranking ? ranking.pending() : 0,
      status: rankRunner ? rankRunner.status() : null,
    };
  }

  /**
   * Everything the first-run setup and the Settings panel need, in one round
   * trip: whether the library is empty (the empty-state gate), what has been
   * chosen, what CAN be chosen, and which prerequisites are actually in place.
   */
  app.get('/api/setup', async () => {
    const stored = readSettings(db, catalog);
    return {
      bookmarkCount: db.getBookmarkCount(),
      // "Configured" is the owner having FINISHED setup, not merely having a
      // settings row - a row written by an abandoned half-run would otherwise
      // suppress the guided flow for good.
      configured: !!stored?.configuredAt,
      settings: effectiveSettings(db, catalog),
      catalog,
      credentials: {
        xClientId: credentialStatus('XBOOKMARKS_CLIENT_ID'),
        xClientSecret: credentialStatus('XBOOKMARKS_CLIENT_SECRET'),
        typesafeApiKey: credentialStatus(TYPESAFE_API_KEY),
      },
      x: {
        connected: !!db.getRefreshToken(),
        canConnect: !!opts.xLogin,
        login: xLoginStatus,
      },
      sync: {
        available: !!syncRunner,
        reason: syncRunner ? undefined : SYNC_UNAVAILABLE_MESSAGE,
        lastSyncedAt: db.getLastSyncedAt() ?? null,
        status: syncRunner ? syncRunner.status() : null,
      },
      // How much of the library the opt-in ranking pass has scored (issue #62),
      // so the Settings panel can say whether sorting by score will actually
      // order anything - plus, since issue #80, everything the in-app "Rank
      // now" control needs to decide what to offer: whether the viewer can run
      // the pass at all, why it cannot start yet (ranking off / key missing),
      // how many bookmarks a run would score, and the current run's progress.
      // `blocker` and `pending` are both free to compute: no API call, no spend.
      ranking: rankingState(),
    };
  });

  // Save the categorization choice. Validated against the same catalog the
  // dropdowns were built from, so an unknown provider/model/effort is refused
  // with the list of what exists rather than silently stored and then
  // surprising the owner mid-sync.
  app.put<{ Body?: unknown }>('/api/settings', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { settings, errors } = validateSettings(body, catalog);
    if (errors.length > 0) return reply.code(400).send({ error: errors.join(' '), errors });

    // The first save is what marks setup finished - which is what stops the
    // guided flow reopening on the next load. A later edit in the Settings
    // panel keeps that original timestamp rather than resetting it.
    const previous = readSettings(db, catalog);
    const saved: AppSettings = {
      ...settings,
      configuredAt: previous?.configuredAt ?? new Date().toISOString(),
    };
    writeSettings(db, saved);
    return { settings: saved };
  });

  // Start a sync. Returns immediately with the status; the client polls
  // GET /api/sync for progress, so a run that takes minutes never blocks a
  // request or the UI. 409 when one is already running, with that run's
  // progress so the client can simply attach to it.
  app.post('/api/sync', async (_req, reply) => {
    if (!syncRunner) return reply.code(503).send({ error: SYNC_UNAVAILABLE_MESSAGE });
    // The other half of the "never race a ranking run" rule enforced by
    // POST /api/rank: an ingest must not store bookmarks under a run that has
    // already chosen which ones it is paying to score.
    if (rankRunner?.isRunning()) {
      return reply.code(409).send({ error: 'A ranking run is in progress. Wait for it to finish, then sync.' });
    }
    const { started, status } = syncRunner.start();
    if (!started) {
      return reply.code(409).send({ error: 'A sync is already running.', status });
    }
    return reply.code(202).send({ status });
  });

  // The current (or last) sync's progress. `lastSyncedAt` rides along so the
  // header's indicator refreshes from the same poll.
  app.get('/api/sync', async () => ({
    available: !!syncRunner,
    reason: syncRunner ? undefined : SYNC_UNAVAILABLE_MESSAGE,
    status: syncRunner ? syncRunner.status() : null,
    lastSyncedAt: db.getLastSyncedAt() ?? null,
  }));

  // Start a ranking run (issue #80). The in-app equivalent of typing `rank`,
  // and gated the same way plus one gate the CLI does not need:
  //
  //   * `{ confirm: true }` is REQUIRED. Ranking is billed per input token, so
  //     the paid action must be an explicit authorization, never a stray POST
  //     or a mis-click - the same rule `/api/reset` applies to a destructive
  //     one. The viewer only sends it from a dialog that says the run is paid.
  //   * The opt-in and the key are checked inside the job (`buildRanker` ->
  //     `requireRankerCredentials`, opt-in FIRST), and the same check is
  //     surfaced up front as `ranking.blocker` so the control explains itself
  //     rather than failing on press. It is re-checked here so a direct POST
  //     cannot skip past the UI's copy of the answer.
  //   * A sync is refused as a concurrent run: an ingest is storing the very
  //     bookmarks a run would be selecting, and paying to score a half-written
  //     library helps nobody.
  //
  // Like a sync it returns at once (202) and the client polls GET /api/rank.
  app.post<{ Body?: { confirm?: unknown } }>('/api/rank', async (req, reply) => {
    if (!rankRunner || !ranking) return reply.code(503).send({ error: RANK_UNAVAILABLE_MESSAGE });
    if ((req.body ?? {}).confirm !== true) {
      return reply.code(400).send({ error: RANK_CONFIRM_MESSAGE });
    }
    const blocker = ranking.blocker();
    if (blocker) return reply.code(403).send({ error: blocker });
    if (syncRunner?.isRunning()) {
      return reply.code(409).send({ error: 'A sync is running. Wait for it to finish, then rank.' });
    }
    const { started, status } = rankRunner.start();
    if (!started) {
      return reply.code(409).send({ error: 'A ranking run is already running.', status });
    }
    return reply.code(202).send({ status });
  });

  // The current (or last) ranking run's progress, plus the counts the Order
  // control's hint reads - so one poll refreshes both.
  app.get('/api/rank', async () => ({ ranking: rankingState() }));

  // Run the one-time X OAuth consent. Like a sync it is started, not awaited:
  // it blocks on the owner approving a consent page in another tab, which no
  // HTTP request should sit and wait for. The setup flow polls /api/setup for
  // `x.connected` and `x.login`.
  app.post('/api/x-login', async (_req, reply) => {
    const xLogin = opts.xLogin;
    if (!xLogin) return reply.code(503).send({ error: X_LOGIN_UNAVAILABLE_MESSAGE });
    if (xLoginStatus.state === 'running') {
      return reply.code(409).send({ error: 'An X authorization is already in progress.' });
    }
    xLoginStatus.state = 'running';
    xLoginStatus.error = null;
    void xLogin().then(
      () => {
        xLoginStatus.state = 'done';
      },
      (err: unknown) => {
        xLoginStatus.state = 'error';
        xLoginStatus.error =
          err instanceof Error && err.message
            ? err.message.slice(0, MAX_ERROR_CHARS)
            : 'X authorization failed.';
      },
    );
    return reply.code(202).send({ status: xLoginStatus });
  });

  // Wipe the LOCAL library back to the never-synced state (the next sync
  // re-pulls everything). Destructive, so the body must carry an explicit
  // `confirm: true`, and it is refused mid-sync. Keeps the X token and the
  // saved categorization choice; never touches anything on X.
  app.post<{ Body?: { confirm?: unknown } }>('/api/reset', async (req, reply) => {
    if ((req.body ?? {}).confirm !== true) {
      return reply.code(400).send({ error: 'Send { "confirm": true } to reset the local library.' });
    }
    if (syncRunner?.isRunning()) {
      return reply.code(409).send({ error: 'A sync is running. Wait for it to finish, then reset.' });
    }
    if (rankRunner?.isRunning()) {
      return reply.code(409).send({ error: 'A ranking run is in progress. Wait for it to finish, then reset.' });
    }
    db.resetLibrary();
    syncRunner?.clear();
    rankRunner?.clear();
    return { ok: true, bookmarkCount: db.getBookmarkCount() };
  });

  app.register(fastifyStatic, { root: PUBLIC_DIR });

  // The category tree with rolled-up total/unread counts per node.
  // Save the owner's order of the ROOT categories (issue #82). The body is the
  // complete list of root ids in the wanted order; a child id, an unknown id, a
  // duplicate or an incomplete list is refused, so a stale client can never
  // silently drop or bury a root. Stored by NAME (see `readRootOrder`).
  app.put<{ Body?: unknown }>('/api/categories/root-order', async (req, reply) => {
    const ids = (req.body as { ids?: unknown } | undefined)?.ids;
    if (!Array.isArray(ids) || !ids.every((i) => Number.isInteger(i))) {
      return reply.code(400).send({ error: 'Body must be { "ids": [root category ids] }.' });
    }
    const all = db.getAllCategories();
    const byId = new Map(all.map((c) => [c.id, c]));
    const roots = all.filter((c) => c.parentId === null);
    const seen = new Set<number>();
    for (const id of ids as number[]) {
      const c = byId.get(id);
      if (!c) return reply.code(400).send({ error: `Unknown category id ${id}.` });
      if (c.parentId !== null) {
        return reply.code(400).send({ error: `Category ${id} is not a root category; only roots can be reordered.` });
      }
      if (seen.has(id)) return reply.code(400).send({ error: `Category id ${id} appears twice.` });
      seen.add(id);
    }
    if (seen.size !== roots.length) {
      return reply.code(409).send({
        error: 'The category list changed (a sync may have run). Reload and try again.',
      });
    }
    writeRootOrder(db, (ids as number[]).map((id) => byId.get(id)!.name));
    return { tree: buildCategoryTree(db) };
  });

  app.get('/api/tree', async () => ({ tree: buildCategoryTree(db) }));

  // When bookmarks were last successfully synced with X, or null if never.
  app.get('/api/sync-status', async () => ({ lastSyncedAt: db.getLastSyncedAt() ?? null }));

  // One page of a category's bookmarks, filtered by read state. Paging the
  // filtered set server-side keeps a large category from shipping all at once.
  app.get<{
    Params: { id: string };
    Querystring: { filter?: string; sort?: string; offset?: string; limit?: string };
  }>(
    '/api/categories/:id/bookmarks',
    async (req, reply) => {
      const id = Number.parseInt(req.params.id, 10);
      if (!Number.isInteger(id)) return reply.code(400).send({ error: 'invalid category id' });

      const filter = parseBookmarkFilter(req.query.filter);
      // Ordering is server-side because paging is: sorting one page in the
      // client would only shuffle whichever 20 rows happened to arrive.
      const sort = parseBookmarkSort(req.query.sort);
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
            : filter === 'favorite'
              ? counts.favorite
              : counts.total;
      const bookmarks = db.getBookmarksForCategory(id, { filter, sort, offset, limit });
      const categoryIdsByBookmark = db.getCategoryIdsForBookmarks(bookmarks.map((b) => b.id));

      return {
        bookmarks: toViewerBookmarks(db, bookmarks, categoryIdsByBookmark),
        counts,
        offset,
        limit,
        sort,
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

  // Star or unstar a bookmark (issue #63). Mirrors the read-state toggle
  // above: body { favorite: false } clears the star, anything else sets it.
  // The flag lives on the bookmark row, so it survives a later sync or
  // recategorize exactly like read state does.
  app.post<{ Params: { id: string }; Body?: { favorite?: boolean } }>(
    '/api/bookmarks/:id/favorite',
    async (req, reply) => {
      const id = Number.parseInt(req.params.id, 10);
      if (!Number.isInteger(id)) return reply.code(400).send({ error: 'invalid bookmark id' });
      const updated = db.setFavorite(id, req.body?.favorite !== false);
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
