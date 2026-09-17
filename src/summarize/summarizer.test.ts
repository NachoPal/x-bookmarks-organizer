import { describe, it, expect } from 'vitest';
import type { LlmRunner } from '../categorize/llm';
import { ClaudeSummaryGenerator, buildSummaryPrompt, htmlToPlainText } from './summarizer';

describe('htmlToPlainText', () => {
  it('strips tags and decodes common entities', () => {
    const html = '<p>Hello <strong>world</strong> &amp; friends &nbsp;here.</p>';
    expect(htmlToPlainText(html)).toBe('Hello world & friends here.');
  });

  it('drops script/style contents entirely', () => {
    const html = '<style>.x{color:red}</style><p>Text</p><script>alert(1)</script>';
    expect(htmlToPlainText(html)).toBe('Text');
  });
});

describe('buildSummaryPrompt', () => {
  it('includes the post text and author', () => {
    const prompt = buildSummaryPrompt({
      postText: 'Check this out',
      authorName: 'Ada',
      authorUsername: 'ada',
    });
    expect(prompt).toContain('@ada (Ada)');
    expect(prompt).toContain('Check this out');
    expect(prompt).not.toContain('Linked article');
  });

  it('includes the article title and body when present', () => {
    const prompt = buildSummaryPrompt({
      postText: 'Read this',
      authorName: '',
      authorUsername: 'bob',
      articleTitle: 'A Great Read',
      articleText: 'The article body.',
    });
    expect(prompt).toContain('Linked article - "A Great Read"');
    expect(prompt).toContain('The article body.');
  });
});

describe('ClaudeSummaryGenerator', () => {
  it('passes the built prompt to the runner and trims the response', async () => {
    let seenPrompt = '';
    const runner: LlmRunner = async (prompt) => {
      seenPrompt = prompt;
      return '  A concise summary.  \n';
    };
    const gen = new ClaudeSummaryGenerator(runner);
    const result = await gen.summarize({ postText: 'hi', authorName: 'A', authorUsername: 'a' });
    expect(result).toBe('A concise summary.');
    expect(seenPrompt).toContain('Post by @a (A)');
  });

  it('throws when the model returns an empty response', async () => {
    const runner: LlmRunner = async () => '   ';
    const gen = new ClaudeSummaryGenerator(runner);
    await expect(gen.summarize({ postText: 'hi', authorName: '', authorUsername: 'a' })).rejects.toThrow(
      /empty summary/i,
    );
  });
});
