# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

## What this is

Personal tool: fetch the owner's X bookmarks, LLM-categorize them into a nested tree, store in local
SQLite, browse in a local web viewer. Acceptance spec: `docs/prds/0001-x-bookmarks-organizer.md`.
Setup steps: `docs/setup.md`.

## Stack & layout

- TypeScript on Node (CommonJS, compiled with `tsc` to `dist/`). Entry `src/index.ts` (commands:
  default `run`, `login`, `serve`).
- Ingestion+categorization CLI and the Fastify web viewer both live under `src/`; tests are
  colocated `*.test.ts` (Vitest). `npm test` runs offline with no credentials and no network.
- Web viewer static assets live in `src/web/public/` and are copied to `dist/` by
  `scripts/copy-assets.js` during `npm run build` (tsc alone does not copy them).

## Hard constraints (do not regress)

- **Categorization must run on the Claude subscription, never the paid API.** It now routes through
  the provider abstraction (`src/llm/`, see below), whose ONE adapter - `claude-cli` - shells out to
  the `claude` CLI in print mode. Never introduce `@anthropic-ai/sdk` or require
  `ANTHROPIC_API_KEY`; the adapter strips it from the child env as its subscription-only invariant.
  A hosted, pay-per-token adapter is a future issue and would have to be an explicit, separately
  approved change - no code path may silently spend money.
- **Categorization is two passes** (`src/ingest.ts`): pass 1 designs a taxonomy holistically over
  ALL bookmarks at once (`src/categorize/taxonomy.ts`, Opus-class + high effort, configurable) so
  the tree is genuinely deep; pass 2 files each bookmark into that fixed tree in batches
  (`src/categorize/prompt.ts`, Haiku-class to conserve quota). Pass 1 (the expensive Opus pass)
  runs ONLY on the first run (empty tree) and on `recategorize`. An incremental `run` against an
  existing tree SKIPS pass 1 entirely and never re-touches stored bookmarks: it runs only the cheap
  assignment pass over the NEW bookmarks in `extend` mode (`buildExtendPrompt`), reusing existing
  nodes and creating one only when nothing fits (resolver `resolveOrCreatePathToLeafId`, capped at
  maxDepth). First run and `recategorize` use `strict` mode (`buildPrompt`): pass 2 must not invent
  nodes - off-tree paths fall back to `Uncategorized`. `recategorize` rebuilds both passes over all
  stored bookmarks without re-fetching, preserving read state/dates (it designs the new taxonomy
  BEFORE clearing the old one, so a failed LLM call never wipes the DB).
- **Secrets resolve through a layered credential chain** (`src/creds/resolve.ts`,
  `CredentialStore`): process env (tier 1, unchanged - `av inject` is one example among several,
  never a requirement) -> a gitignored `.env` in the project root -> the OS keychain via the
  platform CLI (`security` / `secret-tool` / `cmdkey`) -> an owner-only (`chmod 600`)
  `~/.config/x-bookmarks-organizer/credentials.json`. First hit wins. `loadConfig` and
  `createLlmFactory` both take an optional `CredentialStore`; omitting it keeps behavior
  byte-identical to env-only, which is what every test that injects a fake `env` relies on. Never
  read a *committed* file, never log or surface a resolved `value` (only its `source` is safe to
  show). The X refresh token is persisted in the (gitignored) SQLite DB via `run_state` - a
  separate, older exception to "nothing written to disk," not part of this chain.
- **Incremental detection is by DB membership, not post date.** `collectNewBookmarks`
  (`src/ingest.ts`) pages the bookmark timeline newest-first and stops at the first already-stored
  `post_id`. Old posts can be freshly bookmarked, so post `created_at` must never be the signal.
- **Batches are stored atomically** (`Database.storeCategorizedBatch`): a bookmark is only marked
  "seen" once it is stored with its categories, so interrupted runs retry cleanly.

## LLM provider abstraction (`src/llm/`)

