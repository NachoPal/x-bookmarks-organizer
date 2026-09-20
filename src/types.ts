/** Shared domain types. */

/** A bookmark as fetched from the X API, before it is stored. */
export interface RawBookmark {
  /** X post (tweet) id. Stable, globally unique. */
  postId: string;
  authorUsername: string;
  authorName: string;
  text: string;
  /** Canonical URL to the post. */
  url: string;
  /** ISO-8601 timestamp of when the post was created (NOT when bookmarked). */
  postCreatedAt: string;
  /**
   * The X-native Article (`x.com/i/article/<id>`) this post hosts, when the
   * bookmarked post IS an Article's host post. Arrives with the bookmark from
   * the X API's `article` field - no separate fetch. Absent on posts fetched
   * before the field was requested; `backfill-x-articles` fills those in.
   */
  xArticle?: XArticle | null;
  /** The id of the post this one quotes, if it is a quote post. */
  quotedPostId?: string | null;
  /** The X Article hosted by the quoted post, when this post quotes an Article. */
  quotedXArticle?: XArticle | null;
  /**
   * The quoted post's own content (author + text + created_at), when this post
   * quotes an ordinary post. Arrives with the bookmark from the same
   * `includes.tweets[]` the `referenced_tweets.id` expansion already returns -
   * no separate fetch. Null when the quoted post hosts an X Article instead
   * (that body lives in `xArticle`/`quotedXArticle`, not here).
   */
  quotedPost?: QuotedPost | null;
}

/** The content of a post quoted by a bookmark, captured from the bookmarks API's own `includes.tweets[]`. */
export interface QuotedPost {
  postId: string;
  authorUsername: string;
  authorName: string;
  text: string;
  createdAt: string;
}

/**
 * An X-native long-form Article, as returned in a post's `article` field. Every
 * field is nullable because the official v2 sub-field names are parsed
 * tolerantly (see `src/x/article.ts`) and any one of them may be missing.
 */
export interface XArticle {
  /** The Article id - the `<id>` in `x.com/i/article/<id>` (not the host post id). */
  restId: string | null;
  title: string | null;
  previewText: string | null;
  /** The Article's full body as plain text (X exposes no rich structure). */
  plainText: string | null;
  /** Absolute http(s) URL of the cover image. */
  coverUrl: string | null;
  coverWidth: number | null;
  coverHeight: number | null;
}

/** A bookmark row as stored in the database. */
export interface StoredBookmark extends RawBookmark {
  id: number;
  ingestedAt: string;
  read: boolean;
  readAt: string | null;
  /** Starred by the owner (issue #63). Survives sync and recategorize. */
  favorite: boolean;
}

/**
 * The cached reader-view extraction for a bookmark's primary article link.
 * `status: 'ok'` carries the extracted title/content; `status: 'failed'`
 * carries a human-readable reason instead so the reader can show it directly.
 */
export interface ArticleRecord {
  bookmarkId: number;
  url: string;
  status: 'ok' | 'failed';
  title: string | null;
  contentHtml: string | null;
  excerpt: string | null;
  siteName: string | null;
  reason: string | null;
  fetchedAt: string;
}

/**
 * The cached on-demand summary for a bookmark, generated the first time the
 * owner clicks "Summarize" and served from cache on every later open.
 */
export interface SummaryRecord {
  bookmarkId: number;
  summary: string;
  generatedAt: string;
}

/**
 * The cached title/description fetched for a link found in a bookmark's post
 * text, used as extra categorization signal (issue #25) AND as the viewer's
 * link-preview card data (issue #26) - `image`/`siteName` were added for the
 * latter. Keyed by URL - see `article_link_metadata` in `src/db/schema.ts`
 * for why.
 */
export interface ArticleLinkMetadata {
  url: string;
  /**
   * Three distinct outcomes, because a preview card and a readable article are
   * separate capabilities (most links have the former, not the latter):
   * - `ok`   - readable article: has a card AND a body the reader view can show.
   * - `card` - preview card only (a tool, product page, video, repo...): the
   *            card renders, but there is no body, so no "Read article".
   * - `failed` - nothing usable (dead link, non-HTML, or a link back to X).
   */
  status: 'ok' | 'card' | 'failed';
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
  /**
   * Where `url` actually landed once HTTP redirects and shortener
   * interstitials were followed. Every link in a post is `t.co`-shortened, so
   * this - not `url` - is the card's real domain and "open the original"
   * target. Null for a row cached before this was recorded.
   */
  resolvedUrl: string | null;
  fetchedAt: string;
}

/** A category tree node as stored. */
export interface CategoryNode {
  id: number;
  parentId: number | null;
  name: string;
  createdAt: string;
}

/**
 * A category tree node enriched with counts, used by the web viewer.
 * Counts are rolled up to include all descendants.
 */
export interface CategoryTreeNode {
  id: number;
  parentId: number | null;
  name: string;
  /** Full path from the root, e.g. ["AI", "Harnesses"]. */
  path: string[];
  /** Bookmarks in this node and all descendants. */
  total: number;
  /** Unread bookmarks in this node and all descendants. */
  unread: number;
  /** Bookmarks attached directly to this node (not descendants). */
  directTotal: number;
  children: CategoryTreeNode[];
}

/** The LLM's categorization decision for a single bookmark. */
export interface Assignment {
  postId: string;
  /** One path per category the bookmark belongs to. Each path is root -> leaf. */
  categories: string[][];
}

/**
 * A node in a taxonomy designed by the holistic taxonomy-design pass. This is a
 * pure shape (name + children) with no counts or ids; it is materialized into
 * `categories` rows before the assignment pass files bookmarks into it.
 */
export interface TaxonomyNode {
  name: string;
  children: TaxonomyNode[];
}
