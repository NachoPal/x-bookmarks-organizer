import type { Database } from '../db/database';
import { extractArticleLink } from '../articles/extract-link';
import { htmlToPlainText } from '../summarize/summarizer';
import type { StoredBookmark } from '../types';

/** The bookmarked post's own content - always present. */
export interface BookmarkContentPost {
  kind: 'post';
  authorUsername: string;
  authorName: string;
  text: string;
}

/** The content of an ordinary post this bookmark quotes (not an X Article - see {@link BookmarkContentXArticle}). */
export interface BookmarkContentQuotedPost {
  kind: 'quoted-post';
  authorUsername: string;
  authorName: string;
  text: string;
}

/**
 * The external article a post links to. `body` is included only when the
 * reader-view extraction is already cached (`articles` table) - it is fetched
 * lazily by Summarize/the reader/`refetch-articles`, never by this read.
 * `title`/`description` come from the ingest-time link-metadata cache when
 * present.
 */
export interface BookmarkContentLinkedArticle {
  kind: 'external-article';
  url: string;
  title: string | null;
  description: string | null;
  body: string | null;
}

/** An X-native long-form Article (`x.com/i/article/<id>`), hosted or quoted by this bookmark. */
export interface BookmarkContentXArticle {
  kind: 'x-article';
  title: string | null;
  previewText: string | null;
  body: string | null;
  /** True when this bookmark quotes the Article rather than hosting it. */
  quoted: boolean;
}

/**
 * A bookmark's full content, assembled into clearly named, self-describing
 * parts for a downstream consumer (e.g. a content-scoring/ranking tool) that
 * must never have to guess what a piece of text represents. Every part but
 * `post` is nullable and independently absent - a bookmark with no quote, no
 * link, and no X Article has all three null. A pure DB read: no network call
 * is made to build this.
 */
export interface BookmarkContent {
  bookmarkId: number;
  postId: string;
  post: BookmarkContentPost;
  quotedPost: BookmarkContentQuotedPost | null;
  linkedArticle: BookmarkContentLinkedArticle | null;
  xArticle: BookmarkContentXArticle | null;
}

function buildLinkedArticle(db: Database, bookmark: StoredBookmark): BookmarkContentLinkedArticle | null {
  const url = extractArticleLink(bookmark.text);
  if (!url) return null;

  const metadata = db.getArticleLinkMetadata(url);
  // A link known to be unreadable/non-article (e.g. it resolves back to X) has
  // nothing usable to offer as content.
  if (metadata?.status === 'failed') return null;

  const cachedArticle = db.getArticleForBookmark(bookmark.id);
  const body =
    cachedArticle && cachedArticle.url === url && cachedArticle.status === 'ok'
      ? htmlToPlainText(cachedArticle.contentHtml ?? '')
      : null;

  return {
    kind: 'external-article',
    url: metadata?.resolvedUrl ?? url,
    title: metadata?.title ?? cachedArticle?.title ?? null,
    description: metadata?.description ?? null,
    body,
  };
}

/**
 * Assemble the labeled {@link BookmarkContent} for one or more stored
 * bookmarks. Batches the `x_articles`/`quoted_posts` lookups so a bulk read
 * (the paged content endpoint) stays a handful of queries regardless of page
 * size.
 */
export function buildBookmarkContents(db: Database, bookmarks: StoredBookmark[]): BookmarkContent[] {
  const xArticles = db.getXArticlesForBookmarks(bookmarks);
  const quotedPostIds = bookmarks
    .filter((b) => b.quotedPostId && !xArticles.get(b.postId))
    .map((b) => b.quotedPostId!);
  const quotedPosts = db.getQuotedPosts(quotedPostIds);

  return bookmarks.map((bookmark) => {
    const xArticleEntry = xArticles.get(bookmark.postId);
    const xArticle: BookmarkContentXArticle | null = xArticleEntry
      ? {
          kind: 'x-article',
          title: xArticleEntry.article.title,
          previewText: xArticleEntry.article.previewText,
          body: xArticleEntry.article.plainText,
          quoted: xArticleEntry.quoted,
        }
      : null;

    const quotedPostRow = !xArticle && bookmark.quotedPostId ? quotedPosts.get(bookmark.quotedPostId) : undefined;
    const quotedPost: BookmarkContentQuotedPost | null = quotedPostRow
      ? { kind: 'quoted-post', authorUsername: quotedPostRow.authorUsername, authorName: quotedPostRow.authorName, text: quotedPostRow.text }
      : null;

    return {
      bookmarkId: bookmark.id,
      postId: bookmark.postId,
      post: { kind: 'post', authorUsername: bookmark.authorUsername, authorName: bookmark.authorName, text: bookmark.text },
      quotedPost,
      linkedArticle: buildLinkedArticle(db, bookmark),
      xArticle,
    };
  });
}

/** Assemble the {@link BookmarkContent} for a single bookmark. */
export function buildBookmarkContent(db: Database, bookmark: StoredBookmark): BookmarkContent {
  return buildBookmarkContents(db, [bookmark])[0]!;
}
