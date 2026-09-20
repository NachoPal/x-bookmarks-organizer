import { describe, expect, it } from 'vitest';
import type { BookmarkContent } from '../content/bookmark-content';
import { buildRankState, hasRankableContent, STATE_LIMITS } from './state';

function content(overrides: Partial<BookmarkContent> = {}): BookmarkContent {
  return {
    bookmarkId: 1,
    postId: '100',
    post: { kind: 'post', authorUsername: 'alice', authorName: 'Alice', text: 'a real thought' },
    quotedPost: null,
    linkedArticle: null,
    xArticle: null,
    ...overrides,
  };
}

describe('buildRankState', () => {
  it('names each part of the content so the model never has to guess what it is reading', () => {
    const state = buildRankState(
      content({
        quotedPost: { kind: 'quoted-post', authorUsername: 'bob', authorName: 'Bob', text: 'quoted' },
        linkedArticle: {
          kind: 'external-article',
          url: 'https://example.com/a',
          title: 'Title',
          description: 'Desc',
          body: 'Body',
        },
      }),
    );

    expect(state).toEqual({
      post: { author: '@alice', text: 'a real thought' },
      quoted_post: { author: '@bob', text: 'quoted' },
      linked_article: { title: 'Title', description: 'Desc', body: 'Body' },
    });
  });

  it('omits every absent part rather than sending an empty one', () => {
    expect(Object.keys(buildRankState(content()))).toEqual(['post']);
  });

  it('carries whether an X Article is quoted or hosted', () => {
    const state = buildRankState(
      content({
        xArticle: { kind: 'x-article', title: 'T', previewText: 'P', body: 'B', quoted: true },
      }),
    );
    expect(state.x_article).toEqual({ title: 'T', preview: 'P', body: 'B', quoted: true });
  });

  it('leaves out a link whose title, description and body are all unknown', () => {
    // Only that a link EXISTS is known - which says nothing about the content's
    // value, and the model cannot open it.
    const state = buildRankState(
      content({
        linkedArticle: {
          kind: 'external-article',
          url: 'https://t.co/abc',
          title: null,
          description: null,
          body: null,
        },
      }),
    );
    expect(state.linked_article).toBeUndefined();
  });

  it('collapses whitespace and caps each part, so one long article cannot blow the state budget', () => {
    const state = buildRankState(
      content({
        post: { kind: 'post', authorUsername: 'a', authorName: 'A', text: `x\n\n  y${'z'.repeat(5000)}` },
        linkedArticle: {
          kind: 'external-article',
          url: 'https://example.com/a',
          title: 'T',
          description: null,
          body: 'b'.repeat(50000),
        },
      }),
    );

    const post = state.post as { text: string };
    expect(post.text.startsWith('x y')).toBe(true);
    expect(post.text.length).toBe(STATE_LIMITS.postText);
    expect((state.linked_article as { body: string }).body.length).toBe(STATE_LIMITS.articleBody);
  });
});

describe('hasRankableContent', () => {
  it('accepts a post with prose of its own', () => {
    expect(hasRankableContent(buildRankState(content()))).toBe(true);
  });

  it('rejects a post that is nothing but an opaque link, so no money is spent judging an absence', () => {
    const state = buildRankState(
      content({ post: { kind: 'post', authorUsername: 'a', authorName: 'A', text: 'https://t.co/abc' } }),
    );
    expect(hasRankableContent(state)).toBe(false);
  });

  it('accepts a link-only post once the link resolved to readable content', () => {
    const state = buildRankState(
      content({
        post: { kind: 'post', authorUsername: 'a', authorName: 'A', text: 'https://t.co/abc' },
        linkedArticle: {
          kind: 'external-article',
          url: 'https://example.com/a',
          title: 'A real article',
          description: null,
          body: null,
        },
      }),
    );
    expect(hasRankableContent(state)).toBe(true);
  });
});
