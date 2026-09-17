/**
 * Database schema, expressed as idempotent DDL applied on every open.
 *
 * Design notes:
 * - `bookmarks.post_id` is the natural key from X and is UNIQUE; incremental
 *   ingestion uses membership in this table as the "already seen" signal.
 * - `categories` is a self-referential tree; `UNIQUE(parent_id, name)` prevents
 *   duplicate siblings so get-or-create is deterministic. A NULL parent_id
 *   denotes a root node. SQLite treats NULLs as distinct in UNIQUE indexes, so
 *   root uniqueness is enforced separately by a partial index below.
 * - `bookmark_categories` is the many-to-many join (a bookmark may live in
 *   several branches at once).
 * - `run_state` holds the incremental cursor/marker and the persisted X OAuth
 *   refresh token, so later runs are headless. The DB file is gitignored.
 * - `deleted_bookmarks` is a tombstone of permanently-deleted post ids. A
 *   deleted bookmark is removed from `bookmarks` outright (cascading its
 *   category links), but its post id is kept here so incremental ingest never
 *   mistakes it for new and re-fetches/re-stores it.
 * - `articles` caches the reader-view extraction (readability + sanitize) for
 *   a bookmark's primary article link, keyed by bookmark - so a card's "Read"
 *   view is fetched from the source at most once. Both a successful
 *   extraction and a failure are cached (status distinguishes them) so a
 *   dead/paywalled link isn't re-fetched on every open either.
 * - `summaries` caches the on-demand LLM summary for a bookmark, keyed by
 *   bookmark, so re-opening the summary modal is instant and spends no extra
 *   subscription usage after the first generation.
 */
export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS bookmarks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id         TEXT NOT NULL UNIQUE,
  author_username TEXT NOT NULL DEFAULT '',
  author_name     TEXT NOT NULL DEFAULT '',
  text            TEXT NOT NULL DEFAULT '',
  url             TEXT NOT NULL,
  post_created_at TEXT NOT NULL DEFAULT '',
  ingested_at     TEXT NOT NULL,
  read            INTEGER NOT NULL DEFAULT 0,
  read_at         TEXT
);

CREATE TABLE IF NOT EXISTS categories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id  INTEGER REFERENCES categories(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(parent_id, name)
);

-- Enforce uniqueness of root node names (parent_id IS NULL), which the plain
-- UNIQUE(parent_id, name) constraint does not, because NULLs compare distinct.
CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_root_name
  ON categories(name) WHERE parent_id IS NULL;

CREATE TABLE IF NOT EXISTS bookmark_categories (
  bookmark_id INTEGER NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  PRIMARY KEY (bookmark_id, category_id)
);

CREATE INDEX IF NOT EXISTS idx_bc_category ON bookmark_categories(category_id);
CREATE INDEX IF NOT EXISTS idx_categories_parent ON categories(parent_id);

CREATE TABLE IF NOT EXISTS run_state (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS deleted_bookmarks (
  post_id    TEXT PRIMARY KEY,
  deleted_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS articles (
  bookmark_id  INTEGER PRIMARY KEY REFERENCES bookmarks(id) ON DELETE CASCADE,
  url          TEXT NOT NULL,
  status       TEXT NOT NULL,
  title        TEXT,
  content_html TEXT,
  excerpt      TEXT,
  site_name    TEXT,
  reason       TEXT,
  fetched_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS summaries (
  bookmark_id  INTEGER PRIMARY KEY REFERENCES bookmarks(id) ON DELETE CASCADE,
  summary      TEXT NOT NULL,
  generated_at TEXT NOT NULL
);
`;
