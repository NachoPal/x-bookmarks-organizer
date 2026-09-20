import type { LlmRunner } from '../categorize/llm';

/** Cap on how much article text is sent to the model, to keep the call bounded. */
const MAX_ARTICLE_CHARS = 6000;

/** What a bookmark's content looks like once assembled for summarization. */
export interface SummaryInput {
  postText: string;
  authorName: string;
  authorUsername: string;
  /**
   * The linked page's title - the reader-view extraction's when the body was
   * readable, otherwise the preview card's (issue #45), which is what most
   * links have.
   */
  articleTitle?: string | null;
  /**
   * The linked page's short description/excerpt, when only its metadata (not
   * its body) could be retrieved - see the ingest-time link-metadata cache.
   */
  articleDescription?: string | null;
  /** The linked page's site name or domain, when known - e.g. `github.com`. */
  articleSiteName?: string | null;
  /** Plain-text article body, when the bookmark's link is a readable article. */
  articleText?: string | null;
}

/**
 * What the owner is told when a bookmark has nothing a model could summarize.
 * Shown instead of asking the model to summarize a URL it cannot open - which
 * only ever produces a confused "paste the text and I'll summarize it" refusal.
 */
export const NOTHING_TO_SUMMARIZE_MESSAGE =
  "Nothing to summarize: this bookmark links content that couldn't be read (it may be a video, " +
  'image, or a page that blocks fetching), and the post itself has no text.';

/**
 * Generates a summary for a bookmark's content. Abstracted so a provider-backed
 * runner can be swapped for a fake in tests (no network, no subscription
 * usage) - mirrors the {@link import('../categorize/llm').BatchCategorizer} seam.
 */
export interface SummaryGenerator {
  summarize(input: SummaryInput): Promise<string>;
}

/**
 * Strip tags from the reader view's sanitized article HTML to get plain text
 * for the prompt. Safe against arbitrary markup because the input has already
 * passed through `sanitize-html` (see `src/articles/fetch-article.ts`) - this
 * is a prompt-building convenience, not a security boundary.
 */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Matches the URL tokens X leaves in a post's stored text (all of them t.co-shortened). */
const URL_TOKEN = /https?:\/\/\S+/gi;

/**
 * The post's own prose: its stored text with bare URL tokens removed. X
 * shortens every link to an opaque `t.co` URL that carries no meaning on its
 * own, so this is what separates a post that merely *contains* a link (still
 * summarizable from its prose) from one that is *only* a link (not
 * summarizable without the link's content).
 */
export function postProse(text: string): string {
  return text.replace(URL_TOKEN, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Whether this input holds anything a model could summarize without opening a
 * URL itself. The CLI adapter runs hardened with `--tools ""` (no web fetch),
 * by design, so a prompt whose only content is a link cannot be answered and
 * comes back as a refusal; callers must check this BEFORE spending a call.
 */
export function hasSummarizableContent(input: SummaryInput): boolean {
  if (input.articleText?.trim()) return true;
  if (input.articleTitle?.trim()) return true;
  if (input.articleDescription?.trim()) return true;
  return postProse(input.postText).length > 0;
}

/**
 * Build the prompt sent to the LLM: the post's prose, plus the linked
 * article's body when it could be read, or just its title/description when
 * only that much was cached. The prompt never carries a bare URL as its
 * subject - the model has no tools to fetch one.
 */
export function buildSummaryPrompt(input: SummaryInput): string {
  const prose = postProse(input.postText);
  const lines = [
    'You are helping the owner LEARN from a post they bookmarked. This app is a learning tool - they save posts and articles to extract insights, not to skim a recap. Produce a summary that surfaces the useful substance and the takeaways worth remembering.',
    'Write clean Markdown: a short lead (what this is and its core point, a sentence or two); then **Key insights / takeaways** as a tight bullet list - the specific ideas, arguments, principles, techniques, lessons, or notable facts/numbers worth remembering and applying. Be concrete (name the actual claims, steps and data), not vague. Use **bold** on genuinely important terms, sparingly. No preamble like "This post is about". Structure only where it aids clarity: a truly trivial one-line post deserves a single plain sentence, not a bulleted insight skeleton.',
    "When a linked article is present, go deeper: capture the article's core argument AND the concrete lessons/principles it offers - the article is the real substance, so summarize it more thoroughly than the post's framing of it.",
    'Favor genuine usefulness over brevity - a rich post or article deserves a fuller, insight-dense summary. Do not pad or restate the obvious.',
    'Everything available is quoted below. You cannot open links and must not ask for more content - use only what is here.',
    '',
    `Post by @${input.authorUsername}${input.authorName ? ` (${input.authorName})` : ''}:`,
    prose || '(no text beyond a link)',
  ];
  if (input.articleText) {
    lines.push(
      '',
      `Linked article${input.articleTitle ? ` - "${input.articleTitle}"` : ''}:`,
      input.articleText.slice(0, MAX_ARTICLE_CHARS),
      '',
      "The article is the substance being shared, so summarize its content, not just the post's framing of it.",
    );
  } else if (input.articleTitle || input.articleDescription) {
    // Only the link's preview card was cached (no readable body) - the common
    // case for a tool, repo, product page or video. It is thin, but it is
    // real content, and far better than giving up on a link-only post.
    lines.push(
      '',
      "The post links a page whose full text could not be retrieved. Here is its preview card, which is all that is known about it:",
      ...(input.articleTitle ? [`Title: ${input.articleTitle}`] : []),
      ...(input.articleDescription ? [`Description: ${input.articleDescription}`] : []),
      ...(input.articleSiteName ? [`Site: ${input.articleSiteName}`] : []),
      '',
      'Summarize what is being shared based on the post and that card, and do not speculate beyond them.',
    );
  }
  return lines.join('\n');
}

/** Runs the summary prompt through an injected {@link LlmRunner}. */
export class LlmSummaryGenerator implements SummaryGenerator {
  constructor(private readonly runner: LlmRunner) {}

  async summarize(input: SummaryInput): Promise<string> {
    const prompt = buildSummaryPrompt(input);
    const response = await this.runner(prompt);
    const text = response.trim();
    if (!text) throw new Error('The model returned an empty summary.');
    return text;
  }
}
