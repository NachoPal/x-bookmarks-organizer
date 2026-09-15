import type { TwitterApiReadWrite } from 'twitter-api-v2';
import type { RawBookmark } from '../types';

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

interface RawTweet {
  id: string;
  text?: string;
  created_at?: string;
  author_id?: string;
}
interface RawUser {
  id: string;
  username?: string;
  name?: string;
}

const PAGE_SIZE = 100;

/**
 * Real X API client. Wraps an authenticated `twitter-api-v2` v2 client and the
 * caller's own user id, and reads the bookmarks timeline page by page.
 */
export class TwitterApiXClient implements XClient {
  constructor(
    private readonly client: TwitterApiReadWrite,
    private readonly userId: string,
  ) {}

  async fetchBookmarksPage(paginationToken?: string): Promise<BookmarkPage> {
    const params: Record<string, string | number> = {
      max_results: PAGE_SIZE,
      'tweet.fields': 'created_at,author_id,text',
      expansions: 'author_id',
      'user.fields': 'username,name',
    };
    if (paginationToken) params.pagination_token = paginationToken;

    const res = (await this.client.v2.get(`users/${this.userId}/bookmarks`, params)) as {
      data?: RawTweet[];
      meta?: { next_token?: string };
      includes?: { users?: RawUser[] };
    };

    const users = new Map<string, RawUser>();
    for (const u of res.includes?.users ?? []) users.set(u.id, u);

    const bookmarks: RawBookmark[] = (res.data ?? []).map((tweet) => {
      const author = tweet.author_id ? users.get(tweet.author_id) : undefined;
      const username = author?.username ?? 'i';
      return {
        postId: tweet.id,
        authorUsername: username,
        authorName: author?.name ?? '',
        text: tweet.text ?? '',
        url: `https://x.com/${username}/status/${tweet.id}`,
        postCreatedAt: tweet.created_at ?? '',
      };
    });

    return { bookmarks, nextToken: res.meta?.next_token };
  }
}
