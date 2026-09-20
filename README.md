# X Bookmarks Organizer

Fetch your X (Twitter) bookmarks, auto-categorize them into a nested topic tree with an LLM,
store them in a local SQLite database you fully own, and browse them through a simple local
web interface with read-tracking.

Runs occasionally and incrementally: each run only processes bookmarks added since the last run -
from the **Sync** button in the viewer, or from the CLI.

- Requirements / acceptance spec: [`docs/prds/0001-x-bookmarks-organizer.md`](docs/prds/0001-x-bookmarks-organizer.md)
- One-time setup (X app, OAuth, vault, credit): [`docs/setup.md`](docs/setup.md)

## How it works

- **Ingestion** - the official X API v2 bookmarks endpoint (OAuth 2.0 Authorization Code + PKCE,
  user context). Incremental: it pages the bookmark timeline newest-first and stops as soon as it
  reaches a bookmark it has already stored, so previously seen bookmarks are never re-fetched or
  re-categorized.
- **Categorization** - goes through a pluggable **LLM provider** (`src/llm/`). The default and only
  provider today is `claude-cli`: your **Claude Code subscription**, driven through the local
  `claude` CLI in headless mode - **not** the pay-per-use Anthropic API, so it adds no per-call
  dollar cost. Select one with `XBOOKMARKS_LLM_PROVIDER` (default `claude-cli`). It works in
  **two passes**:
  1. **Taxonomy design (holistic).** All bookmarks are shown to the model at once, as a compact
     list, and it designs one coherent, genuinely nested category tree with complete freedom over
     the labels and structure, targeting a minimum nesting depth (`XBOOKMARKS_MIN_DEPTH`, default
     3). This is the hard, large-context step, so it runs on an Opus-class model at high effort
     (`XBOOKMARKS_TAXONOMY_MODEL` / `XBOOKMARKS_TAXONOMY_EFFORT`). It runs **only on the first run**
     (when no tree exists yet) and whenever you run `recategorize`. Incremental runs against an
     existing tree **skip** this pass to conserve quota (see below).
  2. **Assignment.** Each bookmark is filed into the tree by a Haiku-class model (`XBOOKMARKS_MODEL`)
     to conserve subscription quota. A bookmark may be filed under several branches at once;
     anything that fits nothing lands in `Uncategorized`. On an **incremental run** against an
     existing tree, only this cheap pass runs over the new bookmarks: it reuses existing nodes and
     creates a new one only when a bookmark fits nothing. Already-stored bookmarks are never
     re-touched; use `recategorize` to rebuild the whole tree holistically.

  This replaces an older cold-start scheme that categorized bookmarks in isolated batches and tended
  to collapse into a couple of broad, shallow buckets.
- **Storage** - a single local SQLite file (`data/bookmarks.db` by default), fully owned and
  portable. Gitignored.
- **Viewer** - a small local web app: the category tree with counts, drill into a node to list its
  bookmarks, each shown as an embedded X post (link fallback where the post is not embeddable).
  Opening a bookmark marks it read and records the date, reflected live in the UI. Filter the tree
  by category name from the sidebar search box, and switch a node's bookmarks with the tab bar
  under the top bar: Unread / Read / All / Favorites. Star any post from its action row to keep it
  in Favorites; the star is stored in SQLite like read state, so it survives a later sync or
  `recategorize`. Opening the categories drawer pushes the posts aside rather than covering them.
  A category's posts load lazily in batches of 20 as you scroll (infinite scroll), so a large
  category never renders every post - or every X embed - at once; paging follows the active tab
  and resets to the top when you change it (`XBOOKMARKS_PAGE_SIZE`, default 20).
- **Summaries** - click "Summarize" on a bookmark for an on-demand LLM summary of its content (the
  post, plus its extracted article when the reader view can read it) in a large modal. Generated on
  the same LLM provider as categorization, and cached in SQLite so re-opening is instant and free.
  Needs that provider to be available at `serve` time - for `claude-cli`, the `claude` CLI installed
  and logged in. When it is not, the button is disabled with a tooltip explaining exactly what to
  fix; when a call fails, the modal shows the error and you can retry. Everything else in the viewer
  works either way, including already-cached summaries.

## Prerequisites

- Node.js >= 20
- The `claude` CLI on your `PATH`, logged in (the default `claude-cli` LLM provider)
- A way to provide the two X secrets below - the easiest is a `.env` file (see Secrets); a vault
  such as [Automic Vault](docs/setup.md) (`av`), a shell export, or a systemd unit all work too
