/**
 * Turn a bookmark's assembled content into the JSON `state` Jev scores against
 * (issue #62).
 *
 * `BookmarkContent` (`src/content/bookmark-content.ts`) was built for exactly
 * this: named, self-describing parts so a scoring model never has to guess what
 * a span of text represents. Jev accepts a JSON object as state, so the mapping
 * is close to the identity - this file only trims whitespace, drops absent
 * parts, and caps each part's length.
 *
 * Pure: no database, no clock, and no SDK at runtime - the one SDK import is a
 * type, erased at compile time, so the state's shape is checked against what
 * the API actually accepts.
 */
import type { JsonValue } from '@typesafe-ai/sdk';
import type { BookmarkContent } from '../content/bookmark-content';

/**
 * Per-part character budgets. Jev allows 32k tokens for the state plus the
 * longest question; these keep even a bookmark carrying a full long-form article
 * an order of magnitude inside that, and they matter for cost too, since
 * TypeSafe bills input tokens. An article's opening is where its substance
 * announces itself, so truncating the tail costs the rubric very little.
 */
export const STATE_LIMITS = {
  postText: 2000,
  quotedText: 2000,
  articleTitle: 300,
  articleDescription: 600,
  articleBody: 6000,
} as const;

function trim(value: string | null | undefined, limit: number): string | undefined {
  const collapsed = value?.replace(/\s+/g, ' ').trim();
  if (!collapsed) return undefined;
  return collapsed.slice(0, limit);
}

/**
 * The state for one bookmark. Every key is omitted when the bookmark has
 * nothing for it, so the model is never handed an empty `linked_article` to
 * reason about; `post` is always present, since a bookmark always has one.
 */
export interface RankState {
  [key: string]: JsonValue;
}

export function buildRankState(content: BookmarkContent): RankState {
  const state: RankState = {
    post: {
      author: `@${content.post.authorUsername}`,
      text: trim(content.post.text, STATE_LIMITS.postText) ?? '',
    },
  };

  if (content.quotedPost) {
    const text = trim(content.quotedPost.text, STATE_LIMITS.quotedText);
    if (text) {
      state.quoted_post = { author: `@${content.quotedPost.authorUsername}`, text };
    }
  }

  if (content.linkedArticle) {
    const article: Record<string, JsonValue> = {};
    const title = trim(content.linkedArticle.title, STATE_LIMITS.articleTitle);
    const description = trim(content.linkedArticle.description, STATE_LIMITS.articleDescription);
    const body = trim(content.linkedArticle.body, STATE_LIMITS.articleBody);
    if (title) article.title = title;
    if (description) article.description = description;
    if (body) article.body = body;
    // A link with no readable title, description or body says nothing about the
    // content's value - only that a link exists - so it is left out entirely
    // rather than sent as a bare URL the model cannot open.
    if (Object.keys(article).length > 0) state.linked_article = article;
  }

  if (content.xArticle) {
    const article: Record<string, JsonValue> = {};
    const title = trim(content.xArticle.title, STATE_LIMITS.articleTitle);
    const preview = trim(content.xArticle.previewText, STATE_LIMITS.articleDescription);
    const body = trim(content.xArticle.body, STATE_LIMITS.articleBody);
    if (title) article.title = title;
    if (preview) article.preview = preview;
    if (body) article.body = body;
    if (Object.keys(article).length > 0) {
      article.quoted = content.xArticle.quoted;
      state.x_article = article;
    }
  }

  return state;
}

/**
 * Whether there is enough here to score at all.
 *
 * A bookmark whose post is only an opaque `t.co` link, with no readable article
 * behind it, holds nothing a model could judge - exactly the situation
 * `hasSummarizableContent` guards the summary endpoint against. Scoring it
 * anyway would spend money to score the absence of content, so the ranker skips
 * it and says so.
 */
export function hasRankableContent(state: RankState): boolean {
  if (state.quoted_post || state.linked_article || state.x_article) return true;
  const post = state.post as { text?: string } | undefined;
  const text = post?.text ?? '';
  // Strip the t.co URLs X leaves in every post's text before asking whether
  // there is any prose left (the same reasoning as `postProse` in the summarizer).
  return text.replace(/https?:\/\/\S+/g, ' ').replace(/\s+/g, ' ').trim().length > 0;
}
