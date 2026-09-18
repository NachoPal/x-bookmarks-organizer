import type { QuotedPost, RawBookmark, XArticle } from '../types';

/**
 * Tolerant mapping of the X API v2 `article` field (X-native long-form
 * Articles, `x.com/i/article/<id>`) onto {@link XArticle}.
 *
 * The v2 spec types `article` as a bare object, so its sub-field names are not
 * contractually documented. The names read here come from X's own embed data
 * feed for real Article posts (`rest_id`, `title`, `preview_text`,
 * `cover_media.media_info.original_img_url`) plus the names X documents for the
 * body (`plain_text`), with a few plausible alternates. Anything missing just
 * degrades to null - a shape mismatch must never crash ingest or drop the
 * bookmark. The first `article` object seen is logged once (strings truncated)
 * so a real run reveals the actual shape if these guesses are off.
 */

/** A v2 `includes.media[]` entry, as requested with `media.fields=url,width,height`. */
export interface RawMedia {
  media_key?: string;
  type?: string;
  url?: string;
  preview_image_url?: string;
  width?: number;
  height?: number;
}

/** A v2 Post, with the fields the bookmarks and post-lookup calls request. */
export interface RawTweet {
  id: string;
  text?: string;
  created_at?: string;
  author_id?: string;
  article?: unknown;
  entities?: { urls?: { url?: string; expanded_url?: string; unwound_url?: string }[] };
  referenced_tweets?: { type?: string; id?: string }[];
}

export interface RawUser {
  id: string;
  username?: string;
  name?: string;
}

/** The `includes` block of a v2 Post response. */
export interface RawIncludes {
  users?: RawUser[];
  media?: RawMedia[];
  tweets?: RawTweet[];
}

/** `tweet.fields` requested on every Post read that may carry an Article. */
export const TWEET_FIELDS = 'created_at,author_id,text,article,entities,referenced_tweets';
/** Expansions that bring back the Article cover image and any quoted post. */
export const EXPANSIONS = 'author_id,article.cover_media,referenced_tweets.id';
export const MEDIA_FIELDS = 'url,width,height,preview_image_url';
export const USER_FIELDS = 'username,name';

const ARTICLE_LINK = /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/i\/article\/(\d+)/i;

/** The Article id in an `x.com/i/article/<id>` URL, or null for any other URL. */
export function articleIdFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  return ARTICLE_LINK.exec(url.trim())?.[1] ?? null;
}

/** Whether a URL is an X-native Article link (`x.com/i/article/<id>`). */
export function isXArticleUrl(url: string | null | undefined): boolean {
  return articleIdFromUrl(url) !== null;
}

