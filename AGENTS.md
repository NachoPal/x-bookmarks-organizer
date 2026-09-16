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

To iterate on the viewer without the owner's private DB, seed a throwaway one and serve it:
`npm run build && npm run seed:dev && XBOOKMARKS_DB_PATH=data/dev-seed.db node dist/index.js serve`
(`scripts/seed-dev-db.js` builds a deep sample taxonomy; `data/*.db` is gitignored - never commit
real data).

## Live vs. tested

The live OAuth browser consent and the vault-injected run are performed by the operator. Automated
validation uses fixtures/mocks for both the X API (`XClient` interface) and the LLM
(`BatchCategorizer` interface); keep those seams so tests stay offline.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
