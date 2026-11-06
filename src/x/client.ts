import type { TwitterApiReadWrite } from 'twitter-api-v2';
import type { RawBookmark } from '../types';
import {
  EXPANSIONS,
  EXPANSIONS_WITHOUT_QUOTED_MEDIA,
  MEDIA_FIELDS,
  TWEET_FIELDS,
  USER_FIELDS,
  mapBookmarks,
  mapPosts,
  type FetchedPost,
  type MediaRequest,
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
  /**
   * One page of the bookmarks timeline. `maxResults` (1-100, default 100)
   * bounds how many posts X returns - and bills - for the page; the in-app
   * "refresh the 10 newest" test is the one caller that lowers it.
   */
  fetchBookmarksPage(paginationToken?: string, options?: { maxResults?: number }): Promise<BookmarkPage>;
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

/**
 * The bookmarks request's field sets, richest first (`lost` is what a step
 * down to that set gives up). Each newer addition
 * (media, then Articles) gets its own step down: if X ever answers 400 to a
 * set, the client warns once and continues on the next one rather than
 * failing the sync - so a refused expansion costs that data, never the run.
 */
const FIELD_TIERS: { lost: string; media: MediaRequest; params: Record<string, string> }[] = [
  {
    lost: '',
    media: { own: true, quoted: true },
    params: { 'tweet.fields': TWEET_FIELDS, expansions: EXPANSIONS, 'media.fields': MEDIA_FIELDS, 'user.fields': USER_FIELDS },
  },
  {
    lost: "the quoted posts' images",
    media: { own: true, quoted: false },
    params: {
      'tweet.fields': TWEET_FIELDS,
      expansions: EXPANSIONS_WITHOUT_QUOTED_MEDIA,
      'media.fields': MEDIA_FIELDS,
      'user.fields': USER_FIELDS,
    },
  },
  {
    lost: 'image or X Article data',
    media: { own: false, quoted: false },
    params: { 'tweet.fields': LEGACY_TWEET_FIELDS, expansions: 'author_id', 'user.fields': USER_FIELDS },
  },
];

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

  async fetchBookmarksPage(paginationToken?: string, options: { maxResults?: number } = {}): Promise<BookmarkPage> {
    const tier = FIELD_TIERS[this.tier]!;
    const maxResults = Math.min(PAGE_SIZE, Math.max(1, Math.floor(options.maxResults ?? PAGE_SIZE)));
    const params: Record<string, string | number> = { max_results: maxResults, ...tier.params };
    if (paginationToken) params.pagination_token = paginationToken;

    type Page = { data?: RawTweet[]; meta?: { next_token?: string }; includes?: RawIncludes };
    let res: Page;
    try {
      res = (await this.client.v2.get(`users/${this.userId}/bookmarks`, params)) as Page;
    } catch (err) {
      // The media and Article fields are newer than the rest of this request.
      // If X ever rejects them as invalid parameters, keep syncing bookmarks
      // with less data rather than failing the whole run.
      if (this.tier >= FIELD_TIERS.length - 1 || !isBadRequest(err)) throw err;
      const next = FIELD_TIERS[this.tier + 1]!;
      this.logger(
        `Warning: X rejected the bookmarks request's fields (${errorMessage(err)}); continuing without ${next.lost}.`,
      );
      this.tier++;
      return this.fetchBookmarksPage(paginationToken, options);
    }

    return {
      bookmarks: mapBookmarks(res.data ?? [], res.includes, this.logger, tier.media),
      nextToken: res.meta?.next_token,
    };
  }

  /** Index into {@link FIELD_TIERS}; only ever moves down, once per refusal. */
  private tier = 0;

  async fetchPostsByIds(postIds: string[]): Promise<FetchedPost[]> {
    const out: FetchedPost[] = [];
    for (let i = 0; i < postIds.length; i += MAX_LOOKUP_IDS) {
      const ids = postIds.slice(i, i + MAX_LOOKUP_IDS);
      const res = (await this.client.v2.get('tweets', {
        ids: ids.join(','),
        ...FIELD_TIERS[0]!.params,
      })) as { data?: RawTweet[]; includes?: RawIncludes };
      out.push(...mapPosts(res.data ?? [], res.includes, this.logger, FIELD_TIERS[0]!.media));
    }
    return out;
  }
}
