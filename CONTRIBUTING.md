# Contributing to X Bookmarks Organizer

Thanks for your interest in this project. It is a personal, single-user tool - built for one
owner's X bookmark library - but issues, fixes and improvements are welcome. This guide covers
local setup, the conventions CI enforces, and the hard invariants a change must not break.

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to contribute

- **Fix a bug or improve a feature** - see the [open issues](https://github.com/NachoPal/x-bookmarks-organizer/issues).
- **Improve the docs** - this README, [`docs/setup.md`](docs/setup.md), or
  [`AGENTS.md`](AGENTS.md).
- For anything larger than a small fix, please open an issue first so the approach can be agreed
  on before you invest time.

## Project layout

TypeScript on Node, compiled with `tsc`. The single entry point is `src/index.ts` (CLI commands:
`run` (default), `login`, `recategorize`, `rank`, `serve`, and a handful of one-off backfill/clear
commands - see the [README](README.md#usage)). Ingestion, categorization, ranking and the Fastify
web viewer all live under `src/`; tests are colocated `*.test.ts` files (Vitest) and run offline
with no network and no credentials.

[`AGENTS.md`](AGENTS.md) is the authoritative architecture doc - stack & layout, the hard
constraints (subscription-only categorization, the credential chain, incremental sync semantics),
the LLM provider abstraction, and a section-by-section history of every feature. Read it before
making a non-trivial change; it is kept up to date as the project's project memory.

## Local setup

You need Node.js >= 20.

```bash
npm install
npm run build     # tsc -> dist/, then copies src/web/public/ assets
npm test          # vitest, offline - no network, no credentials
npm run typecheck # tsc --noEmit
npm run lint      # eslint over the TypeScript and src/web/public/**/*.js
```

To run the app itself without touching the owner's real library, seed a throwaway database and
serve that instead of pointing at real X credentials:

```bash
npm run seed:dev
XBOOKMARKS_DB_PATH=data/dev-seed.db node dist/index.js serve
```

`data/` is gitignored - never commit a real or seeded `.db` file. See
[`docs/setup.md`](docs/setup.md) for the full one-time setup (X API app, OAuth, the `claude` CLI)
needed to run against a real library.

## Branch & PR conventions

- Branch off `main`; name branches descriptively (e.g. `fix/sync-race`, `feat/rank-dry-run`,
  `docs/setup-clarify`).
- Keep a PR focused - a behavior change plus a large unrelated refactor is two PRs.
- Write a clear PR description of *what* changed and *why*, and reference any issue it resolves.

## CI gates

Every PR runs [`.github/workflows/ci.yml`](.github/workflows/ci.yml). It must be green to merge.
The steps, and how to reproduce each locally:

| CI step | Reproduce locally | What it checks |
| --- | --- | --- |
| **Typecheck** | `npm run typecheck` | `tsc --noEmit` across the project. |
| **Lint** | `npm run lint` | eslint over the TypeScript and the plain browser JS under `src/web/public/`. |
| **Test** | `npm test` | The full Vitest suite - entirely offline (fixtures/mocks for the X API and the LLM). |
| **Build** | `npm run build` | Compiles to `dist/` and copies the web viewer's static assets. |

## Hard invariants (do not break these)

These hold regardless of configuration; several are enforced by tests. See
[`AGENTS.md`](AGENTS.md#hard-constraints-do-not-regress) for the full list with file pointers -
the essentials a contributor must never violate:

- **Categorization runs on the Claude subscription, never the paid Anthropic API.** Never introduce
  `@anthropic-ai/sdk` or require `ANTHROPIC_API_KEY` in that path.
- **No paid feature spends silently.** Every paid path (the TypeSafe/Jev assignment categorizer,
  ranking, `eval-categorizers`) is off by default or key-gated, requires an explicit opt-in, and
  announces its billing before every run. A new paid path needs the same guarantees.
- **Never commit secrets or personal data.** `.env`, `credentials.json`, and everything under
  `data/` (the SQLite database, `eval` reports) are gitignored - keep it that way, and never commit
  a real or seeded `.db` file.
- **Secrets resolve through the layered credential chain** (`src/creds/resolve.ts`) - environment,
  then `.env`, then the OS keychain, then `~/.config/x-bookmarks-organizer/credentials.json`. Don't
  add a path that reads a *committed* file or bypasses this chain.
- **Incremental sync never re-touches stored bookmarks.** Detection is by database membership, not
  post date; a bookmark is only marked "seen" once it is stored with its categories.
- **CHANGELOG-style or other auto-generated files are not hand-edited** - if the project ever
  introduces one, treat it as generated output, not something to write by hand.

If a change needs to bend one of these, open an issue to discuss the approach first.

## Reporting bugs

Open a [GitHub issue](https://github.com/NachoPal/x-bookmarks-organizer/issues/new) describing
what you expected, what happened instead, and how to reproduce it.

## License

By contributing, you agree that your contributions are licensed under the project's
[MIT License](LICENSE).
