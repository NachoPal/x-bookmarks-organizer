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
 *   `description` is a nullable one-line gloss emitted by the taxonomy-design
 *   pass (issue #61). It costs no extra LLM call - pass 1 already writes the
 *   tree - and is what separates ambiguous siblings from each other for both
 *   every prompt's tree and the TypeSafe categorizer's `Choice.criteria`.
 *   NULL for any node designed before this column existed, which every
 *   consumer must tolerate. `origin` is who made the node: `user` rows are
 *   the owner's and are PROTECTED - no sync, filing pass or recategorize may
 *   delete, rename, move or re-describe one (see `Database.clearGeneratedCategories`
 *   and `getOrCreateCategory`); the passes may only file posts into them and
 *   create generated nodes inside them.
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
 * - `article_link_metadata` caches the linked page's title/description used
 *   as extra categorization signal for link-heavy posts (issue #25), AND
 *   (`image`/`site_name`, added for issue #26) the viewer's link-preview card
 *   data, plus the `resolved_url` the shortened link actually landed on.
 *   `status` is tri-state - `ok` (readable article: card + body), `card`
 *   (preview card only) or `failed` (nothing usable) - so a page with an
 *   OpenGraph card but no long-form body still caches as a usable card.
 *   Keyed by URL rather than bookmark, because it must be fetched and
 *   fed into the categorization prompt BEFORE the bookmark is stored (and thus
 *   before it has a bookmark id) - and URL-keying also dedups bookmarks that
 *   share a link. Both a success and a failure are cached, mirroring
 *   `articles`, so a dead link is not re-fetched on every run. The viewer's
 *   bookmark list only ever READS this cache (never fetches live) - see
 *   `toViewerBookmark` in `src/web/server.ts` - so a bookmark's preview/
 *   "Read article" affordance appears once ingest (or `recategorize`) has
 *   populated this row for its link, not before.
 * - `x_articles` holds X-native long-form Articles (`x.com/i/article/<id>`),
 *   keyed by the Article's HOST post id - the data arrives on that post's
 *   `article` field from the X API, so no link fetch is involved (and
 *   `article_link_metadata`, being URL-keyed and fetch-populated, is the wrong
 *   home for it). A bookmark that IS an Article's host post joins on its own
 *   `post_id`; a bookmark that QUOTES one joins on `bookmarks.quoted_post_id`.
 *   Written atomically with the bookmark in `storeCategorizedBatch`, and by
 *   `backfill-x-articles` for bookmarks stored before this existed.
 * - `quoted_posts` holds the content (author + text + created_at) of an ORDINARY
 *   post a bookmark quotes, keyed by that quoted post's own `post_id` (same
 *   join as `x_articles`, via `bookmarks.quoted_post_id`). The data arrives on
 *   the SAME bookmarks/lookup request, in `includes.tweets[]` via the
 *   `referenced_tweets.id` expansion already requested - no separate fetch.
 *   Never holds a quoted post that turned out to host an X Article - that
 *   body stays solely in `x_articles`, so it is not duplicated here.
 * - `bookmark_scores` holds the opt-in Jev ranking pass's verdict for a
 *   bookmark (issue #62), keyed by bookmark AND `rubric_version`: one overall
 *   0..1 `score`, the model's own `confidence`, and the per-dimension 0..1
 *   scores the rubric asked for, kept individually so the weighting can be
 *   retuned (or a single dimension surfaced) without re-spending on a paid
 *   pass. The version is part of the key since issue #102: each rubric preset
 *   keeps its own verdicts, so switching to a preset already ranked under
 *   shows its scores at once and switching back never re-bills. A row exists
 *   only for a bookmark the owner actually paid to rank UNDER THAT RUBRIC, so
 *   every consumer must treat an absent row as "not scored" rather than
 *   "scored zero" - which is why the viewer sorts unscored bookmarks last
 *   instead of first - and must scope its read to the ACTIVE preset's version
 *   rather than to any row that happens to exist.
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
  read_at         TEXT,
  favorite        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id   INTEGER REFERENCES categories(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT,
  created_at  TEXT NOT NULL,
  origin      TEXT NOT NULL DEFAULT 'generated' CHECK (origin IN ('user', 'generated')),
  position    INTEGER,
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

CREATE TABLE IF NOT EXISTS article_link_metadata (
  url          TEXT PRIMARY KEY,
  status       TEXT NOT NULL,
  title        TEXT,
  description  TEXT,
  image        TEXT,
  site_name    TEXT,
  resolved_url TEXT,
  fetched_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS x_articles (
  post_id      TEXT PRIMARY KEY,
  rest_id      TEXT,
  title        TEXT,
  preview_text TEXT,
  plain_text   TEXT,
  cover_url    TEXT,
  cover_w      INTEGER,
  cover_h      INTEGER,
  fetched_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS quoted_posts (
  post_id         TEXT PRIMARY KEY,
  author_username TEXT NOT NULL DEFAULT '',
  author_name     TEXT NOT NULL DEFAULT '',
  text            TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL DEFAULT '',
  fetched_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bookmark_scores (
  bookmark_id     INTEGER NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
  score           REAL NOT NULL,
  confidence      REAL NOT NULL,
  dimensions      TEXT NOT NULL,
  model           TEXT NOT NULL,
  rubric_version  TEXT NOT NULL,
  scored_at       TEXT NOT NULL,
  PRIMARY KEY (bookmark_id, rubric_version)
);

-- Sorting a category by score is a paged server-side query, so the ordering
-- column is indexed rather than sorted in the client. The version leads the
-- index because every such query is scoped to ONE rubric (the active preset).
CREATE INDEX IF NOT EXISTS idx_bookmark_scores_version_score
  ON bookmark_scores(rubric_version, score);
`;

/**
 * Rebuild `bookmark_scores` with a `(bookmark_id, rubric_version)` primary key
 * (issue #102).
 *
 * Before rubric presets existed there was one rubric, so one score row per
 * bookmark was the whole truth and `bookmark_id` alone was the key. With named
 * presets the owner's decision is that each preset keeps ITS OWN scores:
 * switching to a preset already ranked under shows its verdicts instantly, and
 * switching back does not re-bill. A single-row-per-bookmark table cannot hold
 * that - the second preset's run would overwrite the first's - so the key has
 * to widen, which SQLite can only do by rebuilding the table.
 *
 * Lossless and idempotent: every existing row is copied verbatim (they all
 * carry their `rubric_version` already, which is why nothing has to be
 * re-computed or re-paid for), and {@link needsScoreKeyMigration} skips the
 * whole thing on a database that has already been through it.
 */
export const BOOKMARK_SCORES_REKEY_SQL = `
CREATE TABLE bookmark_scores_rekeyed (
  bookmark_id     INTEGER NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
  score           REAL NOT NULL,
  confidence      REAL NOT NULL,
  dimensions      TEXT NOT NULL,
  model           TEXT NOT NULL,
  rubric_version  TEXT NOT NULL,
  scored_at       TEXT NOT NULL,
  PRIMARY KEY (bookmark_id, rubric_version)
);
INSERT INTO bookmark_scores_rekeyed
  (bookmark_id, score, confidence, dimensions, model, rubric_version, scored_at)
  SELECT bookmark_id, score, confidence, dimensions, model, rubric_version, scored_at
    FROM bookmark_scores;
DROP TABLE bookmark_scores;
ALTER TABLE bookmark_scores_rekeyed RENAME TO bookmark_scores;
CREATE INDEX IF NOT EXISTS idx_bookmark_scores_version_score
  ON bookmark_scores(rubric_version, score);
`;

/**
 * Columns added to `article_link_metadata` after its original release
 * (issues #26, #45). `CREATE TABLE IF NOT EXISTS` above only covers a brand-new
 * database - an existing one needs these added explicitly, guarded by
 * `PRAGMA table_info` so re-running on an already-migrated database is a
 * no-op (SQLite's `ALTER TABLE ADD COLUMN` has no `IF NOT EXISTS` form).
 */
export const ARTICLE_LINK_METADATA_ADDED_COLUMNS: { name: string; ddl: string }[] = [
  { name: 'image', ddl: 'ALTER TABLE article_link_metadata ADD COLUMN image TEXT' },
  { name: 'site_name', ddl: 'ALTER TABLE article_link_metadata ADD COLUMN site_name TEXT' },
  { name: 'resolved_url', ddl: 'ALTER TABLE article_link_metadata ADD COLUMN resolved_url TEXT' },
];

/**
 * Columns added to `bookmarks` after its original release: `quoted_post_id`
 * links a quote post to the post it quotes, so a quote of an X Article
 * resolves to that Article's `x_articles` row; `favorite` is the owner's star
 * (issue #63), a durable per-bookmark flag exactly like `read`. Because
 * ingestion never overwrites an existing bookmark row (`ON CONFLICT(post_id)
 * DO NOTHING` in `storeCategorizedBatch`) and recategorization only rewrites
 * category links, both flags survive a later sync or `recategorize`. Same
 * `PRAGMA table_info` guard as {@link ARTICLE_LINK_METADATA_ADDED_COLUMNS}.
 */
/**
 * Columns added to `categories` after its original release: `description`, the
 * one-line gloss the taxonomy pass now emits per node (issue #61), and
 * `origin` - who made the node: `user` (the owner, in the category editor) or
 * `generated` (the taxonomy/assignment passes). There is no historical record
 * of which rows were hand-made, so an existing row migrates as `generated`;
 * the owner can mark one as theirs in the editor. `position` is the owner's
 * order among siblings (drag and drop, at any level): NULL means "never
 * ordered", which is every existing row and every row a sync creates - those
 * follow the ordered siblings, by name (`orderSiblings` in
 * `src/categorize/tree.ts`). Same
 * `PRAGMA table_info` guard as {@link ARTICLE_LINK_METADATA_ADDED_COLUMNS}, so
 * an existing database gains the column without losing data and re-opening an
 * already-migrated one is a no-op.
 */
export const CATEGORIES_ADDED_COLUMNS: { name: string; ddl: string }[] = [
  { name: 'description', ddl: 'ALTER TABLE categories ADD COLUMN description TEXT' },
  {
    name: 'origin',
    ddl: "ALTER TABLE categories ADD COLUMN origin TEXT NOT NULL DEFAULT 'generated' CHECK (origin IN ('user', 'generated'))",
  },
  { name: 'position', ddl: 'ALTER TABLE categories ADD COLUMN position INTEGER' },
];

/**
 * Columns added to `articles` after its original release: `content_text`, the
 * reader-view body as plain text (`htmlToPlainText` of `content_html`), written
 * by `Database.saveArticle`. It exists for the full-text index
 * (`src/db/search.ts`), whose triggers are pure SQL and so cannot strip HTML
 * themselves. Rows cached before it existed are back-filled on open.
 */
export const ARTICLES_ADDED_COLUMNS: { name: string; ddl: string }[] = [
  { name: 'content_text', ddl: 'ALTER TABLE articles ADD COLUMN content_text TEXT' },
];

export const BOOKMARKS_ADDED_COLUMNS: { name: string; ddl: string }[] = [
  { name: 'quoted_post_id', ddl: 'ALTER TABLE bookmarks ADD COLUMN quoted_post_id TEXT' },
  {
    name: 'favorite',
    ddl: 'ALTER TABLE bookmarks ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0',
  },
];
