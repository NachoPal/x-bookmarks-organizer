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

## 3. Provide the two X app secrets (one time)

The tool reads these **only** from the process environment - never from a committed file, never
written to disk. Provide them however you already manage secrets (export them, a `.env` file, CI
secrets, or a manager such as Automic Vault's `av inject`):

| Env var                    | Value                                                            |
| --------------------------- | ---------------------------------------------------------------- |
| `XBOOKMARKS_CLIENT_ID`      | X app OAuth 2.0 Client ID (from step 1)                          |
| `XBOOKMARKS_CLIENT_SECRET`  | X app OAuth 2.0 Client Secret (from step 1)                      |

Using Automic Vault as an example, every command that touches X is wrapped with:

```bash
av inject +XBOOKMARKS_CLIENT_ID +XBOOKMARKS_CLIENT_SECRET -- <command>
```

## 4. Claude availability (usually nothing to do)

Categorization and summaries run on your Claude subscription via the `claude` CLI, not the paid
Anthropic API. The tool **probes** for Claude rather than requiring a secret: if the `claude` CLI
is on your `PATH` and logged in (which it is if you already use it interactively), everything
just works - no token, no vault entry needed.

Only on a **headless** machine with no interactive `claude` login do you need a token. Generate
one:

```bash
claude setup-token
```

and set it as `CLAUDE_CODE_OAUTH_TOKEN` however you provide env vars (e.g. `av inject
+CLAUDE_CODE_OAUTH_TOKEN -- <command>`). The tool passes this through to the `claude` CLI in
headless mode and never sets `ANTHROPIC_API_KEY`, so no pay-per-use API billing can occur.

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
av inject +XBOOKMARKS_CLIENT_ID +XBOOKMARKS_CLIENT_SECRET -- node dist/index.js login
```

## 7. Run and browse

Ingest + categorize (repeat whenever, roughly weekly):

```bash
av inject +XBOOKMARKS_CLIENT_ID +XBOOKMARKS_CLIENT_SECRET -- node dist/index.js
```

Re-categorize all stored bookmarks from scratch (optional; no X fetch, read state preserved):

```bash
node dist/index.js recategorize
```

Start the local web viewer and open the printed URL. It needs no secrets to browse; if Claude is
available (per step 4), on-demand summaries work automatically too:

```bash
node dist/index.js serve
# http://127.0.0.1:5173
```

If Claude isn't available (`claude` CLI missing/not logged in, and no token set), the "Summarize"
button is disabled with a tooltip explaining why - everything else still works.

## Troubleshooting

- **"Not logged in to X yet"** - run the `login` command (step 6) first.
- **"Missing required secret(s)"** - `XBOOKMARKS_CLIENT_ID`/`XBOOKMARKS_CLIENT_SECRET` are not in
  the environment; provide them via `av inject` or however you set env vars.
- **"Claude is not available" / Summarize button disabled** - the `claude` CLI isn't on `PATH` or
  isn't logged in, and `CLAUDE_CODE_OAUTH_TOKEN` isn't set. Run `claude` interactively to check
  your login, or set the token per step 4.
- **No refresh token returned at login** - confirm the X app is a *confidential* client and the
  `offline.access` scope is allowed.
- **Embeds show only a link** - the post is deleted or from a protected account and cannot be
  embedded; the link fallback is expected there.
- **Move your data** - copy `data/bookmarks.db` (and its `-wal`/`-shm` siblings if present) to move
  or back up everything; it is a single portable SQLite file.