/** The canonical link to an Article by its id. */
export function xArticleUrl(restId: string): string {
  return `https://x.com/i/article/${restId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** First non-empty trimmed string among `keys` of `obj`. */
function pickString(obj: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function pickNumber(obj: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  }
  return null;
}

/** Only an absolute http(s) URL may reach the viewer as an `<img src>`. */
function safeImageUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

interface Cover {
  url: string | null;
  width: number | null;
  height: number | null;
}

const NO_COVER: Cover = { url: null, width: null, height: null };

function coverFromMedia(media: RawMedia | undefined): Cover {
  if (!media) return NO_COVER;
  return {
    url: safeImageUrl(media.url ?? media.preview_image_url ?? null),
    width: typeof media.width === 'number' ? media.width : null,
    height: typeof media.height === 'number' ? media.height : null,
  };
}

/**
 * The cover image, from whichever shape `cover_media` takes: a media key (or
 * `{ media_key }`) into the `article.cover_media` expansion's `includes.media`,
 * or an inline object like the embed feed's `media_info.original_img_url`.
 */
function resolveCover(article: Record<string, unknown>, mediaByKey: Map<string, RawMedia>): Cover {
  const raw = article.cover_media ?? article.cover_media_key ?? article.cover;
  if (typeof raw === 'string') return coverFromMedia(mediaByKey.get(raw));
  if (!isRecord(raw)) return NO_COVER;

  const key = pickString(raw, 'media_key', 'media_id', 'id');
  const fromIncludes = key ? coverFromMedia(mediaByKey.get(key)) : NO_COVER;
  if (fromIncludes.url) return fromIncludes;

  const info = isRecord(raw.media_info) ? raw.media_info : raw;
  const url = safeImageUrl(pickString(info, 'original_img_url', 'url', 'media_url_https', 'preview_image_url'));
  if (!url) return NO_COVER;
  return {
    url,
    width: pickNumber(info, 'original_img_width', 'width'),
    height: pickNumber(info, 'original_img_height', 'height'),
  };
}

/**
 * Build a quoted post's own content from its `includes.tweets[]` entry - the
 * bookmarks/lookup requests already expand `referenced_tweets.id`, so this is
 * a pure read of data already returned, never a second fetch.
 */
function quotedPostFrom(tweet: RawTweet, users: Map<string, RawUser>): QuotedPost {
  const author = tweet.author_id ? users.get(tweet.author_id) : undefined;
  return {
    postId: tweet.id,
    authorUsername: author?.username ?? '',
    authorName: author?.name ?? '',
    text: tweet.text ?? '',
    createdAt: tweet.created_at ?? '',
  };
}

/** The Article id from any expanded link in the post's entities. */
function articleIdFromEntities(tweet: RawTweet): string | null {
  for (const u of tweet.entities?.urls ?? []) {
    const id = articleIdFromUrl(u.expanded_url) ?? articleIdFromUrl(u.unwound_url);
    if (id) return id;
  }
  return null;
}

/**
 * Map a post's raw `article` field to an {@link XArticle}, or null when the
 * post carries no article, or one with none of title/preview/body (an
 * unrecognized shape - see {@link hasUnrecognizedArticle}).
 */
export function parseXArticle(tweet: RawTweet, mediaByKey: Map<string, RawMedia>): XArticle | null {
  const raw = tweet.article;
  if (!isRecord(raw)) return null;

  const title = pickString(raw, 'title', 'article_title');
  const previewText = pickString(raw, 'preview_text', 'previewText', 'description', 'summary');
  const bodyObj = isRecord(raw.content) ? raw.content : {};
  const plainText = pickString(raw, 'plain_text', 'plainText', 'text') ?? pickString(bodyObj, 'plain_text', 'text');
  if (!title && !previewText && !plainText) return null;

  const cover = resolveCover(raw, mediaByKey);
  return {
    restId: pickString(raw, 'rest_id', 'id', 'article_id') ?? articleIdFromEntities(tweet),
    title,
    previewText,
    plainText,
    coverUrl: cover.url,
    coverWidth: cover.width,
    coverHeight: cover.height,
  };
}

/**
 * True when the post HAS an `article` object that {@link parseXArticle} could
 * not read. That is the signal the sub-field guesses are wrong, so callers
 * warn about it instead of silently treating the post as a non-article.
 */
export function hasUnrecognizedArticle(tweet: RawTweet, mediaByKey: Map<string, RawMedia>): boolean {
  return isRecord(tweet.article) && parseXArticle(tweet, mediaByKey) === null;
}

const MAX_LOGGED_STRING = 80;

/** A copy of `value` with long strings truncated, for a readable shape log. */
function truncateForLog(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_LOGGED_STRING ? `${value.slice(0, MAX_LOGGED_STRING)}... (${value.length} chars)` : value;
  }
  if (depth > 4) return '...';
  if (Array.isArray(value)) return value.slice(0, 3).map((v) => truncateForLog(v, depth + 1));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, truncateForLog(v, depth + 1)]));
  }
  return value;
}

let loggedArticleShape = false;

/**
 * Log the first raw `article` object this process sees, once, so the first
 * real run reveals the exact v2 shape (the one open uncertainty in parsing it).
 */
function logArticleShapeOnce(tweet: RawTweet, logger: (message: string) => void): void {
  if (loggedArticleShape || tweet.article === undefined) return;
  loggedArticleShape = true;
  logger(`X API article field shape (post ${tweet.id}): ${JSON.stringify(truncateForLog(tweet.article))}`);
}

/** Test hook: let the one-time shape log fire again. */
export function resetArticleShapeLog(): void {
  loggedArticleShape = false;
}

/** A post read by id, with its (possibly quoted) Article data mapped. */
export interface FetchedPost {
  postId: string;
  xArticle: XArticle | null;
  /** The post has an `article` object whose shape could not be read. */
  articleUnrecognized: boolean;
  quotedPostId: string | null;
  quotedXArticle: XArticle | null;
  quotedArticleUnrecognized: boolean;
  /** The quoted post's own content, when it is an ordinary post (not an Article). */
  quotedPost: QuotedPost | null;
}

/**
 * Map a v2 Post response (`data` + `includes`) to per-post Article data -
 * shared by the bookmarks timeline and the by-id lookup so both read the
 * `article` field identically.
 */
export function mapPosts(
  tweets: RawTweet[],
  includes: RawIncludes | undefined,
  logger: (message: string) => void,
): FetchedPost[] {
  const mediaByKey = new Map<string, RawMedia>();
  for (const m of includes?.media ?? []) if (m.media_key) mediaByKey.set(m.media_key, m);
  const includedTweets = new Map<string, RawTweet>();
  for (const t of includes?.tweets ?? []) includedTweets.set(t.id, t);
  const users = new Map<string, RawUser>();
  for (const u of includes?.users ?? []) users.set(u.id, u);

  return tweets.map((tweet) => {
    logArticleShapeOnce(tweet, logger);
    const quotedPostId = tweet.referenced_tweets?.find((r) => r.type === 'quoted')?.id ?? null;
    const quoted = quotedPostId ? includedTweets.get(quotedPostId) : undefined;
    if (quoted) logArticleShapeOnce(quoted, logger);
    const quotedXArticle = quoted ? parseXArticle(quoted, mediaByKey) : null;

    const post: FetchedPost = {
      postId: tweet.id,
      xArticle: parseXArticle(tweet, mediaByKey),
      articleUnrecognized: hasUnrecognizedArticle(tweet, mediaByKey),
      quotedPostId,
      quotedXArticle,
      quotedArticleUnrecognized: quoted ? hasUnrecognizedArticle(quoted, mediaByKey) : false,
      quotedPost: quoted && !quotedXArticle ? quotedPostFrom(quoted, users) : null,
    };
    if (post.articleUnrecognized) {
      logger(`Warning: post ${tweet.id} has an X Article, but its fields were not recognized; see the shape logged above.`);
    }
    if (post.quotedArticleUnrecognized) {
      logger(`Warning: quoted post ${quotedPostId} has an X Article, but its fields were not recognized.`);
    }
    return post;
  });
}

/** Map a v2 bookmarks-timeline response to {@link RawBookmark}s, Article data included. */
export function mapBookmarks(
  tweets: RawTweet[],
  includes: RawIncludes | undefined,
  logger: (message: string) => void,
): RawBookmark[] {
  const users = new Map<string, RawUser>();
  for (const u of includes?.users ?? []) users.set(u.id, u);
  const posts = mapPosts(tweets, includes, logger);

  return tweets.map((tweet, i) => {
    const post = posts[i]!;
    const author = tweet.author_id ? users.get(tweet.author_id) : undefined;
    const username = author?.username ?? 'i';
    return {
      postId: tweet.id,
      authorUsername: username,
      authorName: author?.name ?? '',
      text: tweet.text ?? '',
      url: `https://x.com/${username}/status/${tweet.id}`,
      postCreatedAt: tweet.created_at ?? '',
      xArticle: post.xArticle,
      quotedPostId: post.quotedPostId,
      quotedXArticle: post.quotedXArticle,
      quotedPost: post.quotedPost,
    };
  });
}
