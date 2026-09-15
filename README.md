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
- **Categorization:** automatic, LLM-driven, nested tree, multi-category.
- **Storage:** local SQLite - a single portable file, no lock-in, free forever.
- **Viewer:** local web UI with embedded posts (link fallback) and read + read-date tracking.
