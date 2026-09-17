import { describe, it, expect } from 'vitest';
import { extractArticleLink } from './extract-link';

describe('extractArticleLink', () => {
  it('returns null when the text has no URL', () => {
    expect(extractArticleLink('Just a short note. Nothing to see here.')).toBeNull();
  });

  it('returns the first URL found in the text', () => {
    const text = 'Great read on this topic https://example.com/articles/one and also https://example.com/two';
    expect(extractArticleLink(text)).toBe('https://example.com/articles/one');
  });

  it('trims trailing sentence punctuation attached to the URL', () => {
    expect(extractArticleLink('Check this out: https://example.com/post.')).toBe(
      'https://example.com/post',
    );
    expect(extractArticleLink('Worth a read (https://example.com/post).')).toBe(
      'https://example.com/post',
    );
  });

  it('extracts a t.co shortened link as-is (resolution happens at fetch time)', () => {
    expect(extractArticleLink('New post: https://t.co/abc123XYZ')).toBe('https://t.co/abc123XYZ');
  });

  it('ignores bare mentions and hashtags that are not URLs', () => {
    expect(extractArticleLink('cc @someone #announcement no links here')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(extractArticleLink('')).toBeNull();
  });
});
