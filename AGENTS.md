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

- **Categorization must run on the Claude subscription, never the paid API.** It shells out to the
  `claude` CLI in print mode (`src/categorize/llm.ts`) using `CLAUDE_CODE_OAUTH_TOKEN`. Never
  introduce `@anthropic-ai/sdk` or require `ANTHROPIC_API_KEY` (the runner even strips it from the
  child env).
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
- **Secrets come only from the environment (Automic Vault `av inject`).** Never read a committed
  `.env`, never write secrets to disk. The X refresh token is persisted in the (gitignored) SQLite
  DB via `run_state`.
- **Incremental detection is by DB membership, not post date.** `collectNewBookmarks`
  (`src/ingest.ts`) pages the bookmark timeline newest-first and stops at the first already-stored
  `post_id`. Old posts can be freshly bookmarked, so post `created_at` must never be the signal.
- **Batches are stored atomically** (`Database.storeCategorizedBatch`): a bookmark is only marked
  "seen" once it is stored with its categories, so interrupted runs retry cleanly.

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
(`readColorEnabled`/`writeColorEnabled`, default on) via a `body[data-tree-colors="off"]` CSS
attribute; guard every localStorage access in try/catch (private mode / blocked storage).

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

## Article reader (issue #4)

A bookmark whose post text contains a link gets a "Read" affordance that opens the
extracted article in an in-app modal. `src/articles/extract-link.ts` finds the primary
link in the stored post text (all links are t.co-shortened by X, so this cannot tell an
article from a link back to a post until it is fetched); `src/articles/fetch-article.ts`
fetches it server-side (timeout, `NON_ARTICLE_HOSTS` short-circuits an x.com/
twitter.com link, redirects followed so t.co/shorteners resolve to the real destination
before extraction) and extracts it with `@mozilla/readability` over a `linkedom` DOM,
sanitizing the result with `sanitize-html` before it is ever cached or served - never trust
fetched HTML. Results (success or failure) are cached in the `articles` table
(`src/db/schema.ts`, keyed by `bookmark_id`) via `Database.getArticleForBookmark` /
`saveArticle`, so a bookmark's link is fetched at most once. Server surface:
`GET /api/bookmarks/:id/article` (`src/web/server.ts`); the bookmark list endpoint also
adds a computed `articleUrl` per bookmark so a card knows whether to show "Read" without
an extra request. `ServerOptions.articleFetcher` is the injection seam for offline tests
(mirrors the `XClient`/`BatchCategorizer` pattern) - never let a test hit the real network.
`scripts/copy-assets.js` copies `public/` recursively (`fs.cpSync`), which is what lets
`src/web/public/fixtures/sample-article.html` (a fixture article page with nav/ads/scripts
Readability must strip) ship as a servable asset; both the article tests and the dev seed
(`scripts/seed-dev-db.js`'s "Reader View Demo" category) point at it so extraction is
exercised fully offline, end to end, with zero real network calls. `HttpArticleFetcher`'s
`USER_AGENT` is a realistic desktop browser string, not a self-identifying one - some sites'
basic anti-scraping checks 404/403 an honest bot UA even though the page resolves fine for a
real browser (issue #28); its tests spin up a real local `http` server (not just a mocked
`fetch`) to exercise actual redirect-following and this UA behavior end to end.

## On-demand bookmark summaries (issue #5)

Clicking "Summarize" on a card opens a large in-app modal with an on-demand LLM summary of the
bookmark: the post text, plus its extracted article content (reusing the reader-view cache/fetch
above) when the link is an article. Generated via `ClaudeSummaryGenerator`
(`src/summarize/summarizer.ts`), which runs on the same subscription-only `claude` CLI runner as
categorization (`createClaudeCliRunner`, Haiku-class model) - never the paid API. Cached in the
`summaries` table (`src/db/schema.ts`, keyed by `bookmark_id`) via `Database.getSummaryForBookmark`
/ `saveSummary`, so a bookmark is summarized at most once. Server surface:
`GET /api/bookmarks/:id/summary` (cache-or-generate, mirrors the article endpoint's shape) and
`GET /api/summary-status` (`{ available: boolean }`, used by the client to disable/tooltip the
button up front). `ServerOptions.summaryGenerator` is the injection seam for offline tests.

Unlike ingestion/categorization, the web viewer historically needed no secrets - summaries change
that only when the owner wants them: `cmdServe` (`src/index.ts`) wires a real
`ClaudeSummaryGenerator` only when `CLAUDE_CODE_OAUTH_TOKEN` is present, leaving it `undefined`
otherwise. Without it, `/api/bookmarks/:id/summary` returns 503 with an actionable message instead
of crashing or hanging, and the client disables the button with that message as its tooltip
(`XBookmarksOrganizer` never requires the token to browse or to read already-cached summaries).

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

## Live vs. tested

The live OAuth browser consent and the vault-injected run are performed by the operator. Automated
validation uses fixtures/mocks for both the X API (`XClient` interface) and the LLM
(`BatchCategorizer` interface); keep those seams so tests stay offline.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
