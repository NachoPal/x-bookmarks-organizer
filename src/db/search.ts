/**
 * Full-text search over the library (the MCP server's `search_bookmarks`).
 *
 * `bookmark_fts` is an FTS5 table with one row per bookmark (`rowid` =
 * `bookmarks.id`) whose columns gather everything a person might remember a
 * post by: its own text, its author, the post it quotes, the article it links
 * to (the ingest-time title/description, the reader-view title and body once
 * cached, an X Article's title and body) and its saved summary.
 *
 * It is kept in sync by TRIGGERS, not by the write methods, on purpose: those
 * pieces live in six tables written from a dozen places (ingest, the X Article
 * backfill, Summarize, `refetch-articles`, a category delete, a reset...), and
 * a trigger cannot be forgotten by the next write path someone adds. Every
 * trigger does the same thing - re-derive the affected bookmarks' documents
 * from their source rows ({@link refreshSql}) - so an insert, an update and a
 * delete are all one idempotent refresh, and the document is only ever defined
 * once ({@link documentSelectSql}).
 *
 * The derivation is pure SQL, so it holds for any connection. The one piece
 * SQL cannot derive, an article body's plain text from its sanitized HTML, is
 * stored beside it as `articles.content_text` by `Database.saveArticle`.
 *
 * {@link SEARCH_INDEX_VERSION} is recorded in `run_state`; a database whose
 * index was built under another version (or never) is rebuilt from scratch on
 * open, which is also the migration for a library that predates search.
 */

/** Bump whenever the document or the triggers change; a mismatch rebuilds the index on open. */
export const SEARCH_INDEX_VERSION = '1';

/** `run_state` key holding the version the current index was built under. */
export const SEARCH_INDEX_VERSION_KEY = 'search_index_version';

/**
 * The FTS5 columns, in order. `bm25` weights follow the same order: a hit in
 * the post itself counts most, then its author and saved summary.
 */
export const SEARCH_COLUMNS = ['post', 'author', 'quoted', 'article', 'summary'] as const;
export const SEARCH_WEIGHTS = [4, 2, 1.5, 1, 1.5];

const TRIGGER_PREFIX = 'bookmark_fts_';

/**
 * The search document of every bookmark `b` matched by `where`, as
 * `(rowid, post, author, quoted, article, summary)`.
 *
 * A linked page's metadata is URL-keyed and the URL lives inside the post
 * text (X shortens every link to `t.co`), so it joins on containment; a
 * `failed` fetch carries nothing worth indexing.
 */
function documentSelectSql(where: string): string {
  return `SELECT
      b.id,
      b.text,
      b.author_username || ' ' || b.author_name,
      COALESCE((SELECT qp.author_username || ' ' || qp.author_name || ' ' || qp.text
                  FROM quoted_posts qp WHERE qp.post_id = b.quoted_post_id), ''),
      COALESCE((SELECT group_concat(COALESCE(alm.title, '') || ' ' || COALESCE(alm.description, '') || ' ' ||
                                    COALESCE(alm.site_name, ''), ' ')
                  FROM article_link_metadata alm
                 WHERE alm.status <> 'failed' AND alm.url <> '' AND instr(b.text, alm.url) > 0), '')
        || ' ' ||
      COALESCE((SELECT COALESCE(a.title, '') || ' ' || COALESCE(a.content_text, a.excerpt, '')
                  FROM articles a WHERE a.bookmark_id = b.id AND a.status = 'ok'), '')
        || ' ' ||
      COALESCE((SELECT group_concat(COALESCE(xa.title, '') || ' ' || COALESCE(xa.preview_text, '') || ' ' ||
                                    COALESCE(xa.plain_text, ''), ' ')
                  FROM x_articles xa WHERE xa.post_id = b.post_id OR xa.post_id = b.quoted_post_id), ''),
      COALESCE((SELECT s.summary FROM summaries s WHERE s.bookmark_id = b.id), '')
    FROM bookmarks b
    WHERE ${where}`;
}

/** Replace the documents of the bookmarks whose ids `ids` (a SQL set expression) yields. */
function refreshSql(ids: string): string {
  return `DELETE FROM bookmark_fts WHERE rowid IN (${ids});
    INSERT INTO bookmark_fts (rowid, ${SEARCH_COLUMNS.join(', ')})
    ${documentSelectSql(`b.id IN (${ids})`)};`;
}

/**
 * One AFTER trigger per event on `table`, each refreshing the bookmarks that
 * `ids(row)` names for the affected row (`NEW` for insert/update, `OLD` for
 * delete). `updateOf` narrows the UPDATE trigger to the columns that feed the
 * document, so marking a post read never touches the index.
 */
function sourceTriggers(table: string, ids: (row: 'NEW' | 'OLD') => string, updateOf?: string[]): string {
  const events: [string, 'NEW' | 'OLD'][] = [
    ['INSERT', 'NEW'],
    [`UPDATE${updateOf ? ` OF ${updateOf.join(', ')}` : ''}`, 'NEW'],
    ['DELETE', 'OLD'],
  ];
  return events
    .map(([event, row]) => {
      const name = `${TRIGGER_PREFIX}${table}_${event.split(' ')[0]!.toLowerCase()}`;
      let body = refreshSql(ids(row));
      // An UPDATE may move a row between bookmarks (a link's URL, a quote's
      // id): refresh the ones it left as well as the ones it joined.
      if (row === 'NEW' && event.startsWith('UPDATE')) body += refreshSql(ids('OLD'));
      return `CREATE TRIGGER IF NOT EXISTS ${name} AFTER ${event} ON ${table} BEGIN ${body} END;`;
    })
    .join('\n');
}

