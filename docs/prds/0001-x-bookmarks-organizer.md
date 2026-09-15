# X Bookmarks Organizer

**Status:** Draft
**Owner:** Ignacio Palacios
**Last updated:** 2026-09-15
**Related:** implementation plan TBD

## Problem

X (Twitter) bookmarks are a flat, ever-growing, unsearchable pile. Once you have a few hundred,
finding "that one post about X" is hopeless, and there is no good way to group them by topic or
track which ones you have already revisited. X's own bookmark folders (a Premium feature) exist but
are **flat** - a single level with no nesting - which is too coarse for real topics that have
sub-topics.

There is no tool that (a) pulls Ignacio's own bookmarks, (b) sorts them into a meaningful,
**nested** topic tree automatically, and (c) lets him browse and track what he has read - all while
keeping the data fully owned, local, and free of subscription lock-in.

## Goals & success metrics

- **Zero rework per run.** A run processes only bookmarks added since the previous run; previously
  seen bookmarks are never re-fetched or re-categorized. Checkable: re-running immediately after a
  run processes 0 items.
- **Everything gets filed.** 100% of newly ingested bookmarks land in at least one category.
- **Cheap to run.** A run over a few hundred bookmarks costs only the X API bookmark reads
  (~$0.50 at ~$0.001 each), with no minimum spend. Categorization runs on Ignacio's existing
  Claude subscription, so it adds no per-run dollar cost (only subscription usage).
- **Zero manual data handling.** From "run finished" to "browsing categorized bookmarks in the web
  viewer" there are no manual import/export steps.
- **Owned and portable.** All data lives in a single local file fully owned by Ignacio, movable
  elsewhere without an export step.

## Non-goals

- **Not a knowledge graph / "second brain."** No note-linking, backlinks, or node graph between
  bookmarks. This is a categorized, stateful list with a topic tree, not a wiki.
- **Not multi-user or hosted.** Single user, runs locally on Ignacio's own machine. No cloud
  service, no accounts, no sharing.
- **Read-only against X.** The tool never posts, likes, un-bookmarks, or writes anything back to X.
- **No un-bookmark syncing in v1.** If a bookmark is removed on X, the tool does not detect or
  remove it. The store is additive for now.
- **No mobile app.**
- **Not a paid-tier dependency.** No tool whose free tier could later be revoked (rules out
  Notion-style storage).

## Users & use cases

Single user: Ignacio Palacios.

- *I want to run one command occasionally (roughly weekly) so my new X bookmarks get sorted into a
  topic tree without me touching each one.*
- *I want to open a simple web page, drill into a topic (and its sub-topics), and see the bookmarks
  in it - the actual post where possible, a link otherwise - so I can revisit what I saved.*
- *I want each bookmark to show whether I have already read it and when, so I can tell new material
  from stuff I have already been through.*

## Requirements

### Must (P0)

- Fetch bookmarks from Ignacio's authenticated X account via the official X API.
- **Incremental ingestion:** each run ingests only bookmarks that are new since the last run and
  never re-processes previously seen bookmarks. (The detection mechanism is an implementation detail
  for the plan - see open questions for why naive date-based detection is unsafe.)
- Categorize each new bookmark automatically with an LLM: place it in one or more existing
  categories where they fit, and create a new category only when none fit.
- **Hierarchical categories:** categories form a nested tree of arbitrary depth (e.g.
  "Video Game Development" > "Asset Creation Tools" / "Marketing"; "AI" > "Harnesses" / "Evals"),
  not a flat list. The LLM places a bookmark at the most specific fitting node and may create new
  parent or child nodes when needed.
- **Multi-category:** a bookmark may belong to several categories/branches at once.
- Store bookmarks, the category tree, and their relationships in a **local SQLite database** - a
  single portable file owned by Ignacio.
- Retain enough per bookmark to display it and link back to the original post (post URL, author,
  text, timestamp, X post id).
