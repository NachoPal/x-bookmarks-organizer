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
- **Categorization** - runs on your **Claude subscription** (via the `claude` CLI in headless mode
  with `CLAUDE_CODE_OAUTH_TOKEN`), **not** the pay-per-use Anthropic API - so it adds no per-call
  dollar cost. It works in **two passes**:
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
  (Unread / Read / All).

## Prerequisites

- Node.js >= 20
- The `claude` CLI on your `PATH` (used for categorization on your subscription)
- [Automic Vault](docs/setup.md) (`av`) holding the three secrets below
- A pay-per-use X API app - see [`docs/setup.md`](docs/setup.md)

## Install & build

```bash
npm install
npm run build
```

## Secrets

All secrets are injected at run time from Automic Vault into the process environment. They are
**never** read from a committed file and **never** written to disk.

| Env var                   | What                                             |
| ------------------------- | ------------------------------------------------ |
| `XBOOKMARKS_CLIENT_ID`     | X OAuth 2.0 app Client ID                        |
| `XBOOKMARKS_CLIENT_SECRET` | X OAuth 2.0 app Client Secret                    |
| `CLAUDE_CODE_OAUTH_TOKEN`  | Claude subscription token (for categorization)   |

The documented run command wraps every invocation with `av inject`:

```bash
av inject +XBOOKMARKS_CLIENT_ID +XBOOKMARKS_CLIENT_SECRET +CLAUDE_CODE_OAUTH_TOKEN -- node dist/index.js
```

## Usage

**1. One-time login** (opens a browser once; stores a rotating refresh token locally so all later
runs are headless):

```bash
av inject +XBOOKMARKS_CLIENT_ID +XBOOKMARKS_CLIENT_SECRET +CLAUDE_CODE_OAUTH_TOKEN -- node dist/index.js login
```

**2. Ingest + categorize** (the default command; run this whenever - roughly weekly):

```bash
av inject +XBOOKMARKS_CLIENT_ID +XBOOKMARKS_CLIENT_SECRET +CLAUDE_CODE_OAUTH_TOKEN -- node dist/index.js
```

It prints a summary: how many new bookmarks, how many batches, how many new categories.

**Re-categorize** (optional) - rebuild the taxonomy and reassign **all** already-stored bookmarks
from scratch, without re-fetching from X. Use this to redo a shallow earlier run, or after changing
the taxonomy model / depth settings. Read state and read dates are preserved:

```bash
av inject +CLAUDE_CODE_OAUTH_TOKEN -- node dist/index.js recategorize
```

(X credentials are not needed for `recategorize` - it only re-reads the local database.)

**3. Browse** (the web viewer does not need any secrets):

```bash
node dist/index.js serve
# then open http://127.0.0.1:5173
```

## Configuration (optional env vars)

| Env var                 | Default                | Meaning                                  |
| ----------------------- | ---------------------- | ---------------------------------------- |
| `XBOOKMARKS_DB_PATH`     | `data/bookmarks.db`    | SQLite file location                     |
| `XBOOKMARKS_WEB_PORT`    | `5173`                 | Web viewer port                          |
| `XBOOKMARKS_AUTH_PORT`   | `3000`                 | One-time OAuth callback port             |
| `XBOOKMARKS_REDIRECT_URI`| `http://127.0.0.1:3000/callback` | OAuth redirect (must match the X app) |
| `XBOOKMARKS_MODEL`       | `claude-haiku-4-5`     | Assignment-pass model (Haiku-class)      |
| `XBOOKMARKS_TAXONOMY_MODEL` | `claude-opus-4-8`   | Taxonomy-design-pass model (Opus-class)  |
| `XBOOKMARKS_TAXONOMY_EFFORT` | `high`             | Taxonomy-pass effort (low/medium/high/xhigh/max) |
| `XBOOKMARKS_BATCH_SIZE`  | `15`                   | Bookmarks per assignment request         |
| `XBOOKMARKS_MIN_DEPTH`   | `3`                    | Target minimum nesting depth (best-effort) |
| `XBOOKMARKS_MAX_DEPTH`   | `4`                    | Maximum category tree depth              |

## Development

```bash
npm test          # unit tests (no network, no credentials)
npm run typecheck # tsc --noEmit
npm run lint      # eslint
npm run build     # compile to dist/ and copy the web assets
```

Tests use fixtures/mocks for both the X API and the LLM, so they run offline with no credentials.
