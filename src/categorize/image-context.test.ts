import { describe, expect, it } from 'vitest';
import { Database } from '../db/database';
import { runIngest } from '../ingest';
import type { ArticleContext } from '../articles/link-metadata';
import type { ArticleFetcher } from '../articles/fetch-article';
import type { BatchCategorizer } from './llm';
import type { TaxonomyDesigner } from './taxonomy';
import { buildPrompt } from './prompt';
import { buildIncrementalTaxonomyPrompt, buildTaxonomyPrompt } from './taxonomy';
import { buildFindPrompt } from './find';
import { buildBookmarkState } from './typesafe/categorizer';
import { buildSummaryPrompt, hasSummarizableContent } from '../summarize/summarizer';
import type { Assignment, PostMedia, RawBookmark, TaxonomyNode } from '../types';

const photo = (mediaKey: string, altText: string | null = null): PostMedia => ({
  mediaKey,
  type: 'photo',
  url: `https://pbs.twimg.com/media/${mediaKey}.png`,
  previewImageUrl: null,
  altText,
  width: null,
  height: null,
});

const bm = (postId: string, extra: Partial<RawBookmark> = {}): RawBookmark => ({
  postId,
  authorUsername: 'a',
  authorName: 'A',
  text: 'look',
  url: `https://x.com/a/status/${postId}`,
  postCreatedAt: '',
  ...extra,
});

const noFetch: ArticleFetcher = {
  async fetch() {
    throw new Error('no network in tests');
  },
};

describe('image text in every categorization prompt', () => {
  const context = new Map<string, ArticleContext>([
    ['1', { imageText: '[image 1 in the post] text: Quarterly zephyrine report' }],
    ['2', { title: 'An article', description: 'About it', imageText: '[image 1 in the quoted post] alt: A memo' }],
  ]);
  const posts = [bm('1'), bm('2')];

  it('files with it (pass 2), alongside the linked article', () => {
    const prompt = buildPrompt(posts, 'AI', 3, context);
    expect(prompt).toContain('    text in images: [image 1 in the post] text: Quarterly zephyrine report');
    expect(prompt).toContain('    linked article: An article - About it');
    expect(prompt).toMatch(/"text in images" is what was read from the pictures/);
  });

  it('designs and grows the tree with it (pass 1)', () => {
    expect(buildTaxonomyPrompt(posts, '', 2, 4, context)).toContain('[text in images: [image 1 in the post] text: Quarterly');
    expect(buildIncrementalTaxonomyPrompt(posts, 'AI', 4, context)).toContain('[text in images: [image 1 in the quoted post]');
  });

  it('reaches Find and Jev too, bounded', () => {
    expect(buildFindPrompt(posts, { path: ['AI'], description: null, children: [] }, context)).toContain(
      'text in images: [image 1 in the post]',
    );
    const long = new Map([['1', { imageText: 'x'.repeat(5000) }]]);
    const state = buildBookmarkState(bm('1'), long) as Record<string, string>;
    expect(state.text_in_images!.length).toBeLessThanOrEqual(300);
  });

  it('makes an image-only post summarizable, with the image text in the prompt', () => {
    const input = { postText: 'https://t.co/x', authorName: 'A', authorUsername: 'a', imageText: '[image 1 in the post] text: Memo' };
    expect(hasSummarizableContent({ ...input, imageText: null })).toBe(false);
    expect(hasSummarizableContent(input)).toBe(true);
    expect(buildSummaryPrompt(input)).toContain('Text read from the images attached to the post');
    expect(buildSummaryPrompt(input)).toContain('[image 1 in the post] text: Memo');
  });
});

describe('runIngest reads new posts\' images before filing them', () => {
  it('stores the media, reads it, and both passes see the text', async () => {
    const db = new Database(':memory:');
    const order: string[] = [];
    const seen: (Map<string, ArticleContext> | undefined)[] = [];
    const taxonomer: TaxonomyDesigner = {
      async designTaxonomy(_b, _t, ctx): Promise<TaxonomyNode[]> {
        order.push('taxonomy');
        seen.push(ctx);
        return [{ name: 'Reports', children: [] }];
      },
    };
    const categorizer: BatchCategorizer = {
      async categorizeBatch(batch, _tree, ctx): Promise<Assignment[]> {
        order.push('filing');
        seen.push(ctx);
        return batch.map((b) => ({ postId: b.postId, categories: [['Reports']] }));
      },
    };
    const client = {
      async fetchBookmarksPage() {
        return {
          bookmarks: [bm('1', { media: [photo('3_1', 'A chart')], quotedPostId: 'q', quotedMedia: [photo('3_2')] })],
        };
      },
    };
    await runIngest({
      db,
      client,
      taxonomer,
      categorizer,
      batchSize: 10,
      maxDepth: 3,
      articleFetcher: noFetch,
      readImageText: async (postIds) => {
        order.push(`ocr:${[...postIds].sort().join(',')}`);
        for (const media of db.getOcrQueue({ limit: 10, postIds, includeUnavailable: false, maxAttempts: 3 })) {
          db.setMediaOcrResult(media.postId, media.mediaKey, { status: 'done', text: `words of ${media.mediaKey}` });
        }
      },
    });
    expect(order).toEqual(['ocr:1,q', 'taxonomy', 'filing']);
    for (const ctx of seen) {
      expect(ctx?.get('1')?.imageText).toBe(
        '[image 1 in the post] alt: A chart text: words of 3_1 | [image 1 in the quoted post] text: words of 3_2',
      );
    }
    // The text survives the batch store, which writes the same media again.
    expect(db.getImageStats(3)).toMatchObject({ done: 2, pending: 0 });
    db.close();
  });
});
