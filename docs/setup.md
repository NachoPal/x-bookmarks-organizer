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

## 3. Store the three secrets in Automic Vault (one time)

The tool reads all secrets from the environment; Automic Vault (`av`) injects them at run time so
nothing is ever written to disk or committed. Store these three keys in your vault:

| Vault key                  | Value                                                            |
| -------------------------- | ---------------------------------------------------------------- |
| `XBOOKMARKS_CLIENT_ID`      | X app OAuth 2.0 Client ID (from step 1)                          |
| `XBOOKMARKS_CLIENT_SECRET`  | X app OAuth 2.0 Client Secret (from step 1)                      |
| `CLAUDE_CODE_OAUTH_TOKEN`   | Your Claude subscription token (from step 4)                     |

Every command that touches X or the LLM is wrapped with:

```bash
av inject +XBOOKMARKS_CLIENT_ID +XBOOKMARKS_CLIENT_SECRET +CLAUDE_CODE_OAUTH_TOKEN -- <command>
```

## 4. Get the Claude subscription token (one time)

Categorization runs on your Claude subscription via the `claude` CLI, not the paid Anthropic API.
Generate a long-lived subscription token:

```bash
claude setup-token
```

Store the resulting token in the vault as `CLAUDE_CODE_OAUTH_TOKEN` (step 3). The tool passes this
to the `claude` CLI in headless mode and never sets `ANTHROPIC_API_KEY`, so no pay-per-use API
billing can occur.

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
av inject +XBOOKMARKS_CLIENT_ID +XBOOKMARKS_CLIENT_SECRET +CLAUDE_CODE_OAUTH_TOKEN -- node dist/index.js login
```

## 7. Run and browse

Ingest + categorize (repeat whenever, roughly weekly):

```bash
av inject +XBOOKMARKS_CLIENT_ID +XBOOKMARKS_CLIENT_SECRET +CLAUDE_CODE_OAUTH_TOKEN -- node dist/index.js
```

Re-categorize all stored bookmarks from scratch (optional; no X fetch, read state preserved):

```bash
av inject +CLAUDE_CODE_OAUTH_TOKEN -- node dist/index.js recategorize
```

Start the local web viewer (no secrets needed - browsing and cached summaries work without one)
and open the printed URL:

```bash
node dist/index.js serve
# http://127.0.0.1:5173
```

To also generate NEW on-demand summaries (the "Summarize" button), pass the Claude token:

```bash
av inject +CLAUDE_CODE_OAUTH_TOKEN -- node dist/index.js serve
```

## Troubleshooting

- **"Not logged in to X yet"** - run the `login` command (step 6) first.
- **"Missing required secret(s)"** - you ran the command without `av inject`, or a key is missing
  from the vault.
- **No refresh token returned at login** - confirm the X app is a *confidential* client and the
  `offline.access` scope is allowed.
- **Embeds show only a link** - the post is deleted or from a protected account and cannot be
  embedded; the link fallback is expected there.
- **Move your data** - copy `data/bookmarks.db` (and its `-wal`/`-shm` siblings if present) to move
  or back up everything; it is a single portable SQLite file.