Every LLM feature depends on the narrow, provider-agnostic port `LlmRunner`
(`src/categorize/llm.ts`) - `(prompt) => Promise<string>` - which is why `Categorizer`,
`LlmTaxonomyDesigner` and `LlmSummaryGenerator` contain zero provider-specific code and their tests
inject a plain fake function. Behind it: `types.ts` (the rich `LlmClient` an adapter implements,
plus `ProviderDefinition`), `registry.ts` (static `registerProvider`/`getProvider`), `factory.ts`
(`createLlmFactory(config, env)` -> `forRole`/`check`/`describe`), `runner.ts` (`toRunner(client)`,
the bridge to `LlmRunner`) and `providers/` (adapters, registered in `providers/index.ts`).

Roles are `taxonomy | assignment | summary | chat`; resolution is per-role override -> global
override -> the provider's own `suggestedFor` suggestion, so the Opus-pass-1 / Haiku-pass-2
economics stay expressible. `XBOOKMARKS_LLM_PROVIDER` selects the provider (default and only value:
`claude-cli`); an unknown id fails with the list of ids that exist. Model names and effort levels
are **provider-specific**: `config.ts` reads them, the adapter validates them (that is where
`VALID_EFFORTS` lives), and a provider that lacks a capability ignores the param rather than
failing. Adapters never read `process.env` - they are handed a `ResolvedProviderConfig.get(key)`,
which is also the offline test seam (`createLlmFactory(config, env)`).

