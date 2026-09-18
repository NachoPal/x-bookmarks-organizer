import { beforeEach, describe, expect, it } from 'vitest';
import type { TwitterApiReadWrite } from 'twitter-api-v2';
import {
  articleIdFromUrl,
  isXArticleUrl,
  mapBookmarks,
  mapPosts,
  resetArticleShapeLog,
  type RawIncludes,
  type RawTweet,
} from './article';
import { TwitterApiXClient } from './client';

/**
 * The Article shape as X's own embed data feed returns it for a real bookmark
 * (see the scout report): the sub-field names the parser must read.
 */
const SYNDICATION_ARTICLE = {
  rest_id: '2094692428037177344',
  title: 'start ugly, write evals anyway.',
  preview_text: 'TLDR; understanding the importance of evals ...',
  plain_text: 'Full body of the article.',
  cover_media: {
    media_info: {
      original_img_url: 'https://pbs.twimg.com/media/HSM5CPgaEAEgEoJ.jpg',
      original_img_width: 3000,
      original_img_height: 1200,
    },
  },
};

const users: RawIncludes['users'] = [{ id: 'u1', username: 'Hrushikeshhhh', name: 'Hrushikesh' }];

describe('X Article mapping', () => {
  let logs: string[];
  const logger = (m: string) => logs.push(m);
  beforeEach(() => {
    logs = [];
    resetArticleShapeLog();
  });

  it('maps a direct Article post (syndication-verified shape) to xArticle', () => {
    const tweets: RawTweet[] = [
      { id: '2099590015336808865', author_id: 'u1', text: 'https://t.co/QTjYgBHz1x', article: SYNDICATION_ARTICLE },
    ];
    const [bm] = mapBookmarks(tweets, { users }, logger);
    expect(bm).toMatchObject({
      postId: '2099590015336808865',
      authorUsername: 'Hrushikeshhhh',
      url: 'https://x.com/Hrushikeshhhh/status/2099590015336808865',
      quotedPostId: null,
      quotedXArticle: null,
    });
    expect(bm!.xArticle).toEqual({
      restId: '2094692428037177344',
      title: 'start ugly, write evals anyway.',
      previewText: 'TLDR; understanding the importance of evals ...',
      plainText: 'Full body of the article.',
      coverUrl: 'https://pbs.twimg.com/media/HSM5CPgaEAEgEoJ.jpg',
      coverWidth: 3000,
      coverHeight: 1200,
    });
  });

  it('resolves a media-key cover through the article.cover_media expansion and the rest id from entities', () => {
    const tweets: RawTweet[] = [
      {
        id: '10',
        text: 'https://t.co/x',
        article: { title: 'T', preview_text: 'P', cover_media: '3_555' },
        entities: { urls: [{ url: 'https://t.co/x', expanded_url: 'https://x.com/i/article/777' }] },
      },
    ];
    const includes: RawIncludes = {
      media: [{ media_key: '3_555', type: 'photo', url: 'https://pbs.twimg.com/media/c.jpg', width: 1500, height: 600 }],
    };
    const [post] = mapPosts(tweets, includes, logger);
    expect(post!.xArticle).toMatchObject({
      restId: '777',
      coverUrl: 'https://pbs.twimg.com/media/c.jpg',
      coverWidth: 1500,
      coverHeight: 600,
    });
  });

  it('maps a quoted Article post to quotedXArticle via referenced_tweets + includes.tweets', () => {
    const tweets: RawTweet[] = [
      {
        id: '20',
        author_id: 'u1',
        text: 'Great read https://t.co/q',
        referenced_tweets: [{ type: 'quoted', id: '21' }],
      },
    ];
    const includes: RawIncludes = { users, tweets: [{ id: '21', text: 'https://t.co/a', article: SYNDICATION_ARTICLE }] };
    const [bm] = mapBookmarks(tweets, includes, logger);
    expect(bm!.xArticle).toBeNull();
    expect(bm!.quotedPostId).toBe('21');
    expect(bm!.quotedXArticle?.title).toBe('start ugly, write evals anyway.');
  });

  it('keeps an ordinary post (no article) intact with null Article data', () => {
    const [bm] = mapBookmarks([{ id: '30', author_id: 'u1', text: 'hello' }], { users }, logger);
    expect(bm).toMatchObject({ postId: '30', text: 'hello', xArticle: null, quotedXArticle: null });
    expect(logs).toEqual([]);
  });

  it('never crashes on an unrecognized article shape: the bookmark survives, and it warns', () => {
    const tweets: RawTweet[] = [{ id: '40', author_id: 'u1', text: 'x', article: { weird_field: 1 } }];
    const [post] = mapPosts(tweets, { users }, logger);
    expect(post).toMatchObject({ postId: '40', xArticle: null, articleUnrecognized: true });
    expect(logs.some((l) => l.includes('not recognized'))).toBe(true);
    const [bm] = mapBookmarks(tweets, { users }, logger);
    expect(bm!.postId).toBe('40');
  });

  it('drops a non-http(s) cover url rather than handing it to the viewer', () => {
    const [post] = mapPosts(
      [{ id: '50', article: { title: 'T', cover_media: { media_info: { original_img_url: 'javascript:alert(1)' } } } }],
      undefined,
      logger,
    );
    expect(post!.xArticle?.coverUrl).toBeNull();
  });

  it('logs the raw article shape exactly once, with long strings truncated', () => {
    const long = { ...SYNDICATION_ARTICLE, plain_text: 'y'.repeat(500) };
    mapPosts([{ id: '1', article: long }, { id: '2', article: long }], undefined, logger);
    mapPosts([{ id: '3', article: long }], undefined, logger);
    const shapeLogs = logs.filter((l) => l.startsWith('X API article field shape'));
    expect(shapeLogs).toHaveLength(1);
    expect(shapeLogs[0]).toContain('"rest_id":"2094692428037177344"');
    expect(shapeLogs[0]).toContain('(500 chars)');
  });

  it('recognizes x.com/i/article links', () => {
    expect(articleIdFromUrl('https://x.com/i/article/2094692428037177344')).toBe('2094692428037177344');
    expect(isXArticleUrl('https://twitter.com/i/article/1')).toBe(true);
    expect(isXArticleUrl('https://x.com/a/status/1')).toBe(false);
    expect(isXArticleUrl(null)).toBe(false);
  });
});

