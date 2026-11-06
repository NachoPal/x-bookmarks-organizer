import { describe, expect, it } from 'vitest';
import type { TwitterApiReadWrite } from 'twitter-api-v2';
import { EXPANSIONS, MEDIA_FIELDS, mapBookmarks } from './article';
import { TwitterApiXClient } from './client';
import { mediaFixturePage } from './media.fixtures';

const quiet = () => {};
const BOTH = { own: true, quoted: true };

describe('mapping attached media (documented v2 payload)', () => {
  const page = mediaFixturePage();
  const bookmarks = mapBookmarks(page.data, page.includes, quiet, BOTH);
  const byId = new Map(bookmarks.map((b) => [b.postId, b]));

  it('maps a post with photos in X order, alt text included', () => {
    const bm = byId.get('1900000000000000001')!;
    expect(bm.media).toEqual([
      {
        mediaKey: '3_101',
        type: 'photo',
        url: 'https://pbs.twimg.com/media/photo-101.png',
        previewImageUrl: null,
        altText: 'Bar chart of quarterly retention',
        width: 900,
        height: 260,
      },
      expect.objectContaining({ mediaKey: '3_102', altText: null }),
    ]);
  });

  it("maps the quoted post's screenshot onto the quote", () => {
    const bm = byId.get('1900000000000000002')!;
    expect(bm.media).toEqual([]);
    expect(bm.quotedPostId).toBe('1800000000000000009');
    expect(bm.quotedMedia).toEqual([expect.objectContaining({ mediaKey: '3_301', type: 'photo' })]);
    expect(bm.quotedPost?.text).toBe('Screenshot of the memo');
  });

  it('keeps a video as its preview image and skips a key X did not return', () => {
    const bm = byId.get('1900000000000000003')!;
    expect(bm.media).toEqual([
      expect.objectContaining({
        mediaKey: '13_201',
        type: 'video',
        url: null,
        previewImageUrl: 'https://pbs.twimg.com/media/video-201-preview.jpg',
      }),
    ]);
  });

  it('reports no media as an empty list, and an unasked request as unknown', () => {
    expect(byId.get('1900000000000000004')!.media).toEqual([]);
    const unasked = mapBookmarks(page.data, page.includes, quiet);
    expect(unasked[0]!.media).toBeUndefined();
    expect(unasked[1]!.quotedMedia).toBeUndefined();
  });

  it('never stores a non-https media url', () => {
    const [bm] = mapBookmarks(
      [{ id: '9', attachments: { media_keys: ['3_1'] } }],
      { media: [{ media_key: '3_1', type: 'photo', url: 'javascript:alert(1)' }] },
      quiet,
      BOTH,
    );
    expect(bm!.media![0]!.url).toBeNull();
  });
});

describe('TwitterApiXClient media fields', () => {
  function fakeClient(get: (path: string, params: Record<string, unknown>) => Promise<unknown>) {
    return { v2: { get } } as unknown as TwitterApiReadWrite;
  }

  it('asks for post and quoted-post media with alt text on the bookmarks call', async () => {
    const calls: Record<string, unknown>[] = [];
    const client = new TwitterApiXClient(
      fakeClient(async (_path, params) => {
        calls.push(params);
        return mediaFixturePage();
      }),
      'me',
      quiet,
    );
    const page = await client.fetchBookmarksPage();
    expect(String(calls[0]!.expansions).split(',')).toEqual(
      expect.arrayContaining(['attachments.media_keys', 'referenced_tweets.id.attachments.media_keys', 'referenced_tweets.id']),
    );
    expect(String(calls[0]!['media.fields']).split(',').sort()).toEqual(
      ['alt_text', 'height', 'media_key', 'preview_image_url', 'type', 'url', 'width'],
    );
    expect(calls[0]!.expansions).toBe(EXPANSIONS);
    expect(calls[0]!['media.fields']).toBe(MEDIA_FIELDS);
    expect(page.bookmarks[1]!.quotedMedia).toHaveLength(1);
  });

  it("drops only the quoted posts' media when X refuses that expansion", async () => {
    const calls: Record<string, unknown>[] = [];
    const logs: string[] = [];
    const client = new TwitterApiXClient(
      fakeClient(async (_path, params) => {
        calls.push(params);
        if (String(params.expansions).includes('referenced_tweets.id.attachments.media_keys')) {
          throw Object.assign(new Error('Invalid expansion'), { code: 400 });
        }
        return mediaFixturePage();
      }),
      'me',
      (m) => logs.push(m),
    );
    const page = await client.fetchBookmarksPage();
    expect(calls).toHaveLength(2);
    expect(logs.join('\n')).toMatch(/continuing without the quoted posts' images/);
    expect(page.bookmarks[0]!.media).toHaveLength(2); // own media still read
    expect(page.bookmarks[1]!.quotedMedia).toBeUndefined(); // unknown, so nothing stored is erased
  });

  it('bounds a page with max_results (the 10-newest test refresh)', async () => {
    const calls: Record<string, unknown>[] = [];
    const client = new TwitterApiXClient(
      fakeClient(async (_path, params) => {
        calls.push(params);
        return { data: [] };
      }),
      'me',
      quiet,
    );
    await client.fetchBookmarksPage(undefined, { maxResults: 10 });
    await client.fetchBookmarksPage('t');
    await client.fetchBookmarksPage(undefined, { maxResults: 0 });
    expect(calls.map((c) => c.max_results)).toEqual([10, 100, 1]);
  });

  it('asks for the same media on a by-id lookup', async () => {
    const calls: Record<string, unknown>[] = [];
    const client = new TwitterApiXClient(
      fakeClient(async (_path, params) => {
        calls.push(params);
        return mediaFixturePage();
      }),
      'me',
      quiet,
    );
    const posts = await client.fetchPostsByIds(['1900000000000000001']);
    expect(calls[0]!.expansions).toBe(EXPANSIONS);
    expect(posts[0]!.media).toHaveLength(2);
  });
});
