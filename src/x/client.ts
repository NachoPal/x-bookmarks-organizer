import type { TwitterApiReadWrite } from 'twitter-api-v2';
import type { RawBookmark } from '../types';
import {
  EXPANSIONS,
  MEDIA_FIELDS,
  TWEET_FIELDS,
  USER_FIELDS,
  mapBookmarks,
  mapPosts,
  type FetchedPost,
  type RawIncludes,
  type RawTweet,
} from './article';

/** One page of bookmarks in reverse-chronological-by-bookmark-time order. */
export interface BookmarkPage {
  bookmarks: RawBookmark[];
  /** Pagination token for the next (older) page, if any. */
  nextToken?: string;
}

/**
 * Minimal surface the ingestion loop needs from X. Kept tiny and free of the
 * concrete SDK so tests can inject a fake paginating client with no network.
 */
export interface XClient {
  fetchBookmarksPage(paginationToken?: string): Promise<BookmarkPage>;
}

/**
 * Read specific posts by id - used only by `backfill-x-articles` to fetch the
 * Article data for bookmarks stored before it was requested. A separate
 * interface so ingest's fakes need not implement it. Every call is a PAID X
 * read, so callers batch ids and only ask for what is missing.
 */
export interface XPostLookupClient {
  fetchPostsByIds(postIds: string[]): Promise<FetchedPost[]>;
}

const PAGE_SIZE = 100;
/** The field set requested before X Articles were supported. */
const LEGACY_TWEET_FIELDS = 'created_at,author_id,text';

function isBadRequest(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 400;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
/** `GET /2/tweets?ids=` accepts at most 100 ids per request. */
export const MAX_LOOKUP_IDS = 100;

/**
 * Real X API client. Wraps an authenticated `twitter-api-v2` v2 client and the
 * caller's own user id, and reads the bookmarks timeline page by page.
 */
export class TwitterApiXClient implements XClient, XPostLookupClient {
  constructor(
    private readonly client: TwitterApiReadWrite,
    private readonly userId: string,
    private readonly logger: (message: string) => void = (msg) => console.log(msg),
  ) {}

  async fetchBookmarksPage(paginationToken?: string): Promise<BookmarkPage> {
    const params: Record<string, string | number> = { max_results: PAGE_SIZE, ...this.fieldParams() };
    if (paginationToken) params.pagination_token = paginationToken;

    type Page = { data?: RawTweet[]; meta?: { next_token?: string }; includes?: RawIncludes };
    let res: Page;
    try {
      res = (await this.client.v2.get(`users/${this.userId}/bookmarks`, params)) as Page;
    } catch (err) {
      // The Article fields are newer than the rest of this request. If X ever
      // rejects them as invalid parameters, keep syncing bookmarks without
      // Article data rather than failing the whole run.
      if (this.articleFieldsRejected || !isBadRequest(err)) throw err;
      this.articleFieldsRejected = true;
      this.logger(
        `Warning: X rejected the Article fields on the bookmarks request (${errorMessage(err)}); ` +
          'continuing without X Article data.',
      );
      return this.fetchBookmarksPage(paginationToken);
    }

    return { bookmarks: mapBookmarks(res.data ?? [], res.includes, this.logger), nextToken: res.meta?.next_token };
  }

  /** Set once X rejects the Article fields; later pages use the legacy field set. */
  private articleFieldsRejected = false;

  private fieldParams(): Record<string, string> {
    if (this.articleFieldsRejected) {
      return { 'tweet.fields': LEGACY_TWEET_FIELDS, expansions: 'author_id', 'user.fields': USER_FIELDS };
    }
    return {
      'tweet.fields': TWEET_FIELDS,
      expansions: EXPANSIONS,
      'media.fields': MEDIA_FIELDS,
      'user.fields': USER_FIELDS,
    };
  }

  async fetchPostsByIds(postIds: string[]): Promise<FetchedPost[]> {
    const out: FetchedPost[] = [];
    for (let i = 0; i < postIds.length; i += MAX_LOOKUP_IDS) {
      const ids = postIds.slice(i, i + MAX_LOOKUP_IDS);
      const res = (await this.client.v2.get('tweets', {
        ids: ids.join(','),
        'tweet.fields': TWEET_FIELDS,
        expansions: EXPANSIONS,
        'media.fields': MEDIA_FIELDS,
        'user.fields': USER_FIELDS,
      })) as { data?: RawTweet[]; includes?: RawIncludes };
      out.push(...mapPosts(res.data ?? [], res.includes, this.logger));
    }
    return out;
  }
}