/** The table, its supporting index and every trigger. Idempotent. */
export const SEARCH_SCHEMA_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS bookmark_fts USING fts5(
  ${SEARCH_COLUMNS.join(', ')},
  tokenize = 'porter unicode61 remove_diacritics 2'
);

-- The quote joins below look bookmarks up by the post they quote.
CREATE INDEX IF NOT EXISTS idx_bookmarks_quoted_post ON bookmarks(quoted_post_id);

CREATE TRIGGER IF NOT EXISTS ${TRIGGER_PREFIX}bookmarks_insert AFTER INSERT ON bookmarks BEGIN
  ${refreshSql('NEW.id')}
END;
CREATE TRIGGER IF NOT EXISTS ${TRIGGER_PREFIX}bookmarks_update
  AFTER UPDATE OF text, author_username, author_name, post_id, quoted_post_id ON bookmarks BEGIN
  ${refreshSql('NEW.id')}
END;
CREATE TRIGGER IF NOT EXISTS ${TRIGGER_PREFIX}bookmarks_delete AFTER DELETE ON bookmarks BEGIN
  DELETE FROM bookmark_fts WHERE rowid = OLD.id;
END;

${sourceTriggers('summaries', (r) => `${r}.bookmark_id`)}
${sourceTriggers('articles', (r) => `${r}.bookmark_id`, ['status', 'title', 'content_text', 'excerpt'])}
${sourceTriggers(
  'x_articles',
  (r) => `SELECT id FROM bookmarks WHERE post_id = ${r}.post_id OR quoted_post_id = ${r}.post_id`,
  ['post_id', 'title', 'preview_text', 'plain_text'],
)}
${sourceTriggers(
  'quoted_posts',
  (r) => `SELECT id FROM bookmarks WHERE quoted_post_id = ${r}.post_id`,
  ['post_id', 'author_username', 'author_name', 'text'],
)}
${sourceTriggers(
  'article_link_metadata',
  (r) => `SELECT id FROM bookmarks WHERE ${r}.url <> '' AND instr(text, ${r}.url) > 0`,
  ['url', 'status', 'title', 'description', 'site_name'],
)}
`;

/** Drop the index and every trigger - the first half of a rebuild. */
export function dropSearchSchemaSql(triggerNames: string[]): string {
  return [
    ...triggerNames.filter((n) => n.startsWith(TRIGGER_PREFIX)).map((n) => `DROP TRIGGER IF EXISTS ${n};`),
    'DROP TABLE IF EXISTS bookmark_fts;',
  ].join('\n');
}

/** Fill an empty index with every bookmark's document - the second half of a rebuild. */
export const POPULATE_SEARCH_SQL = `INSERT INTO bookmark_fts (rowid, ${SEARCH_COLUMNS.join(', ')})
  ${documentSelectSql('1')};`;

/**
 * Words a question carries that say nothing about its topic. Dropped from a
 * query only when something else is left, so a search for "the who" still
 * searches for something.
 */
const STOPWORDS = new Set(
  (
    'a an and are as at be but by can do does for from has have how i if in into is it its me my ' +
    'of on or our so than that the their them then there these they this to was we were what when ' +
    'where which who why will with you your about any anything some something'
  ).split(' '),
);

/** The FTS5 expressions for a free-text query: every term, and any term. */
export interface MatchQuery {
  all: string;
  any: string;
}

/**
 * Turn whatever a person (or a model) typed into a safe FTS5 expression.
 *
 * Raw input is never handed to `MATCH`: FTS5 syntax gives meaning to quotes,
 * hyphens, colons (a column filter), `*`, `^` and the bare words AND/OR/NOT,
 * so "node.js: what's new?" would be a syntax error or a different query.
 * Instead the input is split into terms and each term is quoted. A "quoted
 * phrase" stays a phrase; a chunk the tokenizer would split (`node.js`,
 * `gpt-5`) becomes a phrase of its pieces, which is exactly how the indexed
 * text was tokenized, so it still matches.
 *
 * Returns null when nothing searchable is left.
 */
export function buildMatchQuery(raw: string): MatchQuery | null {
  const terms: string[] = [];
  const phrases = /"([^"]*)"|(\S+)/g;
  for (const m of raw.matchAll(phrases)) {
    const pieces = (m[1] ?? m[2] ?? '').toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (pieces.length === 0) continue;
    // Stop words are dropped from free words, never from inside a phrase.
    if (m[2] !== undefined && pieces.length === 1 && STOPWORDS.has(pieces[0]!)) {
      terms.push(`\u0000${pieces[0]}`);
      continue;
    }
    terms.push(pieces.join(' '));
  }
  const meaningful = terms.filter((t) => !t.startsWith('\u0000'));
  const chosen = (meaningful.length > 0 ? meaningful : terms.map((t) => t.replace('\u0000', ''))).map(
    (t) => `"${t}"`,
  );
  const unique = [...new Set(chosen)];
  if (unique.length === 0) return null;
  return { all: unique.join(' '), any: unique.join(' OR ') };
}
