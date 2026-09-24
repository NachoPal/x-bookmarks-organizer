import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import fastifyStatic from '@fastify/static';
import type {
  BookmarkFilter,
  BookmarkSortDirection,
  BookmarkSortOrder,
  Database,
} from '../db/database';
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
import { buildSettingsCatalog, catalogKeyNames, type SettingsCatalog } from '../settings/catalog';
import { CLAUDE_CLI_PROVIDER_ID } from '../llm/providers/claude-cli';
import type { Health } from '../llm/types';
import { verifyCatalogModels, type ModelBrowser } from '../settings/model-browser';
import {
  effectiveSettings,
  readSettings,
  validateSettings,
  writeSettings,
  type AppSettings,
} from '../settings/settings';
import { TYPESAFE_API_KEY } from '../config';
import type { CredentialStore, DotenvExposure } from '../creds/resolve';
import {
  listPresets,
  readPresetDoc,
  resolveActiveRubric,
  writePresetDoc,
  activePreset as readActivePreset,
} from '../rank/preset-store';
import {
  DEFAULT_PRESET_ID,
  newPresetId,
  toPresetView,
  validatePreset,
  MAX_DIMENSIONS,
  MAX_LEVELS,
  MIN_LEVELS,
} from '../rank/presets';
import { SyncRunner, type SyncJob } from './sync';
import { RankRunner } from './rank';
import type { RankWiring } from './rank-job';
import type { ArticleRecord, StoredBookmark, SummaryRecord } from '../types';
import type { PaidPass, RoleSpend } from './paid-spend';
import { SummaryFailureBackoff } from './summary-backoff';

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
   * How the summary role is billed (security review 2, #20), reported by
   * `/api/summary-status` so the viewer can mark Summarize as paid at the
   * point of use. Undefined (a test-built server) reports nothing, which the
   * viewer reads as "not billed per token".
   */
  summarySpend?: RoleSpend;
  /**
   * How long a failed summary suppresses automatic re-generation
   * (`SummaryFailureBackoff`). Tests pass a clock-free short window; the
   * default is `SUMMARY_FAILURE_BACKOFF_MS`.
   */
  summaryFailureBackoff?: SummaryFailureBackoff;
  /**
   * The passes of the next sync that will be billed per token (security
   * review 2, #20) - `createSyncSpend`. A non-empty answer makes
   * `POST /api/sync` refuse without `{ confirm: true }`. Undefined (a
   * test-built server) means nothing is paid, so a sync starts as before.
   */
  syncSpend?: () => Promise<PaidPass[]>;
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
   * Whether the chain's `.env` is readable by other local users (security
   * finding #8): its path and mode, or null when it is owner-only or absent.
   * A function, not a value, so a `chmod 600` clears the setup surface's
   * notice on the next read with no restart. Undefined (every test-built
   * server) reports nothing and touches no file.
   */
  dotenvExposure?: () => DotenvExposure | null;
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
   * The process's `XBOOKMARKS_RANKER_INTERESTS`, which augments the BUILT-IN
   * rubric preset only (`src/rank/rubric.ts`). The viewer needs it to resolve
   * the ACTIVE preset's version tag - the one every score read below is scoped
   * to - so that a viewer started with interests set agrees with the runs it
   * starts about which scores are current. A test-built server omits it and
   * gets the plain built-in version, which is what its fixtures store.
   */
  rankerInterests?: string;
  /**
   * Runs the one-time X OAuth consent (the same `login()` the CLI calls).
   * Undefined hides the in-app "Connect X" button and tells the owner to run
   * the CLI login instead.
   */
  xLogin?: () => Promise<void>;
  /**
   * Lists a provider's full model catalog, one source at a time, for the
   * settings selector's searchable model picker (`GET /api/models`) - and
   * checks a pinned model against it on save. A LOCAL read of catalog data
   * the provider ships with: no request, no key, no spend. Undefined answers
   * that route 503 and leaves a save to the shape check alone, which is what a
   * test-built server gets.
   */
  modelBrowser?: ModelBrowser;
  /**
   * Whether `claude-cli` can actually run right now - its OWN `check()`
   * (issue #35: "does the binary resolve and run", never a token's
   * presence), the same signal the summary preflight already trusts. This is
   * what lets the settings form disable Save for a chosen claude-cli pass
   * when the CLI is not installed or not logged in, since claude-cli has no
   * credential-chain key for `providerKeys` to report missing.
   *
   * Undefined (a test-built `buildServer(db)`, which is most of the test
   * suite) reports it always available and spawns nothing - real tests that
   * care inject a fake here, exactly like `articleFetcher`/`summaryGenerator`.
   * `cmdServe` wires the real provider's `check()`.
   */
  claudeCliCheck?: () => Promise<Health>;
}

/** Shown when the model picker asks a viewer with no model browser for a list. */
export const MODELS_UNAVAILABLE_MESSAGE =
  'Browsing the model catalog is not available in this viewer. Start it with `node dist/index.js serve`.';

