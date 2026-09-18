# X Bookmarks Organizer

Fetch your X (Twitter) bookmarks, auto-categorize them into a nested topic tree with an LLM,
store them in a local SQLite database you fully own, and browse them through a simple local
web interface with read-tracking.

Runs occasionally and incrementally: each run only processes bookmarks added since the last run.

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
  by category name from the sidebar search box, and filter a node's bookmarks by read state
  (Unread / Read / All). A category's posts load lazily in batches of 20 as you scroll (infinite
  scroll), so a large category never renders every post - or every X embed - at once; paging
  follows the active read-state filter and resets to the top when you change it
  (`XBOOKMARKS_PAGE_SIZE`, default 20).
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
their posts show a bare link instead of a preview card / "Read article". Run this once against an
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

**3. Browse** (the web viewer needs no X secrets - browsing and cached summaries work without any):

```bash
node dist/index.js serve
# then open http://127.0.0.1:5173
```

Generating NEW summaries additionally needs the configured LLM provider to be available. With the
default `claude-cli` provider that just means the `claude` CLI is installed and logged in; `serve`
prints which provider and model it resolved, or why summaries are disabled.

## Configuration (optional env vars)

| Env var                 | Default                | Meaning                                  |
| ----------------------- | ---------------------- | ---------------------------------------- |
| `XBOOKMARKS_DB_PATH`     | `data/bookmarks.db`    | SQLite file location                     |
| `XBOOKMARKS_WEB_PORT`    | `5173`                 | Web viewer port                          |
| `XBOOKMARKS_AUTH_PORT`   | `3000`                 | One-time OAuth callback port             |
| `XBOOKMARKS_REDIRECT_URI`| `http://127.0.0.1:3000/callback` | OAuth redirect (must match the X app) |
| `XBOOKMARKS_LLM_PROVIDER`| `claude-cli`           | LLM provider id (`claude-cli` is the only one so far) |
| `XBOOKMARKS_LLM_MODEL`   | -                      | Model for every role, unless a role overrides it |
| `XBOOKMARKS_MODEL`       | `claude-haiku-4-5`     | Assignment-pass (and summary) model (Haiku-class) |
| `XBOOKMARKS_TAXONOMY_MODEL` | `claude-opus-4-8`   | Taxonomy-design-pass model (Opus-class)  |
| `XBOOKMARKS_TAXONOMY_EFFORT` | `high`             | Taxonomy-pass effort (low/medium/high/xhigh/max) |
| `XBOOKMARKS_BATCH_SIZE`  | `15`                   | Bookmarks per assignment request         |
| `XBOOKMARKS_MIN_DEPTH`   | `3`                    | Target minimum nesting depth (best-effort) |
| `XBOOKMARKS_MAX_DEPTH`   | `4`                    | Maximum category tree depth              |
| `XBOOKMARKS_SUMMARY_MODEL` | `XBOOKMARKS_MODEL`   | Summary model, when it should differ     |
| `XBOOKMARKS_CLAUDE_BIN`  | `claude`               | Path to the `claude` binary when it is not on `PATH` |
| `XBOOKMARKS_PAGE_SIZE`   | `20`                   | Viewer lazy-load batch size per scroll   |

Model names and effort levels are interpreted by the selected provider, so a provider that has no
notion of an effort level simply ignores `XBOOKMARKS_TAXONOMY_EFFORT` rather than failing.

## Development

```bash
npm test          # unit tests (no network, no credentials)
npm run typecheck # tsc --noEmit
npm run lint      # eslint
npm run build     # compile to dist/ and copy the web assets
```

Tests use fixtures/mocks for both the X API and the LLM, so they run offline with no credentials.