- A pay-per-use X API app - see [`docs/setup.md`](docs/setup.md)

## Install & build

```bash
npm install
npm run build
```

## Secrets

Secrets resolve through a **layered credential chain**, first hit wins, so there is no single
required mechanism:

1. **The process environment** - unchanged: a vault such as `av inject`, a shell `export`,
   a Docker `-e` flag, a systemd unit, or CI secrets all keep working exactly as before.
2. **A `.env` file in the project root** - the easy default for running this yourself. Copy
   [`.env.example`](.env.example) to `.env` and fill in what you need; it is gitignored and never
   committed.
3. **Your OS keychain** - macOS Keychain, the Linux Secret Service (`secret-tool`), or Windows
   Credential Manager (`cmdkey`), via the platform CLI.
4. **`~/.config/x-bookmarks-organizer/credentials.json`** - an owner-only (`chmod 600`) file, for
   when none of the above fit.

Nothing is ever read from a *committed* file, and nothing is ever written to disk unless a store
tier is actually used (tiers 3-4).

| Env var                   | What                                             |
| ------------------------- | ------------------------------------------------ |
| `XBOOKMARKS_CLIENT_ID`     | X OAuth 2.0 app Client ID (ingestion only)      |
| `XBOOKMARKS_CLIENT_SECRET` | X OAuth 2.0 app Client Secret (ingestion only)  |
| `CLAUDE_CODE_OAUTH_TOKEN`  | Claude subscription token - **optional**: a `claude` CLI you have logged into interactively needs none |

Quickest start - drop a `.env` in the project root:

```bash
cp .env.example .env
# edit .env with your values, then:
node dist/index.js
```

If you already use a vault such as [Automic Vault](docs/setup.md) (`av inject`), it keeps working
unchanged - it is simply one supported provider among several, not the only door:

```bash
av inject +XBOOKMARKS_CLIENT_ID +XBOOKMARKS_CLIENT_SECRET -- node dist/index.js
```

## Usage

You can drive the whole thing from the app, or from the CLI - they share the same code and the
same local database, so either is fine.

### From the app (no terminal after the first start)

```bash
node dist/index.js serve
# then open http://127.0.0.1:5173
```

An empty library opens a three-step setup: authorize X, choose how categorization runs, run the
first sync. After that, the **Sync** button in the toolbar fetches new bookmarks and categorizes
them server-side, showing the same progress the CLI prints and refreshing the viewer when it
finishes. The categorization choice - the method (the Claude model, or Jev), the model provider,
the per-pass models and the reasoning effort - is saved in the local database and reused by every
later sync; change it any time in the Settings panel (the gear).

