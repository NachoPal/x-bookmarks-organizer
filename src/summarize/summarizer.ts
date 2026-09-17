import type { LlmRunner } from '../categorize/llm';

/** Cap on how much article text is sent to the model, to keep the (Haiku-class) call cheap. */
const MAX_ARTICLE_CHARS = 6000;

/** What a bookmark's content looks like once assembled for summarization. */
export interface SummaryInput {
  postText: string;
  authorName: string;
  authorUsername: string;
  /** The reader-view extraction's title, when the bookmark's link is an article. */
  articleTitle?: string | null;
  /** Plain-text article body, when the bookmark's link is an article. */
  articleText?: string | null;
}

/**
 * Generates a summary for a bookmark's content. Abstracted so the real
 * `claude` CLI runner can be swapped for a fake in tests (no network, no
 * subscription usage) - mirrors the {@link import('../categorize/llm').BatchCategorizer} seam.
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

/** Build the prompt sent to the LLM: the post, plus the article body when available. */
export function buildSummaryPrompt(input: SummaryInput): string {
  const lines = [
    "Summarize this bookmarked X post so its owner can grasp it without reading it in full.",
    'Write 2-4 concise sentences of plain prose - no headings, no bullet points, no preamble like "This post is about".',
    '',
    `Post by @${input.authorUsername}${input.authorName ? ` (${input.authorName})` : ''}:`,
    input.postText.trim() || '(no text)',
  ];
  if (input.articleText) {
    lines.push(
      '',
      `Linked article${input.articleTitle ? ` - "${input.articleTitle}"` : ''}:`,
      input.articleText.slice(0, MAX_ARTICLE_CHARS),
      '',
      "The article is the substance being shared, so summarize its content, not just the post's framing of it.",
    );
  }
  return lines.join('\n');
}

/** Runs the summary prompt through an injected {@link LlmRunner}. */
export class ClaudeSummaryGenerator implements SummaryGenerator {
  constructor(private readonly runner: LlmRunner) {}

  async summarize(input: SummaryInput): Promise<string> {
    const prompt = buildSummaryPrompt(input);
    const response = await this.runner(prompt);
    const text = response.trim();
    if (!text) throw new Error('The model returned an empty summary.');
    return text;
  }
}
