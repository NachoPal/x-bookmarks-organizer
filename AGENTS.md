# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

## What this is

Personal tool: fetch the owner's X bookmarks, LLM-categorize them into a nested tree, store in local
SQLite, browse in a local web viewer. Acceptance spec: `docs/prds/0001-x-bookmarks-organizer.md`.
Setup steps: `docs/setup.md`.

**Web app first.** All user-facing functionality (sync, categorization, ranking, reset, settings, etc.)
must be triggerable from the app UI - never require the CLI. CLI commands may remain as an
implementation detail / power-user fallback, but every capability needs an in-app path.

## Stack & layout

- TypeScript on Node (CommonJS, compiled with `tsc` to `dist/`). Entry `src/index.ts` (commands:
  default `run`, `login`, `serve`).
- Ingestion+categorization CLI and the Fastify web viewer both live under `src/`; tests are
  colocated `*.test.ts` (Vitest). `npm test` runs offline with no credentials and no network.
- The viewer can run a sync itself (issue #71, below); CLI and viewer build categorization through
  ONE shared path, `src/categorize/build.ts`.
- Web viewer static assets live in `src/web/public/` and are copied to `dist/` by
  `scripts/copy-assets.js` during `npm run build` (tsc alone does not copy them).

## Hard constraints (do not regress)

- **Categorization must run on the Claude subscription, never the paid Anthropic API.** It routes
  through the provider abstraction (`src/llm/`, see below), whose ONE adapter - `claude-cli` -
  shells out to the `claude` CLI in print mode. Never introduce `@anthropic-ai/sdk` or require
  `ANTHROPIC_API_KEY`; the adapter strips it from the child env as its subscription-only invariant.
  The ONE approved paid path is the opt-in TypeSafe assignment categorizer (issue #61, below): it
  is off by default, refuses to run without `TYPESAFE_API_KEY`, and announces its per-token billing
  before every run. No code path may silently spend money - that invariant is unchanged, and any
  new paid path needs the same explicit opt-in + key + billing line.
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

## Assignment-pass categorizers (`XBOOKMARKS_CATEGORIZER`, issue #61)

Pass 2 (filing a bookmark into the existing tree) has TWO implementations behind the one
`BatchCategorizer` interface (`src/categorize/llm.ts`), selected by `XBOOKMARKS_CATEGORIZER`
(default `claude-cli`). This is deliberately NOT `XBOOKMARKS_LLM_PROVIDER`: TypeSafe/Jev takes no
prompt and returns no text, so it cannot implement `LlmClient`, and it must never become selectable
for the `summary`/`chat` roles. `src/ingest.ts` is untouched by the choice - it already injects the
seam, which is the whole reason this fit. **Pass 1 (taxonomy design) is always the LLM**; Jev
invents no labels, so it structurally cannot do that pass.

`typesafe` (`src/categorize/typesafe/`) is PAID per token and opt-in only: `buildCategorizers`
(`src/index.ts`) calls `requireTypeSafeCredentials` before constructing anything, and
`reportCategorizerBilling` prints the `Billing='per-token'` line every run. Three files, and the
split matters: `walk.ts` is a PURE beam search over sibling levels (`(levels, askFn) => scored
paths`) with zero SDK/DB/network dependency - the path is built in code from real DB node ids, so
off-tree paths are structurally impossible and `maxDepth` is a loop bound rather than a plea in a
prompt; `client.ts` wraps `@typesafe-ai/sdk`, mapping one `Choice` per level (siblings as labels,
node `description` as `criteria`) and batching the whole beam frontier into ONE `systemOne` call;
`categorizer.ts` reads the real tree from the DB and returns the same `Assignment[]` as the LLM.
Multi-label falls out of the beam: every path clearing `multiLabelThreshold` is kept (a path that is
only a PREFIX of a deeper keeper is dropped). Low confidence stops the descent at the last confident
ancestor instead of the flat `Uncategorized` dump; a bookmark that fits nothing anywhere is
`unresolved` and, in `extend` mode ONLY, routed alone to the LLM `Categorizer` to invent a node.
In `strict` mode it is correctly left unassigned so `makeResolver` files it `Uncategorized`.

Tests are entirely offline and must stay that way: `walk.test.ts` drives the algorithm with a fake
`askFn`, `client.test.ts` drives the REAL SDK through its injectable `Fetch`, and
`integration.test.ts` runs the REAL `runIngest` against a local `http` server standing in for the
API. Never let a test reach `api.typesafe.ai`, and never create an account or run a real call to
validate a change here.

**Category nodes carry a nullable `description`** (same issue). Pass 1's prompt now asks for a
one-line gloss per node - no extra LLM call, it already writes the tree - parsed by
`normalizeNodes` and stored via the `PRAGMA table_info`-guarded `CATEGORIES_ADDED_COLUMNS`
migration. `getOrCreateCategory` only ever FILLS IN a missing description, never overwrites or
clears one, so an ad-hoc `extend` node gains a description on the next `recategorize` while a real
one survives. It feeds Jev's `Choice.criteria` AND `renderTreeForPrompt`, so it improves the
existing `extend` prompt too; every consumer must tolerate `null` (any node predating the column).

## In-app sync + durable categorization settings (issue #71)

The viewer does the whole job now - no terminal. Three pieces, none of which duplicate the CLI:

- **`src/settings/`** - `catalog.ts` builds the choosable methods/providers/models/efforts FROM
  the provider registry (`listProviders()`), so registering a provider (#70) puts it in the
  dropdowns with no change here; its shape mirrors fixowl's `AGENT_MODEL_CATALOG`
  (models with a one-line hint + ascending `efforts`), which is why `ProviderDefinition` gained
  `efforts` and `ProviderModel` gained `description`. `settings.ts` validates a choice against
  that catalog (fixowl's `validateModelEffort` analog: one actionable sentence per problem,
  naming what IS available), persists it in `run_state` under `app_settings` - durable,
  server-side, readable by the process that does the spending, which `localStorage` is none of -
  and maps it onto `Config` with `applySettingsToConfig`. A model left undefined means
  "the provider's suggestion", which is what keeps the Opus-pass-1 / Haiku-pass-2 split alive for
  an owner who never opens a dropdown.
- **`src/web/sync.ts` + `sync-job.ts`** - `SyncRunner` holds ONE run at a time (a second start is
  409, never queued: two ingests would race on the same "already seen" set) and records the
  ingest's own logger lines verbatim as progress. `createSyncJob` is `cmdRun` reassembled from the
  same pieces, with `connect`/`buildCategorizers`/`ingest` as the offline test seams; it re-reads
  the settings on EVERY run, so a change in the panel needs no restart.
- **Server surface** - `GET /api/setup` (the one round trip the setup flow and the Settings panel
  need: `bookmarkCount`, `configured`, `settings`, `catalog`, credential PRESENCE + source but
  never a value, X connection, sync availability + status), `PUT /api/settings`, `POST /api/sync`
  (202, returns at once) / `GET /api/sync` (polled), and `POST /api/x-login` - the one-time OAuth
  consent, started in the background because it blocks on a human approving a page in another tab.
  Every one of these degrades (503 + an actionable reason) on a viewer built without the wiring,
  which is what keeps `buildServer(db)` usable in tests.

**Precedence is deliberately asymmetric** (`applySettingsToConfig`'s `env` argument): the viewer
passes no env, so the SAVED choice wins - a stray `XBOOKMARKS_CATEGORIZER=typesafe` in the shell
that launched `serve` must never bill per token while the panel reads "Claude model". The CLI
passes `process.env`, so an explicitly exported variable still wins there. `reportCategorizerBilling`
now writes into the sync's progress stream too, so the paid path still announces itself every run.

Frontend: `src/web/public/categorization.js` (`XBOCategorization`) is the pure, unit-tested half -
which fields a method uses, what "Recommended" resolves to, the blocker sentences, the progress
line - in the same DOM-free style as `tree-counts.js`. `app.js` owns only the markup: one
`createCategorizationForm` builder mounted twice (the setup dialog and the Settings panel), the
`.toolbar` row (the `role="tablist"` filter bar plus the Sync control, which never shrinks and goes
icon-only under 560px), the `.sync-progress` strip under it (running/done/error, carried by an icon
AND the text, with the full log behind a `<details>`), and the three-step setup dialog an empty
library opens into. The guided flow reopens on a blocked Sync ONLY when the blocker is the missing
authorization (`needsAuthorizationOnly`) - a missing credential is fixed outside the app, so
repeating its message inside the dialog would be noise.

## Frontend

Before editing anything under `src/web/public/`, follow the `building-frontends` skill and make its
checker pass:
`python3 ~/.claude/skills/building-frontends/scripts/check_frontend.py src/web/public/*` must be PASS.
All colors/spacing are CSS custom properties in `styles.css`; consume `var(--token)`, never raw
literals in component rules. The viewer is an app shell: a sticky top bar, a full-width filter tab
bar under it, a category column that the content shrinks to make room for (it overlays the content
only on narrow screens),
and an independently scrolling content pane; keep tree labels wrapping inside the sidebar (flex
children need `min-width: 0`) so counts never overflow.

The **top bar** (issues #53/#37/#42/#65) is one sticky row in three flex regions: the animated
categories-menu toggle (left), the selected category's title + counts on ONE line (center), and
`search | theme | sync | settings gear` (right). The category-colors toggle now lives beside the sidebar's "Categories" heading, and the last-synced time + Sync button live in the sync popover (the icon left of the gear; same panel style as settings), not the bar or tab row. The read-state filter LEFT this bar in #65 - it
is now the tab bar below (see next paragraph). There is no explanatory blurb and no second header
inside the content pane - `#content-title`/`#content-count` live in the bar. Equal `flex: 1 1 0`
flanks are what centers the middle region; the center is `flex: 0 1 auto` with
`min-width: 0`, and `.topbar-right` carries a `min-width: min-content` floor so the controls are
never squeezed. The title's ancestor crumb is a separate span capped at `max-width: 40%` (and
hidden under 560px) so a deep path ellipsizes the CRUMB, never the leaf - weighting `flex-shrink`
instead was tried and still clipped the leaf while the crumb had room left to give. Under 560px the bar drops the counts and the crumb.

The **filter tab bar** (issue #65) is a row of four tabs - Unread / Read / All / Favorites -
directly under the top bar, inside `.main-column` (a flex column holding the toolbar above the
scrolling `.content`), so it spans the viewport with the drawer closed and SHRINKS with the column
when the drawer pushes it. It sits in a `.toolbar` flex parent (the Sync control left it for the top-bar sync popover). The tablist
is a real one: roving tabindex, arrow keys + Home/End, `#bookmark-list` is its one `tabpanel` and
its `aria-labelledby` follows the active tab (`renderFilterTabs` in `app.js`). It is always
visible - hiding it on an empty category would jump the layout. The active tab is marked by an
underline AND a color, never color alone.

The **category sidebar RESIZES the two columns on wide screens** (issues #65, #78, #86): at
`min-width: 821px` `body` is a two-column grid - the sidebar track, then `.viewer` (top bar + tab
bar + posts, one unit) - and opening transitions the ONE declaration
`grid-template-columns: 0 minmax(0, 1fr)` -> `var(--sidebar-width) minmax(0, 1fr)`. The sidebar
grows while the content column gives up exactly that width, out of a single interpolation, so the
two can never drift apart. `app.js` only sets the `data-sidebar` body attribute; there is no
keyframe to start or clean up. See the "App body / sidebar" block in `styles.css` (authoritative).
Do NOT go back to sliding the whole `.viewer` with a transform FLIP (the #78 `playViewerSlide` /
`viewer-slide-*` approach, removed in #86): it translates the top bar and tab bar off-screen behind
`body`'s `overflow: hidden`, which reads as the entire app re-rendering as one block - the owner
rejected it on sight.
Resizing a column IS a layout animation, and the reason #78 avoided one is real: relayouting a
container that owns embedded tweets re-lays-out every iframe per frame. Two things, both
load-bearing, stop that here. `.sidebar-inner` is held at the FULL `--sidebar-width` and anchored to
the track's right edge, so the shrinking track only CLIPS it and no tree label or count ever
rewraps. And the posts live in `.content-inner`, a fixed `--content-measure` block with auto
margins, so a card's width is CONSTANT through the whole run - only the empty space around it
changes, and an iframe whose box never changes size is never re-laid-out (`.bookmark-card` also
carries `contain: layout`). Measured on the dev seed with 55 cards and a live X embed mounted:
zero frames over 20ms in either direction, and the embed's width identical on every frame. Keep
both properties if you touch this. (Animatable grid tracks: Firefox 66+, Chrome/Edge 107+,
Safari 16.1+; the track count never changes, which is what keeps the two lists interpolable.)
At `<=820px` it remains the FIXED overlay drawer with its scrim and auto-dismiss-on-pick, sliding on
transform; the viewer never moves and never resizes. A
closed drawer gets `inert` from JS (not just an off-screen transform) so it leaves the tab order.
The empty-state prompts (`[data-open-categories]`: the landing card and the top-bar "Select a
category" button) open it through the same `setCollapsed`.
`--header-offset` (the bar's real outer height, safe-area included) is what the narrow fixed drawer
and its scrim hang off - keep them on that token. `--z-header` sits ABOVE `--z-sidebar` so the
settings popover, which is a child of the bar, is not painted over by the drawer.

The **settings popover** (gear, issue #37) holds the post-size control plus the theme and
category-color switches. Post size resizes the POST, not the app's chrome - scaling the viewer's own
text was the first cut and is what browser zoom already does. It is one `--post-scale` multiplier
applied as **`zoom` on `.bookmark-card`**: `zoom` and not `transform: scale`, because it scales the
LAYOUT box as well as the rendering (transform leaves the original box behind, so scaled-down cards
strand a gap and scaled-up ones overlap), it re-renders rather than re-rasterizing so text stays
crisp, and Chrome carries it into the cross-origin X embed - the only way to resize a widget X owns,
since its iframe's font cannot be restyled from here. The step range is bounded at both ends and
`post-scale.test.ts` asserts it: small must keep the action row's shortest control a >=24px pointer
target, large must keep the 36rem card inside the 44rem content column. Percentages resolve in the
zoomed coordinate space, so `width: 100%` needs no compensation - a narrow card fills its column at
every step and only its content scales. Steps and their guarded persistence live in `post-scale.js`
(`XBOPostScale`, default **small** since the tab-bar change - the owner's call), the drawer's own
state in `sidebar-state.js` (`XBOSidebarState`), both pure/testable like `theme.js`. Escape closes
the popover and the drawer and returns focus to their triggers; the bar's menu toggle is the ONLY
close control for the drawer (the in-drawer close button was a duplicate and is gone).

A category's posts load lazily in batches (`XBOOKMARKS_PAGE_SIZE`, default 20) via infinite
scroll: `GET /api/categories/:id/bookmarks` takes `filter`/`offset`/`limit` (`filter` is the tab:
`all | unread | read | favorite`) and pages the filtered set server-side
(`db.getBookmarksForCategory` + `getCategoryBookmarkCounts`, which rolls up `total`/`unread`/
`favorite`), so a large category is never shipped or embedded all at once. The client (`app.js`)
drives it with an IntersectionObserver sentinel against the content pane; changing the tab re-pages
from the top. The dense-category seed leaf exists to exercise this.

Switching tabs or categories never reloads a post already loaded anywhere (issues #33, #67): `app.js`
keeps a per-POST pool (`cardPool`, id -> `{bm, card}`) of rendered cards, all MOUNTED in `listRoot`
(detaching/re-attaching an iframe reloads the X embed). A view is only an id list: `paintViewCards`
`hidden`s every card outside it and sequences the rest with inline flex `order` - never move or
`replaceChildren()` cards. `poolPost` reuses the pooled bm+card for a server row (folding in its fresher
read/favorite state), so only genuinely new posts render and spin. `viewCaches` (category -> filter ->
`{ids, bmById, offset, hasMore}`, LRU of `MAX_CACHED_CATEGORIES`) holds paging state only; the pool is
LRU-bounded by `XBOFilterCache.MAX_POOLED_POSTS` (`touchPool`), never evicting on-screen posts. A
Unread/Read/Favorites view of a category whose cached All list is complete is DERIVED locally
(`deriveViewEntry`/`deriveFilterIds`, same server sort) - no fetch. A view mid-fetch is never cached
(`viewReady`). A read/favorite toggle patches the shared card once (`patchCardControls`), a card that
drops out of the live tab is `hidden` (not removed), and `syncCachedViewsOnChange` deletes only the
stale id lists so the next visit re-derives or re-fetches while reusing the pooled cards; a delete
releases the card (`purgeFromCache`). `filter-cache.js` holds the pure, DOM-free half.

**Last view survives a reload** (issue #78, `view-persist.js`, pure + unit-tested): the selection
(category + tab) is in localStorage; a bounded snapshot of the fetched pages is in sessionStorage
(TTL, view-count and byte caps, keyed to the sort order) and is hydrated into `viewCaches` on load so
the reload re-fetches no bookmarks (X embeds re-init regardless). Every place that drops
`viewCaches` (sync, reset, sort change) also calls `clearPersistedViews`; a stored category that no
longer exists falls back to the empty state. A tab switch inside an open category keeps the current
posts on screen (`aria-busy`, dimmed) until the new page lands (`XBOFilterCache.loadingStrategy`) so
no blank frame is painted.

**Favorites** (issue #63) mirror read state end to end: a `favorite` column on `bookmarks` added
through the same `PRAGMA table_info`-guarded migration (`BOOKMARKS_ADDED_COLUMNS`),
`Database.setFavorite`, `POST /api/bookmarks/:id/favorite` next to the read POST, the flag on
every listed bookmark, and the `favorite` tab filter. It survives sync (`storeCategorizedBatch` is
`ON CONFLICT(post_id) DO NOTHING`) and `recategorize` (which only rewrites category links). The
sidebar tree counts stay read-state only, so a star never touches them.

A read-state toggle or delete must NEVER reload/re-render the whole sidebar tree (that flickers
and loses scroll + expand-collapse state) - it patches only the affected counters in place. Each
bookmark the viewer serves carries `categoryIds` (its direct category ids, from
`Database.getCategoryIdsForBookmarks`, added in the `/api/categories/:id/bookmarks` response); a
counter update walks each id's ancestor chain and applies a total/unread delta once per
deduplicated affected category (`src/web/public/tree-counts.js`, `applyCountDelta` +
`updateSidebarCounts`/`patchCategoryCountDom` in `app.js`), because a category's rolled-up counts
include all descendants (`assembleTree` in `src/categorize/tree.ts`) and a multi-category bookmark
must not double-adjust a shared ancestor. **Root categories are reorderable** (issue #82): a grip handle (pointer drag, or ArrowUp/ArrowDown on
the focused handle) on ROOTS only, hidden while a search filters the tree. The order is persisted
server-side in `run_state` key `root_order` as a list of root NAMES (not ids: `recategorize` clears
and re-creates every `categories` row, so ids do not survive it, names do), applied by
`orderRoots`/`assembleTree` in `src/categorize/tree.ts` to roots only - an unsaved root follows
alphabetically, children stay alphabetical. `PUT /api/categories/root-order` takes the complete
list of root ids (400 for an unknown/child/duplicate id, 409 for an incomplete/stale list). Pure
order math lives in `root-order.js` (`XBORootOrder`).

The category tree renders with every node - including
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

## Jev ranking pass (`XBOOKMARKS_RANKER`, issue #62)

An OPTIONAL, PAID, off-by-default pass that scores each stored bookmark for learning value with
TypeSafe/Jev `Score` questions over `BookmarkContent` (below) - the consumer that structure was
built for. Additive end to end: nothing in ingestion, categorization, summaries or browsing reads
it, and with it off the library and the viewer are byte-identical to before.

`src/rank/` is split the way `src/categorize/typesafe/` is, and for the same reason: `rubric.ts` is
PURE (the questions, their levels, the weights, and the weighted combination - no SDK, no DB, no
clock) and `state.ts` is pure too (`BookmarkContent` -> Jev JSON state, with per-part caps);
`client.ts` is the only file that touches the SDK, and it REUSES the categorizer's
`describeTypeSafeError`/`DEFAULT_TYPESAFE_MODEL` rather than restating how a TypeSafe failure is
redacted. `ranker.ts` orchestrates (concurrency, resume, the summary), `build.ts` is the single
gate. Whole rubric = ONE `systemOne` call per bookmark: TypeSafe answers questions in parallel
against one shared state, which is what makes a decomposed rubric affordable.

Paid safety, and the ORDER matters: `requireRankerCredentials` checks the OPT-IN before the key, so
a `TYPESAFE_API_KEY` left over from a categorization experiment can never turn `rank` into a paid
run on its own; an unrecognized `XBOOKMARKS_RANKER` value is `off`, never an opt-in. `rank
--dry-run` reports the size of a run while making no call.

Storage is `bookmark_scores` (`src/db/schema.ts`), keyed by bookmark: normalized 0..1 `score`, the
model's own `confidence`, the per-dimension breakdown as JSON (read tolerantly - a blob this build
cannot parse degrades to no dimensions, never to an exception), and `rubric_version`. That version
is load-bearing: `getBookmarksToScore` re-selects a row scored under a DIFFERENT rubric, which is
what stops two scales being sorted against each other, and it is why `buildRubric` hashes
`XBOOKMARKS_RANKER_INTERESTS` into the tag. **An absent row means "never ranked", never "scored
zero"** - every consumer must honor that, which is why `sort=score` puts unranked bookmarks LAST and
the viewer renders no chip at all rather than a zero.

Surface: `score` on every listed bookmark (a pure cache read in `toViewerBookmarks`, empty when
ranking was never run), `?sort=score` on `/api/categories/:id/bookmarks` (server-side, because
paging is), a `ranking` block on `/api/setup` (`scored`/`total`, plus what the in-app trigger needs
- see issue #80 below), and in the viewer an **Order** segmented control in the settings popover
plus a read-only `.score-chip` on each ranked card.
`src/web/public/sort-order.js` (`XBOSortOrder`) is the pure, unit-tested half (guarded persistence,
the query param, the rating/tooltip formatting) in the same style as `post-scale.js`. Changing the
order DROPS every cached view (`viewCaches`) wholesale - they were paged under the old order - the
same way a completed sync does.

Tests are entirely offline and must stay that way: `client.test.ts` drives the REAL SDK through its
injectable `Fetch`, `integration.test.ts` runs the REAL ranker against a local `http` server
standing in for the API and then asserts the viewer API's ordering. Never let a test reach
`api.typesafe.ai`, and never make a real Jev call to validate a change here.

## In-app ranking run (issue #80)

A ranking run is startable from the app, not only the CLI - the web-app-first rule applies to the
paid pass too. What is NOT relaxed is the cost invariant. The old rule here read "never add an
in-app button that starts a ranking run"; the reason behind it was that a paid run must never be
one careless click away, NOT that in-app ranking is forbidden. **The contract is now: an in-app
trigger is allowed, and it carries every gate the CLI has plus one the CLI does not need.** Four
gates, and all four are load-bearing:

1. **Opt-in, then key** - `requireRankerCredentials`, in that order, exactly as `rank` does. The
   server-side wiring (`src/web/rank-job.ts`'s `createRankWiring`) is the only place that decides,
   and the SAME check is surfaced up front as `blocker` so the control explains itself instead of
   failing on press. Never re-derive this rule in the route or the client.
2. **An explicit paid confirmation.** `POST /api/rank` refuses without `{ confirm: true }` (400),
   and the viewer sends it from ONE place: a confirm dialog that names the price before the scope
   and whose primary button restates the count. This is the in-app equivalent of deliberately
   typing `rank`, and it is why the button may exist at all. The blocker is RE-checked at the
   moment of the authorization, so a stale browser cannot spend money.
3. **Billing surfaced, every run.** `reportRankerBilling` writes into the run's progress stream, so
   the price tag is the first line the owner sees while it runs - never a silent spend.
4. **One run at a time**, and never racing a sync (either order) or a reset: two runs would pay
   twice, and an ingest is writing the very bookmarks a run selects.

The run is **incremental by default and must stay that way**: it takes the ranker's normal
selection (`getBookmarksToScore`, which skips anything already scored under the current rubric) and
must NEVER pass `rescoreAll`. Pressing it again after a later sync therefore pays only for the
newly-synced bookmarks, exactly as sync itself only fetches what is new; a run over zero unranked
bookmarks no-ops with a "nothing to rank" line rather than erroring. `pending` (a free
`planRanking` read - no API call) is what the panel and the dialog use to say how many a run would
score.

Mechanically it is the SYNC pattern, not a second one: `JobRunner` (`src/web/job-runner.ts`) is the
one-at-a-time-job-with-pollable-progress engine that `SyncRunner` and `RankRunner`
(`src/web/rank.ts`) both bind, `POST /api/rank` returns 202 and `GET /api/rank` is polled, and the
client paints the same `.sync-progress` strip through the shared `renderProgressStrip`. A completed
run drops the cached views the way a sort change does, so new chips and the score order appear with
no reload. A viewer built without the wiring degrades with 503, keeping `buildServer(db)` usable in
tests. Frontend rules live in `src/web/public/ranking.js` (`XBORanking`, pure + unit-tested), which
fails CLOSED: no state means no button.

The ranker's knobs stay OUT of the settings panel on purpose - turning ranking on remains an
explicit server-side act, which is gate 1. Tests are offline end to end (`rank-job.test.ts`,
`rank-api.test.ts`, `ranking.test.ts`); never let one reach `api.typesafe.ai`, and never make a real
Jev call to validate a change here.

## Categorizer comparison (`eval-categorizers`, issue #83)

An OPTIONAL, PAID, off-by-default CLI command that answers "which assignment pass files MY
bookmarks better" with a Markdown report in gitignored `data/eval/`. `src/eval/` is split the way
`src/rank/` is: `compare.ts` (the metrics) and `report.ts` (the document) are PURE - no DB, SDK,
clock or I/O - `jev.ts` holds the Jev side, `run.ts` orchestrates, `build.ts` is the single paid
gate. There is deliberately NO in-app trigger: like `rank`, a per-token run gets no button. This is
the sanctioned CLI-only exception to web-app-first.

The design is one idea: **hold the taxonomy fixed**. `runCategorizerEval` designs ONE fresh tree
(pass 1, always Claude), then files every bookmark into THAT tree with both methods from ONE shared
`buildArticleContext`. Pass 1 cannot be Jev, so with the tree and the context identical the filing
pass is the only variable - which is what makes a difference attributable to the method rather than
to taxonomy randomness. Change either and the comparison stops meaning anything.

**The live DB must stay byte-identical, and that is enforced structurally, not by care.** The fresh
tree is materialized (via the real `materializeTaxonomy`, so it has a real run's depth cap and
case-insensitive sibling merge) into a THROWAWAY database in a temp dir, removed in a `finally`;
filings are compared in memory, so `storeCategorizedBatch` is never called; and the article context
goes through `ReadThroughMetadataCache`, which reads the live caches and buffers writes in memory -
an eval must not even populate `article_link_metadata`, which a normal `run` would. The integration
test asserts a full before/after snapshot, and both halves of that guarantee are mutation-checked.

Two reuse decisions worth keeping: the Jev side composes `buildBookmarkState` + `toWalkTree` +
`walkTree` directly rather than wrapping `TypeSafeCategorizer`, because `Assignment[]` throws away
the per-bookmark confidence and the "stopped at a confident ancestor" flag the report is built on
(in `strict` mode the composition is behaviourally identical - the categorizer's only other
behaviour is the `extend`-mode fallback, already a no-op there). And token spend is metered by
`meteringFetch` riding on the SDK's own injectable transport, so the live client grows no counter
and the cost reporting is exercised offline.

Paid safety mirrors the ranker gate for gate, and the ORDER matters: `requireEvalCategorizersCredentials`
(`src/config.ts`) checks `XBOOKMARKS_EVAL_CATEGORIZERS` BEFORE `TYPESAFE_API_KEY`, so a key left
over from a categorization or ranking experiment can never start a paid run on its own; an
unrecognized value is `off`, never an opt-in; and selecting `XBOOKMARKS_CATEGORIZER=typesafe` for
real syncs does NOT turn this on - they are different decisions. `--dry-run` deliberately needs
neither gate (sizing the bill is how an owner decides whether to opt in) and makes no call at all,
not even the free-but-quota-burning taxonomy pass. Walk tuning is read from `config.typesafe`, the
same knobs a real sync would run under, so the comparison judges the method the owner could turn on.

Tests are entirely offline and must stay that way: `integration.test.ts` runs the REAL eval and the
REAL SDK against a local `http` server standing in for the API, with a fake `LlmRunner` for the
Claude half. Never let a test reach `api.typesafe.ai`, and never make a real Jev call to validate a
change here.

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
piece of text represents - which the Jev ranking pass above now is. `linkedArticle.body` is included
only when the reader-view extraction (the #4 `articles` cache) is already cached - it stays lazy, never fetched by this read. Exposed as
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