describe('TwitterApiXClient', () => {
  function fakeClient(get: (path: string, params: Record<string, unknown>) => Promise<unknown>) {
    return { v2: { get } } as unknown as TwitterApiReadWrite;
  }

  it('requests the Article fields and expansions on the bookmarks call', async () => {
    const calls: Record<string, unknown>[] = [];
    const client = new TwitterApiXClient(
      fakeClient(async (_path, params) => {
        calls.push(params);
        return { data: [{ id: '1', text: 't', article: SYNDICATION_ARTICLE }] };
      }),
      'me',
      () => {},
    );
    const page = await client.fetchBookmarksPage();
    expect(calls[0]!['tweet.fields']).toContain('article');
    expect(calls[0]!['tweet.fields']).toContain('referenced_tweets');
    expect(calls[0]!.expansions).toContain('article.cover_media');
    expect(calls[0]!.expansions).toContain('referenced_tweets.id');
    expect(calls[0]!['media.fields']).toContain('url');
    expect(page.bookmarks[0]!.xArticle?.title).toBe('start ugly, write evals anyway.');
  });

  it('keeps syncing without Article data if X rejects the new fields (400)', async () => {
    const calls: Record<string, unknown>[] = [];
    const logs: string[] = [];
    const client = new TwitterApiXClient(
      fakeClient(async (_path, params) => {
        calls.push(params);
        if (String(params['tweet.fields']).includes('article')) {
          throw Object.assign(new Error('Invalid parameter'), { code: 400 });
        }
        return { data: [{ id: '1', text: 't' }] };
      }),
      'me',
      (m) => logs.push(m),
    );
    const page = await client.fetchBookmarksPage();
    expect(page.bookmarks.map((b) => b.postId)).toEqual(['1']);
    expect(calls).toHaveLength(2);
    expect(logs.join('\n')).toMatch(/rejected the Article fields/);
    await client.fetchBookmarksPage('next');
    expect(calls).toHaveLength(3); // later pages go straight to the legacy fields
  });

  it('batches post lookups by id at 100 per request', async () => {
    const paths: string[] = [];
    const idsPerCall: number[] = [];
    const client = new TwitterApiXClient(
      fakeClient(async (path, params) => {
        paths.push(path);
        const ids = String(params.ids).split(',');
        idsPerCall.push(ids.length);
        return { data: ids.map((id) => ({ id, article: { title: `A${id}` } })) };
      }),
      'me',
      () => {},
    );
    const ids = Array.from({ length: 150 }, (_, i) => String(i + 1));
    const posts = await client.fetchPostsByIds(ids);
    expect(paths).toEqual(['tweets', 'tweets']);
    expect(idsPerCall).toEqual([100, 50]);
    expect(posts).toHaveLength(150);
    expect(posts[149]!.xArticle?.title).toBe('A150');
  });
});
