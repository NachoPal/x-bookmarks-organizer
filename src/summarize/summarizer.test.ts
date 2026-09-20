import { describe, it, expect } from 'vitest';
import type { LlmRunner } from '../categorize/llm';
import {
  LlmSummaryGenerator,
  buildSummaryPrompt,
  hasSummarizableContent,
  htmlToPlainText,
  postProse,
} from './summarizer';

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

describe('postProse', () => {
  it('drops the t.co links X leaves in post text, keeping the prose', () => {
    expect(postProse('Great read on evals https://t.co/aBcD1234Xy')).toBe('Great read on evals');
  });

  it('returns empty for a post that is nothing but a link', () => {
    expect(postProse('https://t.co/aBcD1234Xy')).toBe('');
    expect(postProse('  https://t.co/aBcD1234Xy https://t.co/zZ9 ')).toBe('');
  });
});

describe('hasSummarizableContent', () => {
  const base = { authorName: 'Ada', authorUsername: 'ada' };

  it('is false for a link-only post with no readable article (the refusal case)', () => {
    expect(hasSummarizableContent({ ...base, postText: 'https://t.co/aBcD1234Xy' })).toBe(false);
    expect(
      hasSummarizableContent({
        ...base,
        postText: 'https://t.co/aBcD1234Xy',
        articleTitle: null,
        articleDescription: null,
        articleText: null,
      }),
    ).toBe(false);
  });

  it('is true whenever the post has prose of its own, link or not', () => {
    expect(
      hasSummarizableContent({ ...base, postText: 'Worth reading https://t.co/aBcD1234Xy' }),
    ).toBe(true);
  });

  it('is true for a link-only post whose link yielded only a preview card (issue #45)', () => {
    expect(
      hasSummarizableContent({
        postText: 'https://t.co/aBcD1234Xy',
        authorName: 'Ada',
        authorUsername: 'ada',
        articleTitle: 'A Tool, Not An Article',
        articleDescription: 'One place every agent plugs in.',
      }),
    ).toBe(true);
  });

  it('is true when the link yielded article text, or only its cached metadata', () => {
    const linkOnly = { ...base, postText: 'https://t.co/aBcD1234Xy' };
    expect(hasSummarizableContent({ ...linkOnly, articleText: 'The body.' })).toBe(true);
    expect(hasSummarizableContent({ ...linkOnly, articleTitle: 'A Great Read' })).toBe(true);
    expect(hasSummarizableContent({ ...linkOnly, articleDescription: 'What it covers.' })).toBe(
      true,
    );
  });

  it('treats whitespace-only content as nothing to summarize', () => {
    expect(
      hasSummarizableContent({
        ...base,
        postText: '   https://t.co/aBcD1234Xy  ',
        articleTitle: '  ',
        articleText: '   ',
      }),
    ).toBe(false);
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

  it('carries the prose, not the bare t.co link, as the post body', () => {
    const prompt = buildSummaryPrompt({
      postText: 'Worth reading https://t.co/aBcD1234Xy',
      authorName: 'Ada',
      authorUsername: 'ada',
    });
    expect(prompt).toContain('Worth reading');
    // The model has no tools to fetch a URL, so one must never be the subject.
    expect(prompt).not.toContain('https://t.co/aBcD1234Xy');
  });

  it('falls back to the link metadata when only the title/description was cached', () => {
    const prompt = buildSummaryPrompt({
      postText: 'https://t.co/aBcD1234Xy',
      authorName: 'Ada',
      authorUsername: 'ada',
      articleTitle: 'Why Evals Beat Vibes',
      articleDescription: 'A case for treating prompt edits like code edits.',
    });
    expect(prompt).toContain('Title: Why Evals Beat Vibes');
    expect(prompt).toContain('Description: A case for treating prompt edits like code edits.');
    expect(prompt).not.toContain('https://t.co/aBcD1234Xy');
  });

  it('summarizes a link-only post from the preview card alone, with its site (issue #45)', () => {
    const prompt = buildSummaryPrompt({
      postText: 'https://t.co/aBcD1234Xy',
      authorName: 'Ada',
      authorUsername: 'ada',
      articleTitle: 'A Tool, Not An Article',
      articleDescription: 'One place every agent plugs into every tool you already use.',
      articleSiteName: 'tool.example.com',
    });
    expect(prompt).toContain('Title: A Tool, Not An Article');
    expect(prompt).toContain('One place every agent plugs into');
    expect(prompt).toContain('Site: tool.example.com');
    // It is a page, not necessarily an article - the prompt must not claim more.
    expect(prompt).toContain('links a page');
  });

  it('asks for well-structured Markdown, not the old plain-prose-only instruction', () => {
    const prompt = buildSummaryPrompt({
      postText: 'Check this out',
      authorName: 'Ada',
      authorUsername: 'ada',
    });
    expect(prompt).toContain('Markdown');
    expect(prompt).toContain('bullet list');
    expect(prompt).toContain('LEARN');
    expect(prompt).toContain('Key insights / takeaways');
    expect(prompt).toContain('**bold**');
    expect(prompt).not.toContain('Write plain prose');
    expect(prompt).not.toContain('no headings or bullet points');
  });
});

describe('LlmSummaryGenerator', () => {
  it('passes the built prompt to the runner and trims the response', async () => {
    let seenPrompt = '';
    const runner: LlmRunner = async (prompt) => {
      seenPrompt = prompt;
      return '  A concise summary.  \n';
    };
    const gen = new LlmSummaryGenerator(runner);
    const result = await gen.summarize({ postText: 'hi', authorName: 'A', authorUsername: 'a' });
    expect(result).toBe('A concise summary.');
    expect(seenPrompt).toContain('Post by @a (A)');
  });

  it('throws when the model returns an empty response', async () => {
    const runner: LlmRunner = async () => '   ';
    const gen = new LlmSummaryGenerator(runner);
    await expect(gen.summarize({ postText: 'hi', authorName: '', authorUsername: 'a' })).rejects.toThrow(
      /empty summary/i,
    );
  });
});