The server still needs your X app credentials to sync: it resolves `XBOOKMARKS_CLIENT_ID` and
`XBOOKMARKS_CLIENT_SECRET` through the same layered chain as everything else (environment, `.env`,
OS keychain, `~/.config/x-bookmarks-organizer/credentials.json` - see [Secrets](#secrets)), so
provide them however you prefer *before* starting `serve`. If it cannot reach them, the app says
exactly which one is missing and where it looked, rather than failing mid-sync. Choosing Jev
additionally needs `TYPESAFE_API_KEY` on that same chain, and it is **paid per token** - the app
says so before you pick it, and the sync's progress repeats it on every run.

### From the CLI

**1. One-time login** (opens a browser once; stores a rotating refresh token locally so all later
runs are headless). With a `.env` file in place (see Secrets), just:

```bash
node dist/index.js login
```

Or with a vault such as Automic Vault:

```bash
av inject +XBOOKMARKS_CLIENT_ID +XBOOKMARKS_CLIENT_SECRET -- node dist/index.js login
```

**2. Ingest + categorize** (the default command; run this whenever - roughly weekly):

```bash
node dist/index.js
```

It prints a summary: how many new bookmarks, how many batches, how many new categories.

**Re-categorize** (optional) - rebuild the taxonomy and reassign **all** already-stored bookmarks
from scratch, without re-fetching from X. Use this to redo a shallow earlier run, or after changing
the taxonomy model / depth settings. Read state and read dates are preserved:

```bash
node dist/index.js recategorize
```

(X credentials are not needed for `recategorize` - it only re-reads the local database.)

**Backfill previews** (optional) - a normal `run` already fetches and caches article link metadata
for new bookmarks, but bookmarks synced before the previews feature (#26) existed have none, so
their link contributes nothing extra to Summarize or categorization. Run this once against an
existing library to fetch and cache metadata for those without touching categories, the taxonomy,
or re-fetching from X:

```bash
node dist/index.js backfill-previews
# or: node dist/index.js backfill-previews --retry-failed   (also retries links cached as failed)
```

It is idempotent - safe to re-run; already-cached links (`ok`, and `failed` unless `--retry-failed`
is passed) are skipped. Prints a summary of links found / fetched / cached / failed.

**Backfill X Articles** (optional, one-time, a small PAID X read) - a normal `run` now asks X for
the data of X's native long-form Articles (`x.com/i/article/...`: title, preview, cover, full body),
which the viewer shows as an "X Article" card and feeds to Summarize and categorization. Bookmarks
stored before that have none. Run this once to read it for just those bookmarks - the ones whose
link resolved to an X Article or to another X post they quote (run `backfill-previews` first so
links are resolved):

```bash
node dist/index.js backfill-x-articles --dry-run   # lists what it would read + estimated cost, no X call
node dist/index.js backfill-x-articles
```

Needs your X credentials (it goes through the normal login/refresh-token path). Idempotent - stored
Articles and already-checked quotes are skipped. The first real run logs the raw `article` field
shape X returns, so a field-naming mismatch is visible. Afterwards, `recategorize` re-files any of
these bookmarks that were sitting in `Uncategorized`.

**3. Browse** (browsing and cached summaries need no secrets at all):

```bash
node dist/index.js serve
# then open http://127.0.0.1:5173
```

Generating NEW summaries additionally needs the configured LLM provider to be available. With the
default `claude-cli` provider that just means the `claude` CLI is installed and logged in; `serve`
prints which provider and model it resolved, or why summaries are disabled. Syncing from the
viewer needs the X credentials as described above; `serve` also prints how the next sync will be
billed, before you press the button.

**Re-fetch unreadable articles** (optional) - Summarize caches each bookmark's article fetch, and a
link cached as unreadable stays that way even after the fetcher improves. This re-fetches every
article cached without a body and, for each one that now has a body, drops just that bookmark's
cached summary so the next Summarize regenerates it with the article. Every other summary is kept.
No secrets needed; idempotent - re-running only retries what is still unreadable:

```bash
node dist/index.js refetch-articles
```

**Clear cached summaries** (optional) - wipe every saved summary so they regenerate cleanly under
the current logic (e.g. after a bug cached bad/garbage summaries). No secrets, no network - just the
local DB. Idempotent - re-running removes 0:

```bash
node dist/index.js clear-summaries
```

Score stored bookmarks by learning value (opt-in and **paid** - see "Ranking bookmarks by learning
value" below):

```
XBOOKMARKS_RANKER=typesafe node dist/index.js rank --dry-run
```

## Structured bookmark content (for a ranking/scoring tool)

The viewer exposes each bookmark's full content in a structured, labeled shape - meant for a
downstream tool (e.g. a content-scoring/re-ranker) that needs to tell "the bookmarked post's own
text" apart from "the post it quotes", "the external article it links" and "the X-native Article it
hosts or quotes", rather than one flattened blob of text. It is a pure DB read: neither endpoint
makes a network call.

```
GET /api/bookmarks/:id/content        -> { content: BookmarkContent }
GET /api/content?offset=0&limit=20    -> { content: BookmarkContent[], offset, limit, total, hasMore }
```

`BookmarkContent` (`src/content/bookmark-content.ts`):

```ts
interface BookmarkContent {
  bookmarkId: number;
  postId: string;
  post: { kind: 'post'; authorUsername: string; authorName: string; text: string };
  quotedPost: { kind: 'quoted-post'; authorUsername: string; authorName: string; text: string } | null;
  linkedArticle: { kind: 'external-article'; url: string; title: string | null; description: string | null; body: string | null } | null;
  xArticle: { kind: 'x-article'; title: string | null; previewText: string | null; body: string | null; quoted: boolean } | null;
}
```

- `post` is always present - the bookmarked post's own author and text.
- `quotedPost` is the content of an ORDINARY post this bookmark quotes (author + text), captured at
  ingest time from the same X API response that fetches the bookmark itself (no extra request).
  Null when there is no quote, or when the quoted post hosts an X Article instead (see `xArticle`).
- `linkedArticle` is the external article a link in the post's text resolves to. `title`/
  `description` come from the ingest-time link-preview cache whenever it has been fetched; `body`
  is included only when the full reader-view extraction is already cached (it is fetched lazily by
  Summarize/`refetch-articles`, never by this endpoint) - null otherwise. Null when the post has no
  usable link.
- `xArticle` is an X-native long-form Article (`x.com/i/article/<id>`) this bookmark hosts or
  quotes (`quoted` distinguishes which), with its title/preview/full body. Null otherwise.

## Configuration (optional env vars)

| Env var                 | Default                | Meaning                                  |
| ----------------------- | ---------------------- | ---------------------------------------- |
| `XBOOKMARKS_DB_PATH`     | `data/bookmarks.db`    | SQLite file location                     |
| `XBOOKMARKS_WEB_PORT`    | `5173`                 | Web viewer port                          |
| `XBOOKMARKS_AUTH_PORT`   | `3000`                 | One-time OAuth callback port             |
| `XBOOKMARKS_REDIRECT_URI`| `http://127.0.0.1:3000/callback` | OAuth redirect (must match the X app) |
| `XBOOKMARKS_LLM_PROVIDER`| `claude-cli`           | LLM provider id (`claude-cli` is the only one so far) |
| `XBOOKMARKS_LLM_MODEL`   | -                      | Model for every role, unless a role overrides it |
| `XBOOKMARKS_MODEL`       | `claude-haiku-4-5`     | Assignment-pass model (Haiku-class); also the summary model if `XBOOKMARKS_SUMMARY_MODEL` is unset AND this is explicitly set |
| `XBOOKMARKS_TAXONOMY_MODEL` | `claude-opus-4-8`   | Taxonomy-design-pass model (Opus-class)  |
| `XBOOKMARKS_TAXONOMY_EFFORT` | `high`             | Taxonomy-pass effort (low/medium/high/xhigh/max) |
| `XBOOKMARKS_BATCH_SIZE`  | `15`                   | Bookmarks per assignment request         |
| `XBOOKMARKS_MIN_DEPTH`   | `3`                    | Target minimum nesting depth (best-effort) |
| `XBOOKMARKS_MAX_DEPTH`   | `4`                    | Maximum category tree depth              |
| `XBOOKMARKS_SUMMARY_MODEL` | `claude-sonnet-5`    | Summary model (Sonnet-class, for quality) |
| `XBOOKMARKS_CLAUDE_BIN`  | `claude`               | Path to the `claude` binary when it is not on `PATH` |
| `XBOOKMARKS_PAGE_SIZE`   | `20`                   | Viewer lazy-load batch size per scroll   |
| `XBOOKMARKS_CATEGORIZER` | `claude-cli`           | Which implementation runs the **assignment** pass: `claude-cli` or `typesafe` (**paid**, see below) |
| `XBOOKMARKS_TYPESAFE_MODEL` | `jev-latest`        | TypeSafe model, when that categorizer is selected |
| `XBOOKMARKS_TYPESAFE_BEAM_WIDTH` | `3`           | Paths kept alive per tree level (1 = greedy) |
| `XBOOKMARKS_TYPESAFE_CONFIDENCE` | `0.55`        | Floor to descend a level; below it the walk stops at the confident parent |
| `XBOOKMARKS_TYPESAFE_MULTILABEL` | `0.6`         | Score floor for keeping an ADDITIONAL category |
| `XBOOKMARKS_TYPESAFE_MAX_LABELS` | `3`           | Cap on categories per bookmark            |
| `XBOOKMARKS_TYPESAFE_CONCURRENCY` | `8`          | Bookmarks classified in parallel          |
| `XBOOKMARKS_RANKER`      | `off`                  | Turn the **ranking** pass on (`typesafe`, **paid**, see below) |
| `XBOOKMARKS_RANKER_MODEL` | `jev-latest`          | TypeSafe model for the ranking pass       |
| `XBOOKMARKS_RANKER_INTERESTS` | -                 | What you care about, in your own words; adds a relevance question to the rubric |
| `XBOOKMARKS_RANKER_CONCURRENCY` | `6`             | Bookmarks scored in parallel              |

Model names and effort levels are interpreted by the selected provider, so a provider that has no
notion of an effort level simply ignores `XBOOKMARKS_TAXONOMY_EFFORT` rather than failing.

The categorizer, provider, per-pass models and taxonomy effort can also be chosen **in the app**
(Settings → Categorization), which stores them in the local database. Precedence differs by caller,
deliberately: in the viewer the saved choice always wins, so the panel can never read "Claude model"
while a stray variable in the shell that launched `serve` quietly bills per token; on the CLI an
explicitly exported `XBOOKMARKS_*` variable still overrides the saved choice, so a one-off
`XBOOKMARKS_MODEL=... node dist/index.js run` means what it always did.

## Choosing the assignment categorizer (optional, opt-in, **paid**)

The **assignment** pass - filing each bookmark into the existing tree - can run on either of two
implementations. The app's Settings panel is the easiest way to choose (and is what an in-app sync
uses); on the CLI it is `XBOOKMARKS_CATEGORIZER`:

| Value | What runs | Cost |
| --- | --- | --- |
| `claude-cli` (**default**) | Today's prompt-and-parse categorizer on your Claude subscription | **No per-call charge** |
| `typesafe` | A hierarchical beam-search walk on the TypeSafe/Jev API | **Pay per token** (~$0.11 per 1,000 bookmarks) |

**Leave it unset and nothing changes** - categorization stays on the flat-rate subscription and no
code path can spend money. The **taxonomy-design pass always stays on the LLM** either way: Jev is a
classifier and invents no labels.

`typesafe` requires BOTH the explicit opt-in and a `TYPESAFE_API_KEY` resolved through the usual
credential chain; without a key it refuses to run rather than falling back silently (in the app, the
selector says so before you can start a sync). Every run
prints how the pass is billed before making a call. Note that with it enabled your bookmark text is
sent to a third-party hosted API, where today it stays on your machine.

What it buys, when enabled:

- **Off-tree categories become structurally impossible.** The path is built in code from real
  database nodes, so there is nothing to parse and no invented category to repair.
- **Confidence-gated placement.** When the deepest choice is a coin flip, the bookmark is filed at
  the last *confident* ancestor ("AI > Harnesses") instead of a guessed leaf or the flat
  `Uncategorized` bucket.
- **Hybrid extend.** On incremental runs, only bookmarks that fit nothing anywhere are handed to the
  LLM to propose a new category, so it invents exactly where invention is needed.
- **Speed.** Each bookmark is classified independently and in parallel, which is what makes
  `recategorize` cheap enough to iterate on.

## Ranking bookmarks by learning value (optional, opt-in, **paid**)

You save bookmarks to extract insights from them, so an optional pass scores each one for exactly
that and lets the viewer order by it. It runs on the TypeSafe/Jev API's `Score` questions over the
same structured `BookmarkContent` above - which is what that shape was built for.

```
XBOOKMARKS_RANKER=typesafe node dist/index.js rank --dry-run   # how many would be scored; no API call
XBOOKMARKS_RANKER=typesafe node dist/index.js rank             # score them
XBOOKMARKS_RANKER=typesafe node dist/index.js rank --limit 50  # a cost ceiling for a first look
XBOOKMARKS_RANKER=typesafe node dist/index.js rank --all       # re-score everything, not just what is missing
node dist/index.js clear-scores                                # drop every stored score (no key needed)
```

**It is off by default and never runs on its own.** It needs BOTH `XBOOKMARKS_RANKER=typesafe` and a
`TYPESAFE_API_KEY` resolved through the usual credential chain, and the opt-in is checked first - a
key left over from a categorization experiment cannot turn `rank` into a paid run by itself. Every
run prints how it is billed before making a call, and `--dry-run` makes none at all. Nothing else in
the tool reads any of this: syncing, categorizing, summaries and browsing are untouched whether it
is on or off. As with the paid categorizer, your bookmark text is sent to a third-party hosted API.

The rubric asks four well-scoped questions per bookmark - **learning value**, **insight density**,
**durability** and **actionability** - plus a **relevance** question when you set
`XBOOKMARKS_RANKER_INTERESTS` to what you care about. They ride in ONE request per bookmark
(TypeSafe evaluates questions in parallel against one shared state), and the weighted result plus
the model's own confidence is stored per bookmark. The levels each question offers are the real
tuning surface and live in `src/rank/rubric.ts`.

Running it again only scores what is missing, so it is resumable and never pays twice; changing the
rubric (or your interests) changes its version tag, which is what makes those bookmarks stale and
re-scored rather than silently sorted against two different scales.

Once anything is scored:

- the bookmark list exposes it - `score: { value, confidence, dimensions } | null`, null for a
  bookmark that was never ranked, which is not the same as a score of zero;
- `GET /api/categories/:id/bookmarks?sort=score` pages the category by it, highest first, with
  unranked bookmarks last;
- the viewer's Settings panel gains an **Order** control (Newest / Top score), and each ranked card
  shows its rating, with the per-question breakdown behind it.

## Development

```bash
npm test          # unit tests (no network, no credentials)
npm run typecheck # tsc --noEmit
npm run lint      # eslint
npm run build     # compile to dist/ and copy the web assets
```

Tests use fixtures/mocks for both the X API and the LLM, so they run offline with no credentials.