- Provide a **local web interface** that shows the category tree and, on opening a node, shows the
  bookmarks in it.
- In the viewer, show each bookmark as an **embedded X post** where the post is publicly embeddable,
  falling back to a link to the post otherwise.
- **Read tracking:** opening/viewing a bookmark marks it read and records the read timestamp; read
  vs unread state is visible in the UI.

### Should (P1)

- Refresh X API authentication across runs without a manual re-login each time.
- Search/filter within the viewer (by text or author).
- Show read/unread counts per category node (optionally rolled up to parents).
- Safe, idempotent re-runs: an interrupted run does not duplicate or corrupt stored data.

### Could (P2)

- Manual editing of the tree in the UI: re-categorize, rename, move, or merge nodes.
- Periodic consolidation of near-duplicate categories.
- An export/report view.

## UX / flows

1. **Ingest+categorize (headless):** run the tool -> it fetches new bookmarks -> LLM places them in
   the topic tree -> results written to SQLite. A short summary is printed (N new, nodes touched,
   new nodes created, run cost).
2. **Browse (web):** open the local web page -> see the category tree with counts -> drill into a
   node -> see its bookmarks (embedded post or link) -> opening a bookmark marks it read with a
   timestamp.

Detailed screen design belongs in the plan; the flows above are the contract.

## Constraints & dependencies

- **X API:** pay-per-use account with a small credit balance; `bookmark.read` scope; OAuth 2.0
  user-context auth. Bookmark reads bill as "owned reads" (~$0.001 each), no minimum spend.
- **Claude subscription** for categorization: the categorization step runs on Ignacio's existing
  Claude subscription (via the Claude Agent SDK / `claude` headless with a `claude setup-token`
  credential), not the pay-per-use Anthropic API, so it adds no per-call dollar cost. It is subject
  to the subscription's usage limits rather than API billing, so runs batch multiple bookmarks per
  request to stay efficient. No `ANTHROPIC_API_KEY` is used.
- **Secrets** (X OAuth 2.0 Client ID/Secret, Claude token) are held in a local secrets manager
  (Automic Vault) and injected into the process environment at run time, never written to disk.
- **Local runtime:** runs on Ignacio's machine, invoked manually/occasionally. No always-on server
  beyond the local web viewer when browsing.
- **Free-forever tooling only:** SQLite and a local web stack; nothing with a revocable free tier.

## Risks & open questions

- **Incremental detection is the key technical risk.** Post date is unreliable, because old posts
  may be freshly bookmarked. Detection must be based on bookmark order / an API cursor / last-seen
  marker, not post date. Resolved in the implementation plan, flagged here so it is not designed by
  accident.
- **Nested categorization quality.** Keeping the tree coherent over many runs (right depth, no
  sprawl, stable parents) is the main product risk of the LLM step; may need guardrails (max depth,
  reuse-existing-node bias) and the P2 consolidation step.
- **X native folders:** should the tool ingest X's flat native bookmark folders as seed hints for
  the tree, or ignore them and build the tree purely from content? (Leaning: ignore for v1, build
  from content.)
- **Embedding limits:** deleted or protected posts cannot be embedded; the link fallback covers
  them, but some bookmarks will show only a link.
- **Un-bookmark handling** is out of scope for v1 (non-goal); revisit if it becomes annoying.
- **Scale:** designed for hundreds of bookmarks. Very large accounts (thousands) may need pagination
  care but are not the target.
- **Project name** ("X Bookmarks Organizer") and repo location are not yet fixed.

## Rollout

Single-user, single phase. Rough build sequence (detail belongs in the plan):

1. X API auth + bookmark ingestion into SQLite.
2. Incremental cursor + LLM categorization into the nested tree (existing-or-new nodes,
   multi-category).
3. Local web viewer with the tree, embedded posts, link fallback, and read tracking.

Ships all-at-once for personal use; no flags or staged rollout needed.
