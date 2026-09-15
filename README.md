# X Bookmarks Organizer

Fetch your X (Twitter) bookmarks, auto-categorize them into a nested topic tree with an LLM,
store them in a local SQLite database you fully own, and browse them through a simple local
web interface with read-tracking.

Runs occasionally and incrementally: each run only processes bookmarks added since the last run.

## Status

Early setup. The product requirements are defined; implementation has not started yet.

- Requirements: [`docs/prds/0001-x-bookmarks-organizer.md`](docs/prds/0001-x-bookmarks-organizer.md)

## Key properties

- **Ingestion:** official X API (pay-per-use, `bookmark.read`).
- **Categorization:** automatic, LLM-driven, nested tree, multi-category. Runs on your existing
  Claude subscription (via `claude setup-token`), not the pay-per-use API - no per-call cost.
- **Secrets:** X and Claude credentials live in a local secrets manager (Automic Vault) and are
  injected at run time, never written to `.env` or disk.
- **Storage:** local SQLite - a single portable file, no lock-in, free forever.
- **Viewer:** local web UI with embedded posts (link fallback) and read + read-date tracking.