/** Shown when the Sync button is pressed on a viewer with no ingest wiring. */
export const SYNC_UNAVAILABLE_MESSAGE =
  'Syncing is not available in this viewer. Start it with `node dist/index.js serve`.';

/** Shown when "Rank now" is pressed on a viewer with no ranking wiring. */
export const RANK_UNAVAILABLE_MESSAGE =
  'Ranking is not available in this viewer. Start it with `node dist/index.js serve`.';

/** Shown when a ranking run is started without the explicit paid confirmation. */
export const RANK_CONFIRM_MESSAGE =
  'Ranking is PAID per token. Send { "confirm": true } to authorize a run.';

/** Shown when ONE bookmark is ranked without the explicit paid confirmation. */
export const RANK_ONE_CONFIRM_MESSAGE =
  'Ranking is PAID per token. Send { "confirm": true } to authorize scoring this bookmark.';

/** Shown when a sync with a per-token pass is started without the explicit paid confirmation. */
export const SYNC_CONFIRM_MESSAGE =
  'This sync includes a pass billed per token. Send { "confirm": true } to authorize it.';

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
function toViewerBookmarks(
  db: Database,
  bookmarks: StoredBookmark[],
  categoryIdsByBookmark: Map<number, number[]>,
  rubricVersion: string,
): BookmarkForViewer[] {
  const xArticles = db.getXArticlesForBookmarks(bookmarks);
  const summarizedIds = db.getSummarizedBookmarkIds(bookmarks.map((b) => b.id));
  // A pure read of the `bookmark_scores` table the opt-in `rank` command
  // populates, scoped to the ACTIVE preset's rubric (issue #102). With ranking
  // never run this is simply empty, and every bookmark ships `score: null` -
  // the viewer's default ordering does not depend on it. A bookmark judged only
  // under some OTHER preset ships `score: null` too, which is the honest
  // answer: these rules have no opinion of it yet, and that is exactly what the
  // hollow "not ranked" badge and the unranked dot are for.
  const scores = db.getBookmarkScores(bookmarks.map((b) => b.id), rubricVersion);
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

/**
 * Which way the ordering runs (issue #97). Both fields default to `desc` -
 * newest first / highest first - which is the only ordering that existed
 * before this parameter, so a client that never sends `dir` is unchanged.
 */
function parseBookmarkDirection(raw: unknown): BookmarkSortDirection {
  return raw === 'asc' ? 'asc' : 'desc';
}

/** Parse a non-negative integer query param, falling back to {@link fallback}. */
function parseNonNegInt(raw: unknown, fallback: number): number {
  const parsed = typeof raw === 'string' ? Number.parseInt(raw, 10) : NaN;
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

/** 403 bodies for the guard below, so the client can tell the two apart. */
export const UNEXPECTED_HOST_MESSAGE =
  'Unexpected Host header. The viewer only answers requests addressed to its own loopback address.';
export const CROSS_ORIGIN_MESSAGE = 'Cross-origin request refused.';

/** The loopback names a browser can legitimately address this server by. */
function allowedHostsFor(port: number): Set<string> {
  const names = ['127.0.0.1', 'localhost', '[::1]'];
  const hosts = names.map((name) => `${name}:${port}`);
  // A browser omits the port when it is the scheme's default.
  if (port === 80) hosts.push(...names);
  return new Set(hosts);
}

/**
 * Refuse any request that was not addressed to this server's own loopback
 * address (security review finding 2).
 *
 * Binding to `127.0.0.1` keeps a LAN peer out but does nothing against DNS
 * rebinding: a page on `evil.example` whose name is re-resolved to `127.0.0.1`
 * becomes SAME-ORIGIN with the viewer, which makes CORS irrelevant and hands
 * it an API with no authentication - including the irreversible
 * `DELETE /api/categories/:id`. A rebound request still carries the attacker's
 * hostname in `Host`, so checking it is what closes that door.
 *
 * The `Origin` half covers the state-changing routes a plain cross-origin form
 * can reach without a preflight (the body-less `POST /api/sync` and
 * `POST /api/x-login` of finding 5, and the side-effecting
 * `POST /api/bookmarks/:id/summary` of finding 6). It is skipped for GET and
 * HEAD, which is why no route with a side effect may be a GET.
 *
 * The `Sec-Fetch-Site` half is the backstop for exactly that rule: a cross-site
 * `<img>` or `<script>` carries the viewer's own loopback `Host` and no
 * `Origin`, so the two checks above let it through, but every current browser
 * labels it `cross-site` (or `same-site`, from another loopback port). No such
 * request has any business with `/api/`, so it is refused whatever its method.
 * A header-less client (curl, the tests) and the app's own `same-origin` calls
 * are unaffected; a typed-in navigation is `none`.
 *
 * The app's own `app.js` calls pass all three: their `Host` is the loopback the
 * server is listening on, and their `Origin`, when the browser sends one, is
 * that same loopback.
 *
 * The port comes from the socket the server actually bound, so an overridden
 * `XBOOKMARKS_WEB_PORT` and a test's ephemeral port are both correct with no
 * wiring. A server that is not listening has no socket to rebind - that is a
 * `buildServer(db)` driven by `app.inject()` in tests - so the guard stands
 * down rather than inventing a port it cannot know.
 */
function installLocalOriginGuard(app: FastifyInstance): void {
  app.addHook('onRequest', async (req, reply) => {
    // Judged on the route matched as well as the raw path, so a
    // percent-encoded or otherwise disguised path cannot reach an `/api/`
    // handler around it.
    const site = req.headers['sec-fetch-site'];
    const isApi = req.url.startsWith('/api/') || req.routeOptions.url?.startsWith('/api/') === true;
    if ((site === 'cross-site' || site === 'same-site') && isApi) {
      return reply.code(403).send({ error: CROSS_ORIGIN_MESSAGE });
    }

    const address = app.server.address();
    if (address === null || typeof address === 'string') return;
    const allowed = allowedHostsFor(address.port);

    if (!allowed.has((req.headers.host ?? '').toLowerCase())) {
      return reply.code(403).send({ error: UNEXPECTED_HOST_MESSAGE });
    }

    const origin = req.headers.origin;
    if (!origin || req.method === 'GET' || req.method === 'HEAD') return;
    let originHost: string;
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      return reply.code(403).send({ error: CROSS_ORIGIN_MESSAGE });
    }
    if (!allowed.has(originHost)) {
      return reply.code(403).send({ error: CROSS_ORIGIN_MESSAGE });
    }
  });
}

/**
 * Build the local web viewer server. All state comes from the injected
 * {@link Database}; the server itself is stateless and safe to restart.
 */
export function buildServer(db: Database, opts: ServerOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  installLocalOriginGuard(app);
  const pageSize = opts.pageSize && opts.pageSize > 0 ? opts.pageSize : DEFAULT_PAGE_SIZE;
  const articleFetcher = opts.articleFetcher ?? new HttpArticleFetcher();
  const summaryGenerator = opts.summaryGenerator;
  const unavailableReason = opts.summaryUnavailableReason ?? SUMMARY_UNAVAILABLE_MESSAGE;
  const summaryBackoff = opts.summaryFailureBackoff ?? new SummaryFailureBackoff();

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
      const error = detail || 'Could not generate a summary. Please try again.';
      // The call may already have been billed (a response cut off at its
      // output limit is paid for in full), so it is not repeated on its own.
      summaryBackoff.record(id, error);
      return reply.code(502).send({ error, retry: 'manual' });
    }

    summaryBackoff.clear(id);
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

  /** The next sync's per-token passes; empty when the viewer has no way to tell. */
  async function paidSyncPasses(): Promise<PaidPass[]> {
    return opts.syncSpend ? opts.syncSpend() : [];
  }

  /** A credential's presence and source - never its value (`AGENTS.md`). */
  function credentialStatus(key: string): CredentialStatus {
    if (!opts.credentials) return { present: false };
    const resolved = opts.credentials.get(key);
    return resolved.value
      ? { present: true, source: resolved.source }
      : { present: false };
  }

  /**
   * `claude-cli` needs no credential-chain key at all (issue #35: a CLI logged
   * in interactively needs no token), so its Save-blocking signal cannot come
   * from `providerKeys` like every other provider - it has to be
   * `opts.claudeCliCheck`, the same `check()` the summary preflight already
   * trusts. That spawns `claude --version` in the real wiring, so it is
   * cached briefly rather than run on every `/api/setup` read - the setup
   * flow alone polls that route every 2s while it waits for X auth.
   */
  let claudeCliAvailability: { checkedAt: number; result: { available: boolean; reason?: string } } | null = null;
  const CLAUDE_CLI_AVAILABILITY_TTL_MS = 5000;

  async function claudeCliStatus(): Promise<{ available: boolean; reason?: string }> {
    if (!opts.claudeCliCheck) return { available: true };
    if (claudeCliAvailability && Date.now() - claudeCliAvailability.checkedAt < CLAUDE_CLI_AVAILABILITY_TTL_MS) {
      return claudeCliAvailability.result;
    }
    const health = await opts.claudeCliCheck();
    const result = { available: health.state === 'ok', reason: health.state === 'ok' ? undefined : health.detail };
    claudeCliAvailability = { checkedAt: Date.now(), result };
    return result;
  }

  /**
   * The ranking feature's whole state, as both `/api/setup` and `/api/rank`
   * report it. Every field is a cheap local read - the counts are SQL, the
   * blocker is a credential-presence check - so polling it costs nothing and,
   * critically, never touches the paid API.
   */
  function rankingState() {
    const preset = readActivePreset(db, opts.rankerInterests);
    const view = toPresetView(preset, opts.rankerInterests);
    return {
      // Scoped to the ACTIVE preset (issue #102), which is what makes
      // "N of M unranked" - and therefore the icon's dot (#98) and the
      // Top-score-enabled gate (#97) - a statement about the rules in force.
      // Switching to a preset nothing was scored under surfaces its bookmarks
      // as unranked and offers a re-rank; it spends nothing by itself.
      scored: db.countScoredBookmarks(view.version),
      total: db.getBookmarkCount(),
      available: !!rankRunner,
      reason: rankRunner ? undefined : RANK_UNAVAILABLE_MESSAGE,
      blocker: ranking ? ranking.blocker() : null,
      pending: ranking ? ranking.pending() : 0,
      status: rankRunner ? rankRunner.status() : null,
      preset: { id: view.id, name: view.name, builtIn: view.builtIn, version: view.version },
    };
  }

  /** The rubric every score read in this server is scoped to. */
  function activeRubricVersion(): string {
    return resolveActiveRubric(db, opts.rankerInterests).version;
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
        // Every key a choosable model can need (each pi upstream's), by NAME
        // with presence + source only, so the selector can say "needs
        // OPENCODE_API_KEY" or "found in .env" at the point of choice.
        providerKeys: Object.fromEntries(catalogKeyNames(catalog).map((name) => [name, credentialStatus(name)])),
        // `claude-cli` has no credential-chain key (issue #35), so its own
        // Save-blocking signal is its `check()`, not a key's presence.
        providerAvailability: { [CLAUDE_CLI_PROVIDER_ID]: await claudeCliStatus() },
        // The same warning the server printed at startup, so an owner who
        // never reads the log still sees that `.env` is exposed.
        dotenvExposure: opts.dotenvExposure ? opts.dotenvExposure() : null,
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
        // What the next sync will bill per token, so the Sync control can
        // confirm it up front (security review 2, #20). A local read.
        paidPasses: syncRunner ? await paidSyncPasses() : [],
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
    if (opts.modelBrowser) {
      const unknown = await verifyCatalogModels(settings, catalog, opts.modelBrowser);
      if (unknown.length > 0) return reply.code(400).send({ error: unknown.join(' '), errors: unknown });
    }

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

  // One source's full model list for the settings selector's searchable
  // picker, e.g. `?provider=pi-ai&source=opencode`. Read from the provider's
  // own bundled catalog - free, no key needed, nothing is called - so it
  // answers for a source the owner has no key for too.
  app.get<{ Querystring: { provider?: string; source?: string } }>('/api/models', async (req, reply) => {
    if (!opts.modelBrowser) return reply.code(503).send({ error: MODELS_UNAVAILABLE_MESSAGE });
    const provider = req.query.provider?.trim();
    const source = req.query.source?.trim();
    if (!provider || !source) {
      return reply.code(400).send({ error: 'Pass both `provider` and `source`, e.g. ?provider=pi-ai&source=openrouter.' });
    }
    let listing;
    try {
      listing = await opts.modelBrowser.list(provider, source);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: `Could not read the model catalog: ${detail.slice(0, 200)}` });
    }
    if (!listing.ok) return reply.code(404).send({ error: listing.error });
    return { provider, source, models: listing.models };
  });

  // Start a sync. Returns immediately with the status; the client polls
  // GET /api/sync for progress, so a run that takes minutes never blocks a
  // request or the UI. 409 when one is already running, with that run's
  // progress so the client can simply attach to it.
  //
  // A sync whose passes include a per-token model (a pi-ai pass, or Jev
  // filing) is a paid run, so it carries the ranking run's gate (security
  // review 2, #20): `{ confirm: true }` is REQUIRED, and the paid passes are
  // re-derived here, at the moment of authorization, from the settings the
  // run will actually use - a stale browser cannot start one unconfirmed. A
  // sync with nothing billed per token needs no body at all, as before.
  app.post<{ Body?: { confirm?: unknown } }>('/api/sync', async (req, reply) => {
    if (!syncRunner) return reply.code(503).send({ error: SYNC_UNAVAILABLE_MESSAGE });
    // The other half of the "never race a ranking run" rule enforced by
    // POST /api/rank: an ingest must not store bookmarks under a run that has
    // already chosen which ones it is paying to score.
    if (rankRunner?.isRunning()) {
      return reply.code(409).send({ error: 'A ranking run is in progress. Wait for it to finish, then sync.' });
    }
    if (!syncRunner.isRunning()) {
      const paidPasses = await paidSyncPasses();
      if (paidPasses.length > 0 && (req.body ?? {}).confirm !== true) {
        return reply.code(400).send({ error: SYNC_CONFIRM_MESSAGE, confirmRequired: true, paidPasses });
      }
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

  // ---- the rubric editor (issue #102) ------------------------------------
  //
  // Named sets of ranking rules ("presets"). The built-in rubric is always
  // present as the default preset and is never editable, renameable or
  // deletable - it is what an owner who never opens the editor runs, under the
  // version tag it has always carried.
  //
  // Every route here needs nothing but `db`, so they are fully live on a
  // `buildServer(db)` with no ranking wiring: authoring rules is free, and a
  // viewer that cannot RUN a paid pass can still perfectly well hold an opinion
  // about what one would ask. Which is the paid-safety point worth stating
  // once: NOTHING below calls TypeSafe or spends anything. Selecting a preset
  // nothing has been scored under only makes those bookmarks read as unranked,
  // which surfaces the #98 dot and offers a re-rank - it never starts one.
  // Spending still happens exactly where it did: POST /api/rank and
  // POST /api/bookmarks/:id/rank, behind `{ confirm: true }`.

  /**
   * Whether the rules may be edited right now. A run in flight is scoring
   * against the ACTIVE preset's rubric and writing rows keyed by its version,
   * so changing which preset is active - or what one contains - mid-run would
   * file those rows under rules that were never used to produce them.
   */
  const rubricWriteBlocker = (): string | null => {
    if (rankRunner?.isRunning()) {
      return 'A ranking run is in progress. Wait for it to finish, then edit your ranking rules.';
    }
    if (syncRunner?.isRunning()) {
      return 'A sync is running. Wait for it to finish, then edit your ranking rules.';
    }
    return null;
  };

  /** The presets, each with the version its scores are keyed by, plus the limits the editor enforces. */
  function rubricState() {
    const doc = readPresetDoc(db);
    const presets = listPresets(db, opts.rankerInterests).map((preset) => {
      const view = toPresetView(preset, opts.rankerInterests);
      return {
        ...view,
        // How much of the library this preset has already judged. It is what
        // lets the selector say "switching here needs a re-rank" BEFORE the
        // switch, and it is a plain COUNT - no call, no spend.
        scored: db.countScoredBookmarks(view.version),
      };
    });
    return {
      activeId: doc.activeId,
      presets,
      total: db.getBookmarkCount(),
      limits: { maxDimensions: MAX_DIMENSIONS, minLevels: MIN_LEVELS, maxLevels: MAX_LEVELS },
    };
  }

  app.get('/api/rubric', async () => rubricState());

  // Create a preset. Validated by the same pure `validatePreset` the editor's
  // own inline checks mirror, so an invalid rubric is refused with one
  // actionable sentence per problem rather than stored and then failing a run.
  app.post<{ Body?: unknown }>('/api/rubric/presets', async (req, reply) => {
    const blocked = rubricWriteBlocker();
    if (blocked) return reply.code(409).send({ error: blocked });

    const doc = readPresetDoc(db);
    const others = listPresets(db, opts.rankerInterests);
    const { preset, errors } = validatePreset(req.body, others);
    if (errors.length > 0) return reply.code(400).send({ error: errors.join(' '), errors });

    const id = newPresetId(preset.name, [DEFAULT_PRESET_ID, ...doc.presets.map((p) => p.id)]);
    const created = { ...preset, id };
    // A new preset becomes ACTIVE: authoring rules the owner then has to go and
    // select separately is a two-step answer to a one-step intention. It costs
    // nothing - the library simply reads as unranked under the new rules until
    // a confirmed, paid run is started.
    writePresetDoc(db, { activeId: id, presets: [...doc.presets, created] });
    return reply.code(201).send({ rubric: rubricState(), ranking: rankingState() });
  });

  // Update a preset in place. The built-in one is not editable (404 by
  // construction: it is synthesized, never stored), which is what guarantees
  // the shipped rubric is always there to fall back to.
  app.put<{ Params: { id: string }; Body?: unknown }>(
    '/api/rubric/presets/:id',
    async (req, reply) => {
      const blocked = rubricWriteBlocker();
      if (blocked) return reply.code(409).send({ error: blocked });

      const doc = readPresetDoc(db);
      const index = doc.presets.findIndex((p) => p.id === req.params.id);
      if (index === -1) {
        return reply.code(404).send({
          error:
            req.params.id === DEFAULT_PRESET_ID
              ? 'The built-in ranking rules cannot be edited. Duplicate them and edit the copy.'
              : 'Those ranking rules no longer exist.',
        });
      }

      // Name uniqueness is checked against every OTHER preset, so re-saving
      // this one under its own name is not a collision.
      const others = listPresets(db, opts.rankerInterests).filter((p) => p.id !== req.params.id);
      const { preset, errors } = validatePreset(req.body, others);
      if (errors.length > 0) return reply.code(400).send({ error: errors.join(' '), errors });

      const presets = [...doc.presets];
      presets[index] = { ...preset, id: req.params.id };
      writePresetDoc(db, { ...doc, presets });
      return { rubric: rubricState(), ranking: rankingState() };
    },
  );

  // Delete a preset. Its SCORES are deliberately left alone: they are keyed by
  // the rubric's content, not by the preset's id, so re-creating the same rules
  // finds them again rather than re-billing for them. `clear-scores` is still
  // the explicit way to throw scores away.
  app.delete<{ Params: { id: string } }>('/api/rubric/presets/:id', async (req, reply) => {
    const blocked = rubricWriteBlocker();
    if (blocked) return reply.code(409).send({ error: blocked });
    if (req.params.id === DEFAULT_PRESET_ID) {
      return reply
        .code(400)
        .send({ error: 'The built-in ranking rules cannot be deleted. They are the fallback.' });
    }

    const doc = readPresetDoc(db);
    if (!doc.presets.some((p) => p.id === req.params.id)) {
      return reply.code(404).send({ error: 'Those ranking rules no longer exist.' });
    }
    const presets = doc.presets.filter((p) => p.id !== req.params.id);
    // Deleting the ACTIVE preset falls back to the built-in one rather than to
    // whichever preset happens to be next in the list: the fallback has to be
    // the same one every time, and the built-in rubric is the only preset that
    // is guaranteed to exist.
    const activeId = doc.activeId === req.params.id ? DEFAULT_PRESET_ID : doc.activeId;
    writePresetDoc(db, { activeId, presets });
    return { rubric: rubricState(), ranking: rankingState() };
  });

  // Choose which preset ranks. Free, and the only thing it changes is which
  // rubric's scores the library reads as current.
  app.put<{ Body?: { id?: unknown } }>('/api/rubric/active', async (req, reply) => {
    const blocked = rubricWriteBlocker();
    if (blocked) return reply.code(409).send({ error: blocked });

    const id = (req.body ?? {}).id;
    if (typeof id !== 'string' || !id) {
      return reply.code(400).send({ error: 'Name the ranking rules to activate.' });
    }
    const doc = readPresetDoc(db);
    if (id !== DEFAULT_PRESET_ID && !doc.presets.some((p) => p.id === id)) {
      return reply.code(404).send({ error: 'Those ranking rules no longer exist.' });
    }
    writePresetDoc(db, { ...doc, activeId: id });
    return { rubric: rubricState(), ranking: rankingState() };
  });

  // Rank ONE bookmark (issue #98): the card's empty score badge, which is the
  // affordance an unranked post carries after a sync added it.
  //
  // Every paid-safety gate of POST /api/rank applies here unchanged and in the
  // same order - `{ confirm: true }`, the opt-in + key (`ranking.blocker`,
  // re-checked server-side), no racing a sync or a whole-library run - because
  // a single call is still a call that is billed. What differs is only the
  // SHAPE: one bookmark is one request, so this awaits the result and hands
  // back the new score (plus the run's log lines, which carry
  // `reportRankerBilling`'s price tag) instead of starting a pollable job.
  app.post<{ Params: { id: string }; Body?: { confirm?: unknown } }>(
    '/api/bookmarks/:id/rank',
    async (req, reply) => {
      if (!ranking) return reply.code(503).send({ error: RANK_UNAVAILABLE_MESSAGE });
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return reply.code(400).send({ error: 'Invalid bookmark id.' });
      if ((req.body ?? {}).confirm !== true) {
        return reply.code(400).send({ error: RANK_ONE_CONFIRM_MESSAGE });
      }
      const blocker = ranking.blocker();
      if (blocker) return reply.code(403).send({ error: blocker });
      if (!db.getBookmarkById(id)) return reply.code(404).send({ error: 'Bookmark not found.' });
      if (rankRunner?.isRunning()) {
        return reply
          .code(409)
          .send({ error: 'A ranking run is in progress. Wait for it to finish, then try again.' });
      }
      if (syncRunner?.isRunning()) {
        return reply.code(409).send({ error: 'A sync is running. Wait for it to finish, then rank.' });
      }

      const messages: string[] = [];
      let summary;
      try {
        summary = await ranking.rankOne(id, (message) => {
          const text = message.trim();
          if (text) messages.push(text);
        });
      } catch (err) {
        // Already redacted and actionable at its own boundary (the credential
        // chain's sentence, or the SDK adapter's) - forwarded, not replaced.
        const detail = err instanceof Error ? err.message.slice(0, MAX_ERROR_CHARS) : '';
        return reply.code(502).send({ error: detail || 'Could not rank this bookmark.' });
      }

      const scored = db.getBookmarkScores([id], activeRubricVersion()).get(id);
      return {
        summary,
        messages,
        score: scored
          ? { value: scored.score, confidence: scored.confidence, dimensions: scored.dimensions }
          : null,
        ranking: rankingState(),
      };
    },
  );

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
  // `confirm: true`, and it is refused mid-sync. Keeps every piece of the
  // owner's configuration - the X token, the saved categorization choice, the
  // authored rubric presets and the root order (see `Database.resetLibrary`);
  // never touches anything on X.
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

  // ---- the category editor (issue #101) ----------------------------------
  // Manual add/remove of categories. Both routes need nothing but `db`, so
  // they are fully live on a `buildServer(db)` with no sync/rank wiring - but
  // a write is refused while a job that is itself writing categories runs.

  /**
   * Whether a category write can happen right now. An ingest is minting and
   * filing categories as it goes and a ranking run is selecting the very
   * bookmarks a delete would remove, so neither may race an edit. Returns the
   * reason to refuse with, or null when the write may proceed.
   */
  const categoryWriteBlocker = (): string | null => {
    if (syncRunner?.isRunning()) {
      return 'A sync is running. Wait for it to finish, then edit your categories.';
    }
    if (rankRunner?.isRunning()) {
      return 'A ranking run is in progress. Wait for it to finish, then edit your categories.';
    }
    return null;
  };

  // Create a category: a root when `parentId` is absent/null, otherwise a
  // child one level under it. A name already taken by a sibling is a 409 (the
  // editor shows it inline beside the input) - deliberately not a silent
  // get-or-create merge, which is what the taxonomy passes want but not what
  // an owner typing a new name is asking for.
  app.post<{ Body?: { name?: unknown; parentId?: unknown } }>('/api/categories', async (req, reply) => {
    const blocked = categoryWriteBlocker();
    if (blocked) return reply.code(409).send({ error: blocked });
    const body = req.body ?? {};
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return reply.code(400).send({ error: 'A category needs a name.' });
    const rawParent = body.parentId;
    let parentId: number | null = null;
    if (rawParent !== undefined && rawParent !== null) {
      if (!Number.isInteger(rawParent)) {
        return reply.code(400).send({ error: 'parentId must be a category id, or omitted for a root category.' });
      }
      const parent = db.getCategoryById(rawParent as number);
      if (!parent) return reply.code(400).send({ error: `Unknown category id ${String(rawParent)}.` });
      parentId = parent.id;
    }
    const created = db.createCategory(name, parentId);
    if (!created) {
      return reply.code(409).send({
        error: parentId === null
          ? `A root category called “${name}” already exists.`
          : `That category already has a “${name}”.`,
      });
    }
    return reply.code(201).send({ category: created, tree: buildCategoryTree(db) });
  });

  // What deleting a category WOULD remove, without touching anything: the
  // category rows and the posts that would be left filed nowhere. This is the
  // number the destructive confirmation states, and it is computed by the same
  // `planCategoryDeletion` the delete itself runs, so the two cannot disagree.
  app.get<{ Params: { id: string } }>('/api/categories/:id/deletion', async (req, reply) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'invalid category id' });
    const category = db.getCategoryById(id);
    const plan = category ? db.planCategoryDeletion(id) : undefined;
    if (!category || !plan) return reply.code(404).send({ error: 'category not found' });
    return {
      category: { id: category.id, name: category.name, isRoot: category.parentId === null },
      removes: {
        categories: plan.categoryIds.length,
        subcategories: plan.subcategoryCount,
        posts: plan.orphanedBookmarkIds.length,
      },
    };
  });

  // Delete a category, its sub-categories and the posts orphaned by that -
  // the owner's rule on issue #101: a post also filed under a surviving
  // category is KEPT and merely unlinked. Irreversible: the deleted posts are
  // tombstoned so a later sync never brings them back. One transaction, and
  // it answers with the counts actually removed plus the rebuilt tree.
  app.delete<{ Params: { id: string } }>('/api/categories/:id', async (req, reply) => {
    const blocked = categoryWriteBlocker();
    if (blocked) return reply.code(409).send({ error: blocked });
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'invalid category id' });
    const removed = db.deleteCategory(id);
    if (!removed) return reply.code(404).send({ error: 'category not found' });
    return { removed, tree: buildCategoryTree(db), bookmarkCount: db.getBookmarkCount() };
  });

  app.get('/api/tree', async () => ({ tree: buildCategoryTree(db) }));

  // When bookmarks were last successfully synced with X, or null if never.
  app.get('/api/sync-status', async () => ({ lastSyncedAt: db.getLastSyncedAt() ?? null }));

  // One page of a category's bookmarks, filtered by read state. Paging the
  // filtered set server-side keeps a large category from shipping all at once.
  app.get<{
    Params: { id: string };
    Querystring: { filter?: string; sort?: string; dir?: string; offset?: string; limit?: string };
  }>(
    '/api/categories/:id/bookmarks',
    async (req, reply) => {
      const id = Number.parseInt(req.params.id, 10);
      if (!Number.isInteger(id)) return reply.code(400).send({ error: 'invalid category id' });

      const filter = parseBookmarkFilter(req.query.filter);
      // Ordering is server-side because paging is: sorting one page in the
      // client would only shuffle whichever 20 rows happened to arrive.
      const sort = parseBookmarkSort(req.query.sort);
      const dir = parseBookmarkDirection(req.query.dir);
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
      // One rubric decides BOTH the ordering and which scores are shipped, so
      // a "Top score" page can never be ordered by one preset's verdicts and
      // labelled with another's.
      const rubricVersion = activeRubricVersion();
      const bookmarks = db.getBookmarksForCategory(id, {
        filter,
        sort,
        dir,
        offset,
        limit,
        rubricVersion,
      });
      const categoryIdsByBookmark = db.getCategoryIdsForBookmarks(bookmarks.map((b) => b.id));

      return {
        bookmarks: toViewerBookmarks(db, bookmarks, categoryIdsByBookmark, rubricVersion),
        counts,
        offset,
        limit,
        sort,
        dir,
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

  // Re-file a bookmark under exactly the given categories (issue #92): the
  // manual move the owner performs by dragging a card onto the sidebar tree,
  // or through the card's category picker. "Move" is re-file, not add (the
  // owner's decision on #92), so the post's other memberships go with it.
  //
  // A move sends one `categoryId`. `categoryIds` (a list) is the SAME
  // operation with more than one target, and exists for one caller: the move
  // toast's Undo (issue #99), which restores whatever membership the post had
  // before - for a multi-labelled post, several categories. Undo is therefore
  // the same re-file run backwards, not a second, differently-behaved route.
  //
  // Each target is validated here rather than in the DB method: an unknown or
  // malformed category id is a bad REQUEST (400), while an unknown bookmark
  // is a missing row (404). Needs nothing but `db`, so it is fully available
  // on a `buildServer(db)` built without the sync/rank wiring.
  app.put<{ Params: { id: string }; Body?: { categoryId?: unknown; categoryIds?: unknown } }>(
    '/api/bookmarks/:id/category',
    async (req, reply) => {
      const id = Number.parseInt(req.params.id, 10);
      if (!Number.isInteger(id)) return reply.code(400).send({ error: 'invalid bookmark id' });
      const raw = req.body?.categoryIds !== undefined ? req.body.categoryIds : req.body?.categoryId;
      const requested = Array.isArray(raw) ? raw : [raw];
      if (requested.length === 0 || !requested.every((value) => Number.isInteger(value))) {
        return reply.code(400).send({
          error: 'Body must be { "categoryId": <category id> } or { "categoryIds": [<category id>, …] }.',
        });
      }
      const categories = [];
      for (const categoryId of requested as number[]) {
        const category = db.getCategoryById(categoryId);
        if (!category) {
          return reply.code(400).send({ error: `Unknown category id ${categoryId}.` });
        }
        categories.push(category);
      }
      if (!db.setBookmarkCategories(id, categories.map((c) => c.id))) {
        return reply.code(404).send({ error: 'bookmark not found' });
      }
      return {
        bookmark: db.getBookmarkById(id),
        categoryIds: categories.map((c) => c.id),
        category: categories[0],
      };
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
  //
  // It also says how a NEW summary is billed (security review 2, #20): the
  // summary role's provider, model, billing and - when its catalog states it -
  // price, so a per-token summary is marked as paid on the button itself
  // rather than only in the console that started the viewer.
  app.get('/api/summary-status', async () =>
    summaryGenerator
      ? { available: true, ...(opts.summarySpend ? { spend: opts.summarySpend } : {}) }
      : { available: false, reason: unavailableReason },
  );

  // The on-demand LLM summary for a bookmark: served from cache once
  // generated. Article-aware when the bookmark's link is an article - the
  // article is fetched/cached the same way the reader view does, so a
  // bookmark whose article was never opened still gets an article-aware
  // summary. 503 (not 500) signals the graceful no-token degradation the
  // owner sees as a clear message rather than a crash or a hang; 422 signals
  // the bookmark simply holds nothing summarizable (see below).
  //
  // A POST, not a GET, although it answers with data: a cache miss fetches the
  // article, calls the model (which may bill per token) and writes a row, and a
  // cross-site `<img>` can issue a GET but not a POST that survives the Origin
  // guard (security review finding 6).
  //
  // A failed generation is NOT repeated by a later request (security review 2,
  // #19): while `summaryBackoff` holds the failure, this answers 429 with it
  // instead of calling the model again. The owner's explicit "Try again" is
  // the retry route below, which is the only path past it.
  app.post<{ Params: { id: string } }>('/api/bookmarks/:id/summary', async (req, reply) =>
    serveSummary(req.params.id, reply, { manualRetry: false }),
  );

  // The owner's deliberate retry of a failed summary: the one request that
  // bypasses the back-off. A POST like the one above, so the Origin guard
  // refuses it from any other site - a page the owner visits can never make it
  // on their behalf.
  app.post<{ Params: { id: string } }>('/api/bookmarks/:id/summary/retry', async (req, reply) =>
    serveSummary(req.params.id, reply, { manualRetry: true }),
  );

  async function serveSummary(rawId: string, reply: FastifyReply, opt: { manualRetry: boolean }) {
    const id = Number.parseInt(rawId, 10);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'invalid bookmark id' });

    const bookmark = db.getBookmarkById(id);
    if (!bookmark) return reply.code(404).send({ error: 'bookmark not found' });

    const cached = db.getSummaryForBookmark(id);
    if (cached) return { summary: cached };

    if (!summaryGenerator) {
      return reply.code(503).send({ error: unavailableReason });
    }

    if (opt.manualRetry) {
      summaryBackoff.clear(id);
    } else {
      const failure = summaryBackoff.active(id);
      if (failure) {
        return reply
          .code(429)
          .header('Retry-After', String(Math.ceil(failure.retryAfterMs / 1000)))
          .send({
            error: failure.error,
            retry: 'manual',
            failedAt: new Date(failure.failedAt).toISOString(),
          });
      }
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
  }

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
