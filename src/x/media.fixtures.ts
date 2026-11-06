/**
 * X API v2 bookmarks responses shaped like the documented payload
 * (https://docs.x.com/x-api/users/get-bookmarks and
 * https://docs.x.com/x-api/fundamentals/data-dictionary): `data[]` posts with
 * `attachments.media_keys`, and `includes.media[]` / `includes.tweets[]` /
 * `includes.users[]` filled by the media and `referenced_tweets.id` expansions.
 * Shared by the media, refresh and end-to-end tests - all offline.
 */
import type { RawIncludes, RawTweet } from './article';

export interface FixturePage {
  data: RawTweet[];
  includes: RawIncludes;
  meta?: { next_token?: string; result_count?: number };
}

/** Image URLs point at `base` (a local stub server in the end-to-end test; X's CDN otherwise). */
export function mediaFixturePage(base = 'https://pbs.twimg.com/media'): FixturePage {
  return {
    data: [
      {
        // A post with two photos, one with alt text.
        id: '1900000000000000001',
        text: 'Two charts from the paper https://t.co/abc',
        created_at: '2026-10-01T10:00:00.000Z',
        author_id: '11',
        attachments: { media_keys: ['3_101', '3_102'] },
      },
      {
        // A quote of a post whose screenshot carries the content.
        id: '1900000000000000002',
        text: 'This is the important bit',
        created_at: '2026-10-02T10:00:00.000Z',
        author_id: '11',
        referenced_tweets: [{ type: 'quoted', id: '1800000000000000009' }],
      },
      {
        // A media key X lists but did not return in includes - skipped, never a crash.
        id: '1900000000000000003',
        text: 'A video and a missing photo',
        created_at: '2026-10-03T10:00:00.000Z',
        author_id: '12',
        attachments: { media_keys: ['13_201', '3_999'] },
      },
      {
        // No media at all.
        id: '1900000000000000004',
        text: 'Just words',
        created_at: '2026-10-04T10:00:00.000Z',
        author_id: '12',
      },
    ],
    includes: {
      users: [
        { id: '11', username: 'alice', name: 'Alice' },
        { id: '12', username: 'bob', name: 'Bob' },
        { id: '13', username: 'carol', name: 'Carol' },
      ],
      media: [
        {
          media_key: '3_101',
          type: 'photo',
          url: `${base}/photo-101.png`,
          width: 900,
          height: 260,
          alt_text: 'Bar chart of quarterly retention',
        },
        { media_key: '3_102', type: 'photo', url: `${base}/photo-102.png`, width: 900, height: 260 },
        { media_key: '3_301', type: 'photo', url: `${base}/photo-301.png`, width: 900, height: 260 },
        {
          media_key: '13_201',
          type: 'video',
          preview_image_url: `${base}/video-201-preview.jpg`,
          width: 1280,
          height: 720,
        },
      ],
      tweets: [
        {
          id: '1800000000000000009',
          text: 'Screenshot of the memo',
          created_at: '2026-09-30T10:00:00.000Z',
          author_id: '13',
          attachments: { media_keys: ['3_301'] },
        },
      ],
    },
    meta: { result_count: 4 },
  };
}
