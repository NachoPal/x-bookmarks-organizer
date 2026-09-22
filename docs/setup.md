# Setup guide

One-time setup for X Bookmarks Organizer. After this, a run is a single command and the web
viewer needs no secrets.

## 1. Create the X API app (one time)

1. Go to the [X Developer Portal](https://developer.x.com/) and sign in with your X account.
2. Create a **Project** and an **App** inside it.
3. In the app's **User authentication settings**, enable **OAuth 2.0** and configure:
   - **Type of App:** Web App / Confidential client (so it has a Client Secret).
   - **App permissions:** Read (bookmark reads only; the tool never writes back to X).
   - **Callback URI / Redirect URL:** exactly `http://127.0.0.1:3000/callback`
     (this must match `XBOOKMARKS_REDIRECT_URI`; the default is already this value).
   - **Website URL:** any valid URL (e.g. your X profile).
4. Note the **OAuth 2.0 Client ID** and **Client Secret**. These are the values you will store as
   `XBOOKMARKS_CLIENT_ID` and `XBOOKMARKS_CLIENT_SECRET`.

The scopes the tool requests are `bookmark.read tweet.read users.read offline.access`
(`offline.access` is what lets later runs refresh headlessly without another browser login).

## 2. Load pay-per-use API credit (one time)

Bookmark reads bill as "owned reads" at roughly \$0.001 each with no minimum spend. In the X
Developer Portal, open **Billing / Usage** and add a small amount of pay-per-use credit
(a few dollars covers many runs over hundreds of bookmarks). No subscription tier is required for
bookmark reads.

> Categorization is separate and costs **no** X credit and **no** Anthropic API dollars - it runs on
> your existing Claude subscription. See step 4.

## 3. Get the secrets to the tool (one time)

The tool resolves secrets through a **layered credential chain**, first hit wins - there is no
single required mechanism:

1. **The process environment** - a shell profile, a systemd unit, a Docker `-e` flag, CI secrets,
   or a vault such as Automic Vault. Unchanged from before this chain existed.
2. **A `.env` file in the project root** - the easiest option if you have no vault. Copy
   [`.env.example`](../.env.example) to `.env` (gitignored) and fill it in.
3. **Your OS keychain** (macOS Keychain / Linux Secret Service / Windows Credential Manager).
4. **`~/.config/x-bookmarks-organizer/credentials.json`**, owner-only (`chmod 600`).

Nothing is ever read from a *committed* file.

| Env var                    | Value                                                            |
| -------------------------- | ---------------------------------------------------------------- |
| `XBOOKMARKS_CLIENT_ID`      | X app OAuth 2.0 Client ID (from step 1)                          |
| `XBOOKMARKS_CLIENT_SECRET`  | X app OAuth 2.0 Client Secret (from step 1)                      |
| `CLAUDE_CODE_OAUTH_TOKEN`   | Claude subscription token (step 4) - **optional**, see below     |

Quickest: `cp .env.example .env` and fill in the values. If you already use a vault such as
Automic Vault (`av`), it keeps working unchanged, injecting per command:

```bash
av inject +XBOOKMARKS_CLIENT_ID +XBOOKMARKS_CLIENT_SECRET -- <command>
```

## 4. Make the LLM provider available (one time)

Categorization and summaries run through the LLM provider named by `XBOOKMARKS_LLM_PROVIDER`
(default `claude-cli`): your Claude subscription via the local `claude` CLI, not the paid Anthropic
API. Install the CLI and log in once, interactively:

```bash
claude           # then complete the login, once
claude --version # this is exactly what the app probes for availability
```

That is normally all that is needed. For an unattended environment where no interactive login is
possible, generate a long-lived subscription token instead and export it as
`CLAUDE_CODE_OAUTH_TOKEN`:

```bash
claude setup-token
```

Either way the app strips `ANTHROPIC_API_KEY` from the CLI's environment, so no pay-per-use API
billing can occur. If `claude` is installed somewhere off your `PATH`, point `XBOOKMARKS_CLAUDE_BIN`
at it.

The same token can instead drive the opt-in `pi-claude-subscription` provider, which runs the
subscription through pi. Anthropic's Claude Code terms prohibit that use and it carries a risk to your
account; `claude-cli` stays the default. See the README's "Claude subscription through pi" section.

## 5. Build the tool

```bash
npm install
npm run build
```

## 6. One-time OAuth login

Run the login command once. It opens your browser to X's consent screen, receives the redirect on
`http://127.0.0.1:3000/callback`, and stores a rotating refresh token in the local SQLite database
(gitignored). All later runs are headless.

```bash
node dist/index.js login
# or, with a vault instead of .env:
av inject +XBOOKMARKS_CLIENT_ID +XBOOKMARKS_CLIENT_SECRET -- node dist/index.js login
```

## 7. Run and browse

Ingest + categorize (repeat whenever, roughly weekly):

```bash
node dist/index.js
```

Re-categorize all stored bookmarks from scratch (optional; no X fetch, read state preserved):

```bash
node dist/index.js recategorize
```

If your library predates the article previews feature, backfill link metadata for already-stored
bookmarks so it feeds Summarize and categorization (no X fetch, no category/taxonomy changes,
idempotent - safe to re-run):

```bash
node dist/index.js backfill-previews
```

If your library predates X Article support, read the X Article data (title, preview, cover, body)
for already-stored bookmarks that link or quote an X Article. This is a small one-time PAID X read
(`--dry-run` prints what it would read and the estimated cost without calling X); run
`backfill-previews` first so links are resolved:

```bash
node dist/index.js backfill-x-articles
```

Start the local web viewer (no X secrets needed - browsing and cached summaries work without any)
and open the printed URL:

```bash
node dist/index.js serve
# http://127.0.0.1:5173
```

Re-fetch bookmark articles cached as unreadable (e.g. after an extraction fix) and drop only the
cached summaries of those that now have a body, so Summarize regenerates them with the article (no
secrets, idempotent):

```bash
node dist/index.js refetch-articles
```

Wipe all cached summaries so they regenerate cleanly under the current logic (no secrets, no
network, idempotent - safe to re-run):

```bash
node dist/index.js clear-summaries
```

Generating NEW on-demand summaries (the "Summarize" button) additionally needs the LLM provider from
step 4 to be available. `serve` prints which provider and model it resolved, or exactly why
summaries are disabled.

## Troubleshooting

- **"Not logged in to X yet"** - run the `login` command (step 6) first.
- **"Missing required secret(s)"** - the X credentials were not found in any tier of the credential
  chain: not in the environment (with `av`, that means you ran it without `av inject`, or a key is
  missing from the vault), not in a `.env` file, not in your OS keychain, and not in
  `~/.config/x-bookmarks-organizer/credentials.json`. The error message lists all four.
- **"Summaries disabled" / the Summarize button is disabled** - the viewer prints the provider's own
  reason at startup, and the button's tooltip repeats it. For `claude-cli` it is almost always that
  the `claude` CLI is not installed, not on `PATH`, or not logged in; `claude --version` reproduces
  the check the app makes.
- **No refresh token returned at login** - confirm the X app is a *confidential* client and the
  `offline.access` scope is allowed.
- **Embeds show only a link** - the post is deleted or from a protected account and cannot be
  embedded; the link fallback is expected there.
- **Move your data** - copy `data/bookmarks.db` (and its `-wal`/`-shm` siblings if present) to move
  or back up everything; it is a single portable SQLite file.