Two things the `claude-cli` adapter must keep doing. It spawns **hardened** -
`--safe-mode --tools "" --max-turns 1` - which is what stops the CWD's own `CLAUDE.md`/`AGENTS.md`
from landing inside every categorization prompt and closes the path from attacker-authored bookmark
text to the filesystem (~29.7k -> ~3.9k tokens per call, no behavior loss). And its `check()` is
"does the `claude` binary resolve and run", **never** "is `CLAUDE_CODE_OAUTH_TOKEN` set" - a CLI
logged in interactively needs no token, and keying availability on the token is the false negative
that disabled the Summarize button (issue #35). Availability drives both the categorization
preflight and the viewer's `/api/summary-status`; a provider that is available but whose call then
fails keeps the button **enabled** and surfaces the adapter's redacted, actionable message in the
modal. Adapter tests point `XBOOKMARKS_CLAUDE_BIN` at a throwaway stub script, so the whole seam is
exercised end to end with no network and no subscription usage.

## Frontend

Before editing anything under `src/web/public/`, follow the `building-frontends` skill and make its
checker pass:
`python3 ~/.claude/skills/building-frontends/scripts/check_frontend.py src/web/public/*` must be PASS.
All colors/spacing are CSS custom properties in `styles.css`; consume `var(--token)`, never raw
literals in component rules. The viewer is an app shell: a fixed header, a **collapsible** category
sidebar (grid-collapse on desktop, `transform` overlay drawer under 820px; state in `localStorage`),
and an independently scrolling content pane; keep tree labels wrapping inside the sidebar (flex
children need `min-width: 0`) so counts never overflow.

A category's posts load lazily in batches (`XBOOKMARKS_PAGE_SIZE`, default 20) via infinite
scroll: `GET /api/categories/:id/bookmarks` takes `filter`/`offset`/`limit` and pages the
read-state-filtered set server-side (`db.getBookmarksForCategory` + `getCategoryBookmarkCounts`),
so a large category is never shipped or embedded all at once. The client (`app.js`) drives it with
an IntersectionObserver sentinel against the content pane; changing the filter re-pages from the
top. The dense-category seed leaf exists to exercise this.

Switching the Unread/Read/All filter (or back to a category already visited) does NOT re-fetch or
re-render from scratch (issue #33): `app.js`'s `viewCaches` snapshots a settled view's DOM
cards + bookmark objects, keyed by category id -> filter, when the owner navigates away from it
(`saveCurrentViewToCache`) - restoring one (`restoreViewFromCache`) reuses the same DOM nodes, so an
already-loaded X embed is never reloaded. Bounded to `XBOFilterCache.MAX_CACHED_CATEGORIES`
categories via LRU eviction (`src/web/public/filter-cache.js`, the pure/testable half of this - LRU
touch/evict and `isFilterEntryStale`). A view mid-fetch is never cached (`viewReady` guard) - caching
one would poison that category+filter with a false "0 results" snapshot if the owner switches
categories again before the fetch settles. A read-state toggle patches the cached "all" entry for
every affected category in place (membership there never changes) but fully INVALIDATES (deletes,
never just prunes) a stale cached Unread/Read entry - across the bookmark's direct categories AND
every ancestor via `XBOTreeCounts.affectedCategoryIds`, since a cached view can be a parent
category's rolled-up list that never appears in the bookmark's own `categoryIds` - so the next visit
fetches fresh rather than silently missing the bookmark in the cache it now belongs to (pruning
alone only makes it disappear from the one it left).

A read-state toggle or delete must NEVER reload/re-render the whole sidebar tree (that flickers
and loses scroll + expand-collapse state) - it patches only the affected counters in place. Each
bookmark the viewer serves carries `categoryIds` (its direct category ids, from
`Database.getCategoryIdsForBookmarks`, added in the `/api/categories/:id/bookmarks` response); a
counter update walks each id's ancestor chain and applies a total/unread delta once per
deduplicated affected category (`src/web/public/tree-counts.js`, `applyCountDelta` +
`updateSidebarCounts`/`patchCategoryCountDom` in `app.js`), because a category's rolled-up counts
include all descendants (`assembleTree` in `src/categorize/tree.ts`) and a multi-category bookmark
must not double-adjust a shared ancestor. The category tree renders with every node - including
roots - collapsed by default until the owner expands it or a search match forces ancestors open.

The per-root tree tint (`tree-color.js`) has a paired on/off toggle, persisted in localStorage
(`readColorEnabled`/`writeColorEnabled`, default **off** - a plain tree - since issue #30) via a
`body[data-tree-colors="on"]` CSS attribute; guard every localStorage access in try/catch (private
mode / blocked storage).

The light/dark theme toggle (`theme.js`'s `readStoredTheme`/`writeTheme`/`effectiveTheme`, wired in
`app.js`'s `initThemeToggle`) sets `data-theme="light"|"dark"` on `<html>`, overriding the
`prefers-color-scheme` media query default until the owner picks explicitly; persisted the same
guarded-localStorage way. The toggle's sun/moon icon visibility is driven purely by CSS keyed off
that same `data-theme` attribute (`:root[data-theme="dark"] .theme-toggle .icon-sun { display:
none; }` and the inverse) rather than JS toggling the SVG's `hidden` property - that property was
observed to silently desync from the attribute in an automated test session, so any per-state
icon/visual swap in this viewer should prefer a CSS attribute selector over JS-driven `hidden`/
`style.display`.

Every bookmark card renders at the same fixed-width column (`--post-card-measure`, centered) no
matter its post's length - a bug fix from issue #30 after cards had drifted to shrink-wrapping
short posts; the read/unread toggle (`.read-pill`) reserves a `min-width` sized to the wider
"Mark as read" label so toggling it never reflows the row's other controls. Only the unread -> read
direction is spelled out as an ACTION ("Mark as read"); a read post's label is its STATE ("Read"),
not a second action label - an explicit owner correction to issue #54 away from a first draft that
used "Mark as unread" for the read state too. The pill stays clickable either way (clicking "Read"
marks it unread again). The pure `readToggleLabel(read)` in `read-toggle.js` computes the label,
shared between `app.js` and `read-toggle.test.ts` the same way `tree-counts.js` is. The action row's
"Open on X" control was removed in the same change as redundant: the official X embed (and, when it
can't render, its `renderEmbed` text+link fallback "View this post on X") already opens the post on
X, so every card keeps a working click-to-X path without a dedicated button.

Each embed slot (`renderEmbed` in `app.js`) shows a skeleton + spinner immediately and reveals
only the finished result: it renders into a hidden host and swaps to the embed when
`twttr.widgets.createTweet(...)` resolves with an element, or to the text+link fallback when it
resolves `undefined` (deleted/protected), rejects, or a backstop timeout fires - never an infinite
spinner and never a raw-text flash. This runs per card, so lazy-loaded batches get it too. The seed
uses a couple of real public post ids so a live embed appears alongside the fallbacks.

To iterate on the viewer without the owner's private DB, seed a throwaway one and serve it:
`npm run build && npm run seed:dev && XBOOKMARKS_DB_PATH=data/dev-seed.db node dist/index.js serve`
(`scripts/seed-dev-db.js` builds a deep sample taxonomy; `data/*.db` is gitignored - never commit
real data).

## Article extraction (issue #4, reader removed in the "summarize-ux" change)

`src/articles/extract-link.ts` finds the primary link in a bookmark's stored post text (all
links are t.co-shortened by X, so this cannot tell an article from a link back to a post
until it is fetched); `src/articles/fetch-article.ts` fetches it server-side (timeout,
`NON_ARTICLE_HOSTS` short-circuits an x.com/twitter.com link, redirects followed so
t.co/shorteners resolve to the real destination before extraction) and extracts it with
`@mozilla/readability` over a `linkedom` DOM, sanitizing the result with `sanitize-html`
before it is ever cached or served - never trust fetched HTML. Results (success or
failure) are cached in the `articles` table (`src/db/schema.ts`, keyed by `bookmark_id`)
via `Database.getArticleForBookmark` / `saveArticle`, so a bookmark's link is fetched at
most once. There is no longer a standalone in-app "Read article" reader or an
`/api/bookmarks/:id/article` route - it was removed as redundant with the card X's own
embed already renders for an external link. This extraction/cache still exists solely to
feed Summarize (`getOrFetchArticle` in `src/web/server.ts`, called only from the summary
endpoint) and, via a separate URL-keyed cache, categorization (issue #25 below).
A cached `failed` row is served forever; `refetch-articles` (`src/articles/refetch.ts`) is the
explicit retry, and it drops only a recovered bookmark's (body-less) summary. When Readability
rejects a page, `extractArticle` falls back to `extractProseFallback`: the page's own paragraphs
rebuilt as escaped plain text, gated on real prose (`MIN_FALLBACK_PROSE_*`) so an app shell, video
or landing page still yields no body - real SPA pages (prose in a crawler copy under a loading
placeholder) are why it exists.
`ServerOptions.articleFetcher` is the injection seam for offline tests (mirrors the
`XClient`/`BatchCategorizer` pattern) - never let a test hit the real network.
`scripts/copy-assets.js` copies `public/` recursively (`fs.cpSync`), which is what lets
`src/web/public/fixtures/sample-article.html` (a fixture article page with nav/ads/scripts
Readability must strip) ship as a servable asset; both the article tests and the dev seed
(`scripts/seed-dev-db.js`'s "Reader View Demo" category, whose name predates the removal)
point at it so extraction is exercised fully offline, end to end, with zero real network
calls. `HttpArticleFetcher`'s `USER_AGENT` is a realistic desktop browser string, not a
self-identifying one - some sites' basic anti-scraping checks 404/403 an honest bot UA even
though the page resolves fine for a real browser (issue #28); its tests spin up a real local
`http` server (not just a mocked `fetch`) to exercise actual redirect-following and this UA
behavior end to end.

## On-demand bookmark summaries (issue #5)

Clicking "Summarize" (or "Summary", once one is saved) on a card opens a large in-app modal
with an on-demand LLM summary of the bookmark: the post text, plus its extracted article
content (reusing the fetch/cache above) when the link is an article. Generated via
`LlmSummaryGenerator` (`src/summarize/summarizer.ts`), which runs on the `summary` role's
runner from the same provider factory as categorization (Sonnet-class model by default, chosen
for summary quality over the Haiku-class assignment/taxonomy models - see `models` in
`src/llm/providers/claude-cli.ts`, overridable via `XBOOKMARKS_SUMMARY_MODEL`) - never the
paid API. Cached in the `summaries` table (`src/db/schema.ts`, keyed by
`bookmark_id`) via `Database.getSummaryForBookmark` / `saveSummary`, so a bookmark is
summarized at most once. Server surface: `GET /api/bookmarks/:id/summary` (cache-or-generate)
and `GET /api/summary-status` (`{ available, reason? }`, used by the client to disable/tooltip
the button up front - `reason` is the provider's own message). `ServerOptions.summaryGenerator`
(plus `summaryUnavailableReason`) is the injection seam for offline tests.

The bookmark list endpoint (`toViewerBookmarks` in `src/web/server.ts`) exposes `hasSummary`
(a cheap `Database.getSummarizedBookmarkIds` existence check, never the summary text) so the
action-row control can render "Summary" (a saved one exists, always openable from cache - no
provider needed) vs "Summarize" (generates on demand, needs the provider); `app.js`'s
`applySummarizeButtonLabel`/`markSummarized` flip a card's button in place after a fresh
generation, without a full reload. `node dist/index.js clear-summaries`
(`Database.clearSummaries`, wired in `src/index.ts`) deletes every cached summary - the fix
for a bad-summary bug (e.g. a cached refusal string) is to wipe and regenerate, never a
migration; it is explicit-only and idempotent.

A summary is only ever built from content that is already IN the prompt: the post's own prose
(`postProse` strips the opaque `t.co` URLs X leaves in the text), the reader-view article body,
or - when the body could not be read - the ingest-time link-metadata cache's OG title/description
(a pure cache read; the endpoint never fetches for this). When `hasSummarizableContent` finds none
of those, the endpoint answers **422 with `NOTHING_TO_SUMMARIZE_MESSAGE` without calling the
model**, and the client renders it as a calm explanatory state with no Retry. This is load-bearing:
the `claude-cli` adapter is hardened with `--tools ""` (no web fetch, by design - see above), so a
prompt whose only subject is a URL is unanswerable and the model replies "I can't access external
URLs... paste the post text" - which was then cached as if it were the summary. Never "fix" that by
re-enabling the CLI's tools; put the content in the prompt or say there is none.

Unlike ingestion/categorization, the web viewer needs no secrets to browse. `cmdServe`
(`src/index.ts`) wires a real `LlmSummaryGenerator` only when the summary role's provider reports
`check() === 'ok'`, leaving it `undefined` otherwise. Then `/api/bookmarks/:id/summary` returns 503
with the provider's actionable message instead of crashing or hanging, and the client disables the
button with that message as its tooltip; a *failed call* on an available provider returns 502 with
the adapter's message and the button stays enabled so a retry is possible. Browsing and
already-cached summaries never require any provider at all.

The stored summary is Markdown, not plain prose: `buildSummaryPrompt` asks the model for a
short lead, a tight bullet list and/or short paragraphs, and **bold** on key terms (structure
only where it aids clarity - a one-line post still gets one plain sentence). The viewer never
inserts model output as raw HTML - `src/web/public/render-markdown.js` (`renderSummaryMarkdown`)
parses the Markdown with `marked` and sanitizes the result with `DOMPurify` against a tight
tag/attribute allowlist (`p, strong, em, ul/ol/li, code, pre, a, br, h3/h4`; `href` only,
http(s)-only `ALLOWED_URI_REGEXP`) before `app.js`'s `renderSummaryResult` sets it as
`innerHTML` - this is the one deliberate `innerHTML` write in the viewer, and it must stay
paired with that sanitize step; the summary is model output derived from untrusted
bookmark/article content, so treat it as hostile input, never trusted markup. `marked`/
`dompurify` are vendored as plain `<script>` globals under `src/web/public/vendor/` (copied
into `dist/` by `copy-assets.js` like every other public asset) rather than loaded from a CDN,
matching how the rest of the viewer ships; re-vendor by copying `node_modules/marked/lib/marked.umd.js`
and `node_modules/dompurify/dist/purify.min.js`. `render-markdown.test.ts` exercises the same
module in Node via `jsdom` (added as a devDependency solely for this - `DOMPurify` needs a real
DOM and silently no-ops against `linkedom`, unlike the rest of this codebase's browser-JS tests
which avoid a DOM dependency entirely) plus real `marked`/`dompurify`, injected as its offline
test seam; this is the one browser module in `src/web/public/` that needs jsdom; keep new ones
DOM-free where possible instead of extending this pattern. A pre-existing plain-text summary
(saved before this change) still renders correctly - Markdown with no syntax is just a
paragraph - so no migration or backfill is needed; `clear-summaries` (above) is only for an
owner who wants the *formatted* style on existing summaries.

**Environment gotcha, not caused by this change:** a bare `npm install` in this worktree can
leave `vitest`'s `rolldown` dependency without its platform native binding (`Cannot find native
binding` from `@rolldown/binding-<platform>`) - this is the long-standing npm optional-deps bug
(npm/cli#4828), reproducible even on an unmodified checkout. Fix with
`npm install --no-save @rolldown/binding-<platform>@<rolldown's exact version>` (e.g.
`darwin-arm64`) rather than reinstalling `node_modules` again, which reproduces it.

## Article title as a categorization signal (issue #25)

A link-heavy bookmark (little text besides a URL) otherwise gives the categorizer almost nothing
to go on and falls back to `Uncategorized`. `src/articles/link-metadata.ts`'s `buildArticleContext`
fixes this: for each bookmark whose text contains a link (`extractArticleLink`), it fetches the
linked article's title/excerpt by reusing the same `ArticleFetcher` interface as the #4 reader view
(`src/articles/fetch-article.ts`), then feeds a `Map<postId, ArticleContext>` into BOTH
`taxonomy.ts`'s `buildTaxonomyPrompt` and `prompt.ts`'s `buildPrompt`/`buildExtendPrompt` (an
optional trailing arg on each, and on `TaxonomyDesigner.designTaxonomy` /
`BatchCategorizer.categorizeBatch`). Cached in a dedicated `article_link_metadata` table
(`src/db/schema.ts`), keyed by **URL, not bookmark id** - unlike the #4 `articles` cache, this must
be populated during `runIngest`/`recategorizeAll` categorization, before a new bookmark has a
bookmark id, and URL-keying also dedups bookmarks that share a link. A failure or thrown error is
cached too (mirrors `articles`), so a dead link is not retried every run, and a bounded number of
distinct URLs are fetched concurrently (`buildArticleContext`'s `concurrency` param) so a large
batch never fetches serially. `IngestDeps.articleFetcher` / `RecategorizeDeps.articleFetcher` is the
injection seam for offline tests (defaults to a real `HttpArticleFetcher`, mirroring
`ServerOptions.articleFetcher`) - a fetch failure/timeout silently degrades to the pre-#25 signal
(post text + domain only) and never blocks ingest. Because `recategorizeAll` re-runs both passes
over every stored bookmark, it is also how the owner reaches this benefit for bookmarks already
sitting in `Uncategorized` from before this feature existed.

## Preview cards vs. readable articles (issues #26, #45, #46)

A **preview card** and a **readable article** were originally two independent capabilities.
A card needs only OpenGraph/`twitter:*` metadata, which most pages have (tools, repos,
videos, product pages); a readable body is rarer. So `article_link_metadata.status` stays
TRI-state - `ok` (readable body, and enough metadata for a card), `card` (metadata only, no
body) or `failed` (nothing usable). But the viewer no longer renders its own preview card
below the embed (issue #46): the embedded tweet already shows X's own card for an external
link, so a second card under it was always a visible duplicate. The in-app "Read article"
reader that `status === 'ok'` used to gate was itself later removed (see the article
extraction section above) as an equally redundant duplicate of that same embed card.
`resolveArticleLinkMetadata` (`src/articles/link-metadata.ts`) is still the
single place that decides which of the three a fetch produced; a `card` row is still real
content for the parts that consume it - it feeds the categorization context (issue #25) and
the summary prompt (issue #5) exactly like an `ok` row does. Only the viewer's rendered card
was removed - the fetch, the cache, and every non-card consumer of it are untouched.

**`t.co` does not HTTP-redirect for a browser User-Agent.** It answers the realistic UA
issue #28 introduced with HTTP 200 and a tiny `<meta refresh>` + `location.replace(...)`
bounce page (a bot UA still gets a 301), so `fetch`'s `redirect: 'follow'` never reaches
the destination and EVERY link in the library died at that interstitial. `HttpArticleFetcher`
therefore follows HTML interstitials itself (`extractInterstitialRedirect`, bounded hops,
only on a page with no visible text) and reports the `resolvedUrl` it landed on - which is
what the card's domain and "open the original" must use, never the `t.co` URL. Validate
any change to this against REAL links, not fixtures: fixtures cannot reproduce it.

"Confirmed" (a readable article body, as opposed to a card-only or failed link) means
`article_link_metadata.status === 'ok'` (the same URL-keyed cache issue #25 introduced): `src/articles/fetch-article.ts`'s
`extractArticle` scrapes the card (`extractLinkPreview`, OpenGraph -> `twitter:*` ->
`<meta name=description>`/`<title>`) from the same parsed document used for Readability,
onto a `preview: LinkPreviewData | null` carried by BOTH result variants (sanitized:
whitespace-collapsed, length-capped, image resolved to an absolute http(s) URL or dropped);
a card with no title is null, since a domain-only box beats nothing by less than the plain
link does. `link-metadata.ts`'s `resolveArticleLinkMetadata` prefers those fields over the
plain `title`/`excerpt`/`siteName` ones, and a card on a FAILED body extraction is exactly
the `card` outcome. The cache table gained `image`/`site_name`/`resolved_url`
columns (`ArticleLinkMetadata` in `src/types.ts`); `Database`'s constructor runs a
`PRAGMA table_info`-guarded migration (`ARTICLE_LINK_METADATA_ADDED_COLUMNS` in
`src/db/schema.ts`) so an existing on-disk DB gains the columns without losing data.

Critically, the bookmark list endpoint (`toViewerBookmarks` in `src/web/server.ts`) only
ever READS this cache - it never fetches live. The cache is populated once, at ingest time,
by issue #25's `buildArticleContext` (run over every bookmark on `run`/`recategorize`), so
by the time a bookmark reaches the viewer its link has normally already been resolved; this
keeps the list endpoint a fast, offline-testable pure cache read with no network dependency
of its own (and is why `ServerOptions.articleFetcher` is untouched by this feature - it still
only backs the on-demand `/summary` endpoint). A bookmark whose link predates issue #25, or
hasn't been through `recategorize` yet, gains nothing extra for Summarize/categorization
until it has - see issue #39 below for the lightweight way to backfill this without a full
`recategorize`. `resolveManyArticleLinkMetadata`
(concurrency-bounded, dedup'd by URL) is the shared worker-pool ingest uses; the server does
not call it, since it never fetches.

Frontend: the bookmark card renders only the tweet embed and the top action row - no
separate preview card beneath it (removed in issue #46, along with `hasPreview`/`preview`
from the `/api/categories/:id/bookmarks` response; see `toViewerBookmarks` in `server.ts`),
and no "Read article" button either (removed later, along with `hasArticle`/`articleUrl` -
see the article extraction section above).

## Metadata backfill for a pre-existing library (issue #39)

`node dist/index.js backfill-previews` (`src/articles/backfill.ts`'s `backfillArticlePreviews`,
wired in `src/index.ts` next to `run`/`recategorize`) fetches + caches `article_link_metadata` for
already-stored bookmarks whose link has no cached row (or is cached `failed`, with `--retry-failed`)
- for a library synced before issues #25/#26 existed, so Summarize/categorization only need this,
never a full `recategorize` (which would also re-run the Opus taxonomy pass and reshuffle the
tree). It touches ONLY the URL-keyed metadata cache - no bookmark, category, or taxonomy row is
read or written - and reuses `resolveManyArticleLinkMetadata`/`resolveArticleLinkMetadata`
(`src/articles/link-metadata.ts`) exactly as ingest and the viewer do, via a cache view that reports
the selected urls as uncached so the real fetch-or-cache path runs unmodified; it is not a second
fetcher. Idempotent and resumable: a url already cached `ok` (or `failed` without `--retry-failed`)
is skipped, so re-running only touches what's still missing. A normal `run` already backfills new
bookmarks as it ingests them (via `buildArticleContext`), so this command is only needed once per
backlog, or again after `--retry-failed` if links were down and are now reachable.

## X-native Articles (`x.com/i/article/<id>`)

X's embed renders its own long-form Articles as a bare link, and their link is a t.co hop back to
x.com that no fetch can read. The data comes from the X API instead: the bookmarks request asks
for the post `article` field (+ `article.cover_media`, `referenced_tweets.id` for quoted Articles),
parsed **tolerantly** in `src/x/article.ts` (the v2 spec types `article` as a bare object, so the
sub-field names are best-effort; an unreadable shape warns and never drops the bookmark, the first
raw shape is logged once, and a 400 on the new fields falls back to the legacy field set). Stored in
`x_articles`, keyed by the Article's HOST post id; a quote joins via `bookmarks.quoted_post_id`
(`Database.getXArticlesForBookmarks`). It feeds: the viewer's "X Article" card (`xArticle` in the
list response, `renderXArticleCard` in `app.js` - independent of the removed #46 preview card),
categorization context (`buildArticleContext` uses title/preview and skips the link fetch), and
Summarize (`plain_text` as the article body). `backfill-x-articles` (`src/x/backfill-articles.ts`)
reads it for already-stored bookmarks via `GET /2/tweets?ids=` - PAID reads, so it selects only
bookmarks whose cached `resolved_url` is an X Article or X post, supports `--dry-run`, and only
authenticates when there is something to read.

## Quoted-post content, and structured content for a ranker

A quoted ORDINARY post's content (author + text + created_at) is captured from the same
`includes.tweets[]` the bookmarks/lookup request already expands via `referenced_tweets.id` - no
second X API call - and stored in `quoted_posts` (`src/db/database.ts`, keyed by the quoted post's
own id, mirroring the `x_articles` pattern). A quoted post that hosts an X Article is left OUT of
`quoted_posts` on purpose - its body lives solely in `x_articles`, joined the same way via
`bookmarks.quoted_post_id`, so it is never duplicated.

`src/content/bookmark-content.ts`'s `BookmarkContent` assembles a bookmark's full content into
named, self-describing parts (`post`, `quotedPost`, `linkedArticle`, `xArticle`, each carrying a
`kind` label) for a downstream content-scoring/re-ranking tool that must never have to guess what a
piece of text represents. `linkedArticle.body` is included only when the reader-view extraction
(the #4 `articles` cache) is already cached - it stays lazy, never fetched by this read. Exposed as
pure DB reads via `GET /api/bookmarks/:id/content` and a paged `GET /api/content` (see the README's
"Structured bookmark content" section for the exact shape); no ranker logic lives here - this is
data plumbing only.

## Live vs. tested

The live OAuth browser consent and the vault-injected run are performed by the operator. Automated
validation uses fixtures/mocks for both the X API (`XClient` interface) and the LLM
(`BatchCategorizer` interface); keep those seams so tests stay offline.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
